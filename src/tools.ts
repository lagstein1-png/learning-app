/**
 * LAYER D (part 1) — Tools the model can invoke instead of guessing.
 *
 * Each tool is deterministic, has a Zod argument schema (schemas.ts) and
 * returns a short plain-text result that is fed back to the model. The
 * calculator is a hand-written recursive-descent parser: no eval, no Function.
 */
import { ToolArgSchemas, type ToolCall, type ToolName, type ToolResult } from "./schemas.ts";

// ---------------------------------------------------------------------------
// calculator
// ---------------------------------------------------------------------------

type Tok = { t: "num"; v: number } | { t: "op"; v: string } | { t: "id"; v: string } | { t: "("; } | { t: ")" } | { t: "," };

function tokenize(src: string): Tok[] {
  const s = src
    .replace(/×/g, "*")
    .replace(/(?<=[\d)]\s*)[xX](?=\s*[\d(])/g, "*") // "3 x 4", never the x in max()
    .replace(/[÷:]/g, "/")
    .replace(/−/g, "-")
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(/(\d+(?:\.\d+)?)\s*%/g, "($1/100)") // "25%" is a fraction, not modulo
    .replace(/\s+/g, "");
  const out: Tok[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i] ?? "";
    if (/\d|\./.test(c)) {
      const m = /^\d*\.?\d+(e[+-]?\d+)?/i.exec(s.slice(i));
      if (!m) throw new Error(`bad number at ${i}`);
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
    } else if (/[a-z]/i.test(c)) {
      const m = /^[a-z]+/i.exec(s.slice(i))!;
      out.push({ t: "id", v: m[0].toLowerCase() });
      i += m[0].length;
    } else if ("+-*/^%".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
    } else if (c === "(") { out.push({ t: "(" }); i++; }
    else if (c === ")") { out.push({ t: ")" }); i++; }
    else if (c === ",") { out.push({ t: "," }); i++; }
    else throw new Error(`unexpected character "${c}"`);
  }
  return out;
}

const FUNCS: Record<string, (...a: number[]) => number> = {
  sqrt: (a) => Math.sqrt(a),
  abs: (a) => Math.abs(a),
  round: (a, d = 0) => Math.round(a * 10 ** d) / 10 ** d,
  floor: (a) => Math.floor(a),
  ceil: (a) => Math.ceil(a),
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  pow: (a, b) => a ** b,
  log: (a) => Math.log10(a),
  ln: (a) => Math.log(a),
  sin: (a) => Math.sin(a),
  cos: (a) => Math.cos(a),
  tan: (a) => Math.tan(a),
};
const CONSTS: Record<string, number> = { pi: Math.PI, e: Math.E };

export function evaluateExpression(src: string): number {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t: Tok["t"]) => {
    const k = next();
    if (!k || k.t !== t) throw new Error(`expected ${t}`);
  };

  function expr(): number {
    let v = term();
    for (;;) {
      const k = peek();
      if (k && k.t === "op" && (k.v === "+" || k.v === "-")) {
        next();
        const r = term();
        v = k.v === "+" ? v + r : v - r;
      } else return v;
    }
  }
  function term(): number {
    let v = factor();
    for (;;) {
      const k = peek();
      if (k && k.t === "op" && (k.v === "*" || k.v === "/" || k.v === "%")) {
        next();
        const r = factor();
        if (k.v === "*") v *= r;
        else if (k.v === "/") {
          if (r === 0) throw new Error("division by zero");
          v /= r;
        } else v %= r;
      } else return v;
    }
  }
  function factor(): number {
    const base = unary();
    const k = peek();
    if (k && k.t === "op" && k.v === "^") {
      next();
      return base ** factor(); // right-associative
    }
    return base;
  }
  function unary(): number {
    const k = peek();
    if (k && k.t === "op" && k.v === "-") { next(); return -unary(); }
    if (k && k.t === "op" && k.v === "+") { next(); return unary(); }
    return primary();
  }
  function primary(): number {
    const k = next();
    if (!k) throw new Error("unexpected end of expression");
    if (k.t === "num") return k.v;
    if (k.t === "(") { const v = expr(); expect(")"); return v; }
    if (k.t === "id") {
      if (k.v in CONSTS) return CONSTS[k.v]!;
      const fn = FUNCS[k.v];
      if (!fn) throw new Error(`unknown identifier "${k.v}"`);
      expect("(");
      const args: number[] = [expr()];
      while (peek()?.t === ",") { next(); args.push(expr()); }
      expect(")");
      return fn(...args);
    }
    throw new Error(`unexpected token ${JSON.stringify(k)}`);
  }

  const v = expr();
  if (p !== toks.length) throw new Error("trailing input");
  if (!Number.isFinite(v)) throw new Error("result is not finite");
  return v;
}

function formatNumber(v: number): string {
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1e6) / 1e6);
}

// ---------------------------------------------------------------------------
// unit_convert
// ---------------------------------------------------------------------------

/** Every unit maps to a base unit per dimension with a linear factor. */
const UNITS: Record<string, { dim: string; factor: number }> = {
  mm: { dim: "length", factor: 0.001 }, cm: { dim: "length", factor: 0.01 }, m: { dim: "length", factor: 1 },
  km: { dim: "length", factor: 1000 }, in: { dim: "length", factor: 0.0254 }, ft: { dim: "length", factor: 0.3048 },
  mi: { dim: "length", factor: 1609.344 },
  g: { dim: "mass", factor: 0.001 }, kg: { dim: "mass", factor: 1 }, t: { dim: "mass", factor: 1000 }, lb: { dim: "mass", factor: 0.45359237 },
  s: { dim: "time", factor: 1 }, min: { dim: "time", factor: 60 }, h: { dim: "time", factor: 3600 }, day: { dim: "time", factor: 86400 },
  "m/s": { dim: "speed", factor: 1 }, "km/h": { dim: "speed", factor: 1000 / 3600 }, kmh: { dim: "speed", factor: 1000 / 3600 }, mph: { dim: "speed", factor: 1609.344 / 3600 },
  ml: { dim: "volume", factor: 0.001 }, l: { dim: "volume", factor: 1 },
  c: { dim: "temp", factor: 1 }, f: { dim: "temp", factor: 1 }, k: { dim: "temp", factor: 1 },
};

export function convertUnit(value: number, from: string, to: string): number {
  const f = UNITS[from.toLowerCase()];
  const t = UNITS[to.toLowerCase()];
  if (!f || !t) throw new Error(`unknown unit "${!f ? from : to}"`);
  if (f.dim !== t.dim) throw new Error(`cannot convert ${f.dim} to ${t.dim}`);
  if (f.dim === "temp") {
    const toC = (v: number, u: string) => (u === "c" ? v : u === "f" ? ((v - 32) * 5) / 9 : v - 273.15);
    const fromC = (v: number, u: string) => (u === "c" ? v : u === "f" ? (v * 9) / 5 + 32 : v + 273.15);
    return fromC(toC(value, from.toLowerCase()), to.toLowerCase());
  }
  return (value * f.factor) / t.factor;
}

// ---------------------------------------------------------------------------
// date_diff
// ---------------------------------------------------------------------------

export function dateDiffDays(from: string, to: string): number {
  const a = Date.parse(from + "T00:00:00Z");
  const b = Date.parse(to + "T00:00:00Z");
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error("invalid date");
  return Math.round((b - a) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Registry + executor
// ---------------------------------------------------------------------------

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  calculator:
    'Exact arithmetic. arguments_json: {"expression": "..."} using + - * / ^ ( ) sqrt() abs() round(x, digits) min() max() pi e.',
  unit_convert:
    'Unit conversion. arguments_json: {"value": number, "from": "km/h", "to": "m/s"}; units: mm cm m km in ft mi, g kg t lb, s min h day, m/s km/h mph, ml l, c f k.',
  date_diff: 'Days between two dates. arguments_json: {"from": "YYYY-MM-DD", "to": "YYYY-MM-DD"}.',
};

export function executeTool(call: ToolCall): ToolResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments_json);
  } catch {
    return { name: call.name, arguments: {}, ok: false, result: "arguments_json is not valid JSON" };
  }
  const schema = ToolArgSchemas[call.name];
  const args = schema.safeParse(parsed);
  if (!args.success) {
    const msg = args.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { name: call.name, arguments: (parsed as Record<string, unknown>) ?? {}, ok: false, result: `invalid arguments: ${msg}` };
  }
  try {
    switch (call.name) {
      case "calculator": {
        const a = args.data as { expression: string };
        return { name: call.name, arguments: a, ok: true, result: `${a.expression} = ${formatNumber(evaluateExpression(a.expression))}` };
      }
      case "unit_convert": {
        const a = args.data as { value: number; from: string; to: string };
        const v = convertUnit(a.value, a.from, a.to);
        return { name: call.name, arguments: a, ok: true, result: `${formatNumber(a.value)} ${a.from} = ${formatNumber(v)} ${a.to}` };
      }
      case "date_diff": {
        const a = args.data as { from: string; to: string };
        return { name: call.name, arguments: a, ok: true, result: `${a.from} -> ${a.to} = ${dateDiffDays(a.from, a.to)} days` };
      }
    }
  } catch (e) {
    return { name: call.name, arguments: args.data as Record<string, unknown>, ok: false, result: (e as Error).message };
  }
}
