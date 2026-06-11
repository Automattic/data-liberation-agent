// src/lib/replicate/normalize/detect-behaviors.ts
//
// Pure, deterministic detection of catalog source behaviors (spec §4b, Plan A:
// reveal + sticky). Regex heuristics over the CONCATENATED source css/js — the
// same strings collectSourceAssets produces. Narrow on purpose: a behavior is
// tagged only when BOTH its JS driver and its CSS effect are present; anything
// else in the JS is reported as a behavior-gap, never guessed (spec §6).
//
// Residue heuristic: the JS is split into top-level statements (`;` at
// brace/paren depth 0; string-, comment-, and regex-literal-aware) and each
// statement is classified against the DETECTED behaviors' driver regexes.
// Unclaimed statements with meaningful (comment-stripped, above-floor) code
// collapse into ONE `uncatalogued-js` gap with an excerpt — coarse by design;
// no precise JS slicing is attempted.
import type {
  BehaviorGap,
  DetectedBehaviors,
  RevealBehavior,
  StickyBehavior,
} from '../local-site/types.js';

/** Minimal structural slice of local-theme SourceAssets — a full SourceAssets
 * satisfies this, but normalize/ must not depend on local-theme/. */
export interface BehaviorSourceAssets {
  /** All source CSS concatenated. */
  css: string;
  /** All source JS concatenated. */
  js: string;
}

// --- reveal (IntersectionObserver scroll-reveal) -----------------------------
const IO_RE = /new\s+IntersectionObserver\s*\(/;
const IO_ADD_CLASS_RE = /classList\.add\(\s*['"][a-zA-Z0-9_-]+['"]\s*\)/;
const IO_THRESHOLD_RE = /threshold\s*:\s*([0-9.]+)/;
/** Wiring statements like `obs.observe(el)` / `obs.unobserve(el)`. NOTE: once
 * reveal is detected this also claims bystander ResizeObserver/MutationObserver
 * `.observe(` wiring — the gap COUNT survives, its content is partial
 * (accepted v1 narrowness). */
const OBSERVE_CALL_RE = /\.(?:un)?observe\s*\(/;
/** CSS gate AND param source: the first `html.js section` rule whose body
 * hides sections (opacity:0). Captures the rule BODY so translateY/duration
 * parse from the gate rule only — earlier unrelated transition/transform
 * rules (nav hover etc.) must not leak into the reveal params. */
const REVEAL_GATE_BODY_RE = /html\.js\s+section[^{]*\{([^}]*opacity\s*:\s*0[^}]*)\}/;
const TRANSLATE_Y_RE = /translateY\(\s*(-?[0-9.]+(?:px|rem|em|%))\s*\)/;
const DURATION_RE = /transition\s*:[^;}]*?([0-9.]+)(ms|s)\b/;

const DEFAULT_THRESHOLD = 0.12;
const DEFAULT_DURATION_MS = 600;

// --- sticky (scroll-reactive class toggle) -----------------------------------
const SCROLL_LISTENER_RE = /addEventListener\s*\(\s*['"]scroll['"]/;
const TOGGLE_CLASS_RE = /classList\.toggle\(\s*['"]([a-zA-Z0-9_-]+)['"]/;
const SCROLL_OFFSET_RE = /scrollY\s*>\s*([0-9]+)/;

const DEFAULT_STICKY_OFFSET = 8;

const EXCERPT_MAX = 200;
/** Residue below this many comment-stripped chars (total) is noise — license
 * headers, stray semicolons — not a reportable behavior gap. */
const MIN_GAP_CODE_CHARS = 20;

interface TopLevelStatement {
  /** Verbatim source slice — used for the gap excerpt. */
  raw: string;
  /** Comment-stripped text — used for classification + the residue floor. */
  code: string;
}

/** Chars after which a `/` opens a regex literal (standard prev-token
 * heuristic), alongside start-of-statement and the `return` keyword. `{`/`[`
 * are included: a `/` directly after either cannot be division. */
const REGEX_PRECEDERS = new Set(['=', '(', ',', ':', ';', '!', '&', '|', '?', '{', '[']);

/**
 * Split JS into top-level statements: `;` at bracket depth 0, skipping
 * strings, template literals, comments, and regex literals (prev-token
 * heuristic, `[...]` classes honored; a newline inside aborts the regex scan
 * — literals cannot span lines). Known limitations, accepted for a coarse
 * residue pass:
 * - ASI: a semicolon-less statement merges into the following chunk.
 * - Merged chunks classify as a unit: a driver+gap merge is CLAIMED WHOLESALE
 *   once its behavior is detected, so the gap inside it is silently lost.
 */
function splitTopLevelStatements(js: string): TopLevelStatement[] {
  const out: TopLevelStatement[] = [];
  const n = js.length;
  let start = 0;
  let depth = 0;
  let code = '';
  let i = 0;

  const push = (end: number): void => {
    const raw = js.slice(start, end).trim();
    const stripped = code.trim();
    // Comment-only / empty chunks never reach residue.
    if (raw && stripped) out.push({ raw, code: stripped });
    code = '';
  };

  const regexFollows = (): boolean => {
    const sig = code.trimEnd();
    if (!sig) return true; // start of statement
    if (/\breturn$/.test(sig)) return true;
    return REGEX_PRECEDERS.has(sig[sig.length - 1]);
  };

  while (i < n) {
    const ch = js[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const from = i;
      const quote = ch;
      i++;
      while (i < n && js[i] !== quote) {
        if (js[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // past closing quote
      code += js.slice(from, i);
      continue;
    }
    if (ch === '/' && js[i + 1] === '/') {
      while (i < n && js[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && js[i + 1] === '*') {
      i += 2;
      while (i < n && !(js[i] === '*' && js[i + 1] === '/')) i++;
      i += 2;
      code += ' '; // token separator where the comment sat
      continue;
    }
    if (ch === '/' && regexFollows()) {
      const from = i;
      i++; // past opening '/'
      let inClass = false;
      while (i < n) {
        const c = js[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === '\n') break; // not a regex after all — keep run as plain text
        if (inClass) {
          if (c === ']') inClass = false;
        } else if (c === '[') {
          inClass = true;
        } else if (c === '/') {
          i++; // past closing '/'
          break;
        }
        i++;
      }
      while (i < n && /[a-z]/i.test(js[i])) i++; // flags
      code += js.slice(from, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ';' && depth === 0) {
      push(i);
      start = i + 1;
      i++;
      continue;
    }
    code += ch;
    i++;
  }
  if (start < n) push(n);
  return out;
}

/** One-line, length-capped excerpt for gap reporting. */
function toExcerpt(code: string): string {
  const collapsed = code.replace(/\s+/g, ' ').trim();
  return collapsed.length > EXCERPT_MAX ? `${collapsed.slice(0, EXCERPT_MAX)}...` : collapsed;
}

/** Statement participates in the reveal driver (observer ctor or observe wiring). */
function isRevealDriverStatement(code: string): boolean {
  return IO_RE.test(code) || OBSERVE_CALL_RE.test(code);
}

/** Statement participates in the sticky driver (scroll listener). */
function isStickyDriverStatement(code: string): boolean {
  return SCROLL_LISTENER_RE.test(code);
}

function detectReveal(css: string, revealJs: string): RevealBehavior | undefined {
  if (!IO_RE.test(revealJs) || !IO_ADD_CLASS_RE.test(revealJs)) return undefined;
  const gateBody = REVEAL_GATE_BODY_RE.exec(css)?.[1];
  if (gateBody === undefined) return undefined;
  const threshold = Number(IO_THRESHOLD_RE.exec(revealJs)?.[1] ?? DEFAULT_THRESHOLD);
  // Params come from the GATE RULE BODY only, defaults on absence.
  const translateY = TRANSLATE_Y_RE.exec(gateBody)?.[1] ?? '0px';
  const durationMatch = DURATION_RE.exec(gateBody);
  const durationMs = durationMatch
    ? durationMatch[2] === 'ms'
      ? Number(durationMatch[1])
      : Number(durationMatch[1]) * 1000
    : DEFAULT_DURATION_MS;
  return { kind: 'reveal', threshold, translateY, durationMs };
}

function detectSticky(css: string, stickyJs: string): StickyBehavior | undefined {
  if (!SCROLL_LISTENER_RE.test(stickyJs)) return undefined;
  const toggleClass = TOGGLE_CLASS_RE.exec(stickyJs)?.[1];
  if (!toggleClass) return undefined;
  // toggleClass is capture-constrained to [a-zA-Z0-9_-]+ — every char is
  // regex-literal, so direct interpolation is safe.
  if (!new RegExp(`\\.${toggleClass}[\\s.,{[:>]`).test(css)) return undefined;
  const offset = Number(SCROLL_OFFSET_RE.exec(stickyJs)?.[1] ?? DEFAULT_STICKY_OFFSET);
  return { kind: 'sticky', toggleClass, offset };
}

/**
 * Detect Plan A catalog behaviors in the concatenated source assets.
 * `reveal`/`sticky` keys are present ONLY when detected; `gaps` always is.
 */
export function detectBehaviors({ css, js }: BehaviorSourceAssets): DetectedBehaviors {
  const statements = splitTopLevelStatements(js);

  // Detect against ONLY the driver statements so params (threshold, toggle
  // class, offset) are read from the behavior's own code, not bystander JS.
  const revealJs = statements
    .filter((s) => isRevealDriverStatement(s.code))
    .map((s) => s.code)
    .join('\n');
  const stickyJs = statements
    .filter((s) => isStickyDriverStatement(s.code))
    .map((s) => s.code)
    .join('\n');
  const reveal = detectReveal(css, revealJs);
  const sticky = detectSticky(css, stickyJs);

  // A statement is claimed only by a DETECTED behavior — driver JS whose CSS
  // half is missing stays residue, so the gap report still surfaces it.
  const residue = statements.filter(
    (s) =>
      !(reveal && isRevealDriverStatement(s.code)) &&
      !(sticky && isStickyDriverStatement(s.code)),
  );
  const residueCodeChars = residue.reduce((sum, s) => sum + s.code.length, 0);
  const gaps: BehaviorGap[] =
    residueCodeChars >= MIN_GAP_CODE_CHARS
      ? [
          {
            pattern: 'uncatalogued-js',
            jsExcerpt: toExcerpt(residue.map((s) => s.raw).join(' ')),
          },
        ]
      : [];

  const detected: DetectedBehaviors = { gaps };
  if (reveal) detected.reveal = reveal;
  if (sticky) detected.sticky = sticky;
  return detected;
}
