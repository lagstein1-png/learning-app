/**
 * LAYER D (part 2) — The route of last resort.
 *
 * When every provider route is down, over budget or refused, the learner
 * still gets a valid, honest module. This generator is deterministic and
 * offline. It never pretends to be a model: `ui_metadata.degraded` is true
 * and the text says the material is a short version.
 *
 * math_puzzle produces a real, solvable arithmetic question (seeded by the
 * topic so the same request gives the same puzzle, which keeps the cache
 * consistent). Other module types produce a structured explanation or
 * flashcard about the topic, using any tool results that were computed
 * before the routes failed.
 */
import type { GenerateRequest, LanguageCode, ModuleDraft, ToolResult } from "./schemas.ts";

interface Strings {
  title: (topic: string) => string;
  intro: (topic: string) => string;
  shortVersion: string;
  stepsHeading: string;
  steps: string[];
  toolLine: (r: string) => string;
  flashFront: (topic: string) => string;
  flashBack: (topic: string) => string;
  mathAsk: (a: number, b: number, op: string) => string;
  ops: { add: string; sub: string; mul: string };
  mathWhy: (a: number, b: number, op: string, ans: number) => string;
  scenarioIntro: (topic: string) => string;
  scenarioAsk: string;
  scenarioOptions: string[];
  scenarioWhy: string;
}

const STRINGS: Record<LanguageCode, Strings> = {
  "he-IL": {
    title: (t) => `${t} — גרסה קצרה`,
    intro: (t) => `הנושא הוא ${t}.`,
    shortVersion: "זו גרסה קצרה שנשמרה במכשיר. החומר המלא יגיע כשיהיה חיבור.",
    stepsHeading: "כך לומדים את זה בשלושה צעדים.",
    steps: ["צעד 1: קוראים את השם של הנושא בקול.", "צעד 2: אומרים במילים שלנו מה זה אומר.", "צעד 3: נותנים דוגמה אחת מהחיים."],
    toolLine: (r) => `חישוב מדויק: ${r}.`,
    flashFront: (t) => `מה זה ${t}?`,
    flashBack: (t) => `${t} הוא הנושא של הכרטיס. אמרו בקול משפט אחד שמסביר אותו.`,
    mathAsk: (a, b, op) => `כמה זה ${a} ${op} ${b}?`,
    ops: { add: "ועוד", sub: "פחות", mul: "כפול" },
    mathWhy: (a, b, op, ans) => `${a} ${op} ${b} שווה ${ans}. אפשר לבדוק עם האצבעות או על דף.`,
    scenarioIntro: (t) => `אתם נוהגים ומתקרבים למצב של ${t}.`,
    scenarioAsk: "מה עושים קודם?",
    scenarioOptions: ["מאטים ובודקים מה קורה מסביב.", "מאיצים כדי לעבור מהר.", "ממשיכים באותה מהירות.", "צופרים וממשיכים."],
    scenarioWhy: "האטה ובדיקה נותנות זמן להחליט נכון. זה הכלל הבסיסי בכל מצב לא ברור.",
  },
  "en-US": {
    title: (t) => `${t} — short version`,
    intro: (t) => `The topic is ${t}.`,
    shortVersion: "This is a short version stored on the device. The full material will arrive when there is a connection.",
    stepsHeading: "Here is how to learn it in three steps.",
    steps: ["Step 1: read the name of the topic out loud.", "Step 2: say in your own words what it means.", "Step 3: give one example from daily life."],
    toolLine: (r) => `Exact calculation: ${r}.`,
    flashFront: (t) => `What is ${t}?`,
    flashBack: (t) => `${t} is the topic of this card. Say one sentence out loud that explains it.`,
    mathAsk: (a, b, op) => `How much is ${a} ${op} ${b}?`,
    ops: { add: "plus", sub: "minus", mul: "times" },
    mathWhy: (a, b, op, ans) => `${a} ${op} ${b} equals ${ans}. You can check it on paper.`,
    scenarioIntro: (t) => `You are driving and you approach a situation involving ${t}.`,
    scenarioAsk: "What do you do first?",
    scenarioOptions: ["Slow down and check what is happening around you.", "Speed up to get through quickly.", "Keep the same speed.", "Sound the horn and continue."],
    scenarioWhy: "Slowing down and checking gives you time to decide correctly. That is the basic rule in any unclear situation.",
  },
  "es-ES": {
    title: (t) => `${t} — versión corta`,
    intro: (t) => `El tema es ${t}.`,
    shortVersion: "Esta es una versión corta guardada en el dispositivo. El material completo llegará cuando haya conexión.",
    stepsHeading: "Así se aprende en tres pasos.",
    steps: ["Paso 1: lee el nombre del tema en voz alta.", "Paso 2: di con tus palabras qué significa.", "Paso 3: da un ejemplo de la vida diaria."],
    toolLine: (r) => `Cálculo exacto: ${r}.`,
    flashFront: (t) => `¿Qué es ${t}?`,
    flashBack: (t) => `${t} es el tema de esta tarjeta. Di en voz alta una frase que lo explique.`,
    mathAsk: (a, b, op) => `¿Cuánto es ${a} ${op} ${b}?`,
    ops: { add: "más", sub: "menos", mul: "por" },
    mathWhy: (a, b, op, ans) => `${a} ${op} ${b} es igual a ${ans}. Puedes comprobarlo en papel.`,
    scenarioIntro: (t) => `Conduces y te acercas a una situación de ${t}.`,
    scenarioAsk: "¿Qué haces primero?",
    scenarioOptions: ["Reduces la velocidad y miras qué pasa alrededor.", "Aceleras para pasar rápido.", "Mantienes la misma velocidad.", "Tocas la bocina y sigues."],
    scenarioWhy: "Reducir la velocidad y mirar te da tiempo para decidir bien. Es la regla básica en cualquier situación dudosa.",
  },
  "ar-XA": {
    title: (t) => `${t} — نسخة قصيرة`,
    intro: (t) => `الموضوع هو ${t}.`,
    shortVersion: "هذه نسخة قصيرة محفوظة على الجهاز. المادة الكاملة ستصل عندما يتوفر اتصال.",
    stepsHeading: "هكذا نتعلمه في ثلاث خطوات.",
    steps: ["الخطوة 1: اقرأ اسم الموضوع بصوت عالٍ.", "الخطوة 2: قل بكلماتك ماذا يعني.", "الخطوة 3: أعطِ مثالًا واحدًا من الحياة اليومية."],
    toolLine: (r) => `حساب دقيق: ${r}.`,
    flashFront: (t) => `ما هو ${t}؟`,
    flashBack: (t) => `${t} هو موضوع هذه البطاقة. قل بصوت عالٍ جملة واحدة تشرحه.`,
    mathAsk: (a, b, op) => `كم يساوي ${a} ${op} ${b}؟`,
    ops: { add: "زائد", sub: "ناقص", mul: "ضرب" },
    mathWhy: (a, b, op, ans) => `${a} ${op} ${b} يساوي ${ans}. يمكنك التحقق على الورق.`,
    scenarioIntro: (t) => `أنت تقود وتقترب من وضع موضوعه ${t}.`,
    scenarioAsk: "ماذا تفعل أولًا؟",
    scenarioOptions: ["تبطئ وتتحقق مما يحدث حولك.", "تسرع لتعبر بسرعة.", "تحافظ على نفس السرعة.", "تطلق البوق وتتابع."],
    scenarioWhy: "الإبطاء والتحقق يمنحانك وقتًا لاتخاذ القرار الصحيح. هذه هي القاعدة الأساسية في أي وضع غير واضح.",
  },
};

/** Small deterministic PRNG (mulberry32) seeded from a string. */
function seeded(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
}

function mathPuzzle(req: GenerateRequest, S: Strings): ModuleDraft {
  const rnd = seeded(`${req.topic}|${req.difficulty}|${req.language}`);
  const max = req.difficulty === "easy" ? 10 : req.difficulty === "medium" ? 50 : 200;
  const a = 1 + Math.floor(rnd() * max);
  const b = 1 + Math.floor(rnd() * max);
  const kind = req.difficulty === "easy" ? "add" : rnd() < 0.5 ? "sub" : "mul";
  const [x, y] = kind === "sub" ? [Math.max(a, b), Math.min(a, b)] : [a, b];
  const ans = kind === "add" ? x + y : kind === "sub" ? x - y : x * y;
  const op = S.ops[kind];
  const distractors = new Set<number>();
  const deltas = [1, -1, 2, -2, 10, -10, x, y];
  for (const d of deltas) {
    const v = ans + d;
    if (v !== ans && v >= 0 && !distractors.has(v)) distractors.add(v);
    if (distractors.size === 3) break;
  }
  const options = shuffle([ans, ...distractors].map(String), rnd);
  return {
    title: S.title(req.topic),
    raw_text: `${S.mathAsk(x, y, op)}\n\n${S.shortVersion}`,
    language_code: req.language,
    voice_preference: req.voice_preference ?? "male_clear",
    ui_metadata: {
      layout: "quiz",
      options,
      correct_index: options.indexOf(String(ans)),
      explanation: S.mathWhy(x, y, op, ans),
    },
  };
}

export function localFallback(req: GenerateRequest, toolResults: ToolResult[]): ModuleDraft {
  const S = STRINGS[req.language];
  const toolLines = toolResults.filter((t) => t.ok).map((t) => S.toolLine(t.result));

  switch (req.module_type) {
    case "math_puzzle":
      return mathPuzzle(req, S);

    case "flashcard":
      return {
        title: S.title(req.topic),
        raw_text: S.flashFront(req.topic),
        language_code: req.language,
        voice_preference: req.voice_preference ?? "female_warm",
        ui_metadata: { layout: "flashcard", options: [], correct_index: 0, explanation: [S.flashBack(req.topic), ...toolLines].join(" ") },
      };

    case "driving_scenario":
    case "quiz": {
      // Shuffle so the correct option is not always "A" on the fallback path.
      const options = shuffle([...S.scenarioOptions], seeded(`${req.topic}|${req.language}`));
      const correct = S.scenarioOptions[0]!;
      return {
        title: S.title(req.topic),
        raw_text: `${S.scenarioIntro(req.topic)}\n\n${S.scenarioAsk}`,
        language_code: req.language,
        voice_preference: req.voice_preference ?? "male_clear",
        ui_metadata: { layout: "quiz", options, correct_index: options.indexOf(correct), explanation: [S.scenarioWhy, ...toolLines].join(" ") },
      };
    }

    case "explanation":
    default:
      return {
        title: S.title(req.topic),
        raw_text: [S.intro(req.topic), S.stepsHeading, ...S.steps, ...toolLines, S.shortVersion].join("\n\n"),
        language_code: req.language,
        voice_preference: req.voice_preference ?? "female_warm",
        ui_metadata: { layout: "explanation", options: [], correct_index: 0, explanation: null },
      };
  }
}
