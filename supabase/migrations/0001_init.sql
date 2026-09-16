-- Learning-app TTS backend — initial schema.
--
-- Four tables:
--   phonetic_overrides        pronunciation dictionary (global rows + per-learner rows)
--   accessibility_preferences per-learner voice, cadence, mood and chunking preferences
--   audio_cache               synthesised MP3 keyed by (language, voice, prosody, chunk text)
--   tts_requests              one row per /process-text call, for diagnostics
--
-- The backend connects with the service-role key; RLS is enabled so the anon
-- and authenticated roles (which no client should hold for this project) see
-- nothing. Mirror any change here in src/services/supabase.ts.

create extension if not exists pgcrypto;

-- ── enums ───────────────────────────────────────────────────────────────
do $$ begin
  create type tts_language as enum ('he', 'en', 'ar', 'ru');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tts_gender as enum ('female', 'male');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tts_cadence as enum ('slow', 'relaxed', 'natural', 'brisk');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tts_mood as enum ('neutral', 'warm', 'encouraging', 'calm', 'serious', 'cheerful');
exception when duplicate_object then null; end $$;

do $$ begin
  create type tts_provider as enum ('azure', 'google');
exception when duplicate_object then null; end $$;

-- ── phonetic_overrides ──────────────────────────────────────────────────
create table if not exists public.phonetic_overrides (
  id          uuid primary key default gen_random_uuid(),
  language    tts_language not null,
  term        text not null check (length(term) between 1 and 120),
  term_key    text generated always as (lower(term)) stored,
  spoken_form text not null check (length(spoken_form) between 1 and 400),
  ipa         text check (ipa is null or length(ipa) <= 200),
  user_id     text check (user_id is null or user_id ~ '^[A-Za-z0-9_\-:.@]{1,128}$'),
  domain      text check (domain is null or length(domain) <= 64),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- One row per (language, term, scope); global rows use the empty-string scope.
create unique index if not exists phonetic_overrides_scope_idx
  on public.phonetic_overrides (language, term_key, coalesce(user_id, ''));

create index if not exists phonetic_overrides_lookup_idx
  on public.phonetic_overrides (language, user_id);

-- ── accessibility_preferences ───────────────────────────────────────────
create table if not exists public.accessibility_preferences (
  user_id           text primary key check (user_id ~ '^[A-Za-z0-9_\-:.@]{1,128}$'),
  language          tts_language not null default 'he',
  gender            tts_gender   not null default 'female',
  cadence           tts_cadence  not null default 'relaxed',
  mood              tts_mood     not null default 'warm',
  max_chunk_chars   integer      not null default 320 check (max_chunk_chars between 80 and 600),
  word_highlighting boolean      not null default true,
  updated_at        timestamptz  not null default now()
);

-- ── audio_cache ─────────────────────────────────────────────────────────
create table if not exists public.audio_cache (
  cache_key    text primary key check (cache_key ~ '^[0-9a-f]{32}$'),
  provider     tts_provider not null,
  voice_id     text not null,
  format       text not null check (format in ('mp3', 'ogg', 'wav')),
  language     tts_language not null,
  audio_base64 text not null,
  bytes        integer not null check (bytes > 0 and bytes <= 2097152),
  created_at   timestamptz not null default now(),
  expires_at   timestamptz,
  hits         integer not null default 0
);

create index if not exists audio_cache_expires_idx on public.audio_cache (expires_at);

-- Housekeeping: call from a scheduled job (pg_cron) or the Supabase dashboard.
create or replace function public.purge_expired_audio_cache()
returns integer
language plpgsql
as $$
declare removed integer;
begin
  delete from public.audio_cache where expires_at is not null and expires_at <= now();
  get diagnostics removed = row_count;
  return removed;
end;
$$;

-- ── tts_requests ────────────────────────────────────────────────────────
create table if not exists public.tts_requests (
  id                uuid primary key default gen_random_uuid(),
  request_id        text not null,
  trace_id          text not null,
  user_id           text,
  language          tts_language not null,
  chars             integer not null,
  chunks            integer not null,
  preprocess_source text not null check (preprocess_source in ('gemini', 'rules')),
  voice_id          text not null,
  duration_ms       integer not null,
  created_at        timestamptz not null default now()
);

create index if not exists tts_requests_created_idx on public.tts_requests (created_at desc);
create index if not exists tts_requests_trace_idx on public.tts_requests (trace_id);

-- ── updated_at trigger ──────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists phonetic_overrides_updated_at on public.phonetic_overrides;
create trigger phonetic_overrides_updated_at
  before update on public.phonetic_overrides
  for each row execute function public.set_updated_at();

drop trigger if exists accessibility_preferences_updated_at on public.accessibility_preferences;
create trigger accessibility_preferences_updated_at
  before update on public.accessibility_preferences
  for each row execute function public.set_updated_at();

-- ── row level security: service role only ──────────────────────────────
alter table public.phonetic_overrides        enable row level security;
alter table public.accessibility_preferences enable row level security;
alter table public.audio_cache               enable row level security;
alter table public.tts_requests              enable row level security;

-- ── seed: global pronunciation overrides (mirrors src/config/seedDictionary.ts) ──
insert into public.phonetic_overrides (language, term, spoken_form, ipa, domain) values
  ('he', 'קמ"ש', 'קילומטר לשעה', null, 'driving-theory'),
  ('he', 'ק"מ', 'קילומטר', null, 'units'),
  ('he', 'ס"מ', 'סנטימטר', null, 'units'),
  ('he', 'מ"ר', 'מטר רבוע', null, 'units'),
  ('he', 'ק"ג', 'קילוגרם', null, 'units'),
  ('he', 'ד"ר', 'דוקטור', null, 'general'),
  ('he', 'בע"מ', 'בערבון מוגבל', null, 'general'),
  ('he', 'ת"א', 'תל אביב', null, 'general'),
  ('he', 'ADHD', 'איי די אייץ'' די', null, 'accessibility'),
  ('he', 'GPS', 'ג''י פי אס', null, 'driving-theory'),
  ('he', 'ABS', 'איי בי אס', null, 'driving-theory'),
  ('he', 'רמ"ז', 'רמזור', null, 'driving-theory'),
  ('ar', 'كم/س', 'كيلومتر في الساعة', null, 'driving-theory'),
  ('ar', 'كم', 'كيلومتر', null, 'units'),
  ('ar', 'د.', 'دكتور', null, 'general'),
  ('ar', 'إلخ', 'إلى آخره', null, 'general'),
  ('ar', 'ص.ب', 'صندوق بريد', null, 'general'),
  ('ar', 'GPS', 'جي بي إس', null, 'driving-theory'),
  ('ar', 'ADHD', 'إيه دي إتش دي', null, 'accessibility'),
  ('ru', 'км/ч', 'километров в час', null, 'driving-theory'),
  ('ru', 'км', 'километров', null, 'units'),
  ('ru', 'т.е.', 'то есть', null, 'general'),
  ('ru', 'т.д.', 'так далее', null, 'general'),
  ('ru', 'ПДД', 'правила дорожного движения', null, 'driving-theory'),
  ('ru', 'ГИБДД', 'ги-бэ-дэ-дэ', null, 'driving-theory'),
  ('ru', 'GPS', 'джи-пи-эс', null, 'driving-theory'),
  ('ru', 'СДВГ', 'синдром дефицита внимания и гиперактивности', null, 'accessibility'),
  ('en', 'km/h', 'kilometres per hour', null, 'driving-theory'),
  ('en', 'e.g.', 'for example', null, 'general'),
  ('en', 'i.e.', 'that is', null, 'general'),
  ('en', 'etc.', 'et cetera', null, 'general'),
  ('en', 'ADHD', 'A D H D', null, 'accessibility'),
  ('en', 'GPS', 'G P S', null, 'driving-theory'),
  ('en', 'ABS', 'A B S', null, 'driving-theory'),
  ('en', 'SSML', 'S S M L', null, 'general'),
  ('en', 'dyslexia', 'dyslexia', 'dɪsˈlɛksiə', 'accessibility')
on conflict (language, term_key, coalesce(user_id, '')) do update
  set spoken_form = excluded.spoken_form,
      ipa         = excluded.ipa,
      domain      = excluded.domain;
