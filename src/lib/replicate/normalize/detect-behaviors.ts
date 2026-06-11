// src/lib/replicate/normalize/detect-behaviors.ts
//
// Pure, deterministic detection of catalog source behaviors (spec §4b, Plan A:
// reveal + sticky). Regex heuristics over the CONCATENATED source css/js — the
// same strings collectSourceAssets produces. Narrow on purpose: a behavior is
// tagged only when BOTH its JS driver and its CSS effect are present; anything
// else in the JS is reported as a behavior-gap, never guessed (spec §6).
//
// Residue heuristic: the JS is split into top-level statements (`;` at
// brace/paren depth 0, string- and comment-aware) and each statement is
// classified against the DETECTED behaviors' driver regexes. Unclaimed,
// non-empty statements collapse into ONE `uncatalogued-js` gap with an
// excerpt — coarse by design; no precise JS slicing is attempted.
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
/** Wiring statements like `obs.observe(el)` / `obs.unobserve(el)`. */
const OBSERVE_CALL_RE = /\.(?:un)?observe\s*\(/;
/** CSS gate: the hidden-by-default rule the observer's class reveals. */
const REVEAL_CSS_GATE_RE = /html\.js\s+section[^{]*\{[^}]*opacity\s*:\s*0/;
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

/**
 * Split JS into top-level statements: `;` at bracket depth 0, skipping
 * strings, template literals, and comments. ASI limitation (documented, not
 * solved): semicolon-less statements merge into the following chunk — fine
 * for residue purposes since a merged chunk still classifies by its drivers.
 */
function splitTopLevelStatements(js: string): string[] {
  const out: string[] = [];
  const n = js.length;
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < n) {
    const ch = js[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i++;
      while (i < n && js[i] !== quote) {
        if (js[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // past closing quote
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
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth = Math.max(0, depth - 1);
    } else if (ch === ';' && depth === 0) {
      out.push(js.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  if (start < n) out.push(js.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** One-line, length-capped excerpt for gap reporting. */
function toExcerpt(code: string): string {
  const collapsed = code.replace(/\s+/g, ' ').trim();
  return collapsed.length > EXCERPT_MAX ? `${collapsed.slice(0, EXCERPT_MAX)}...` : collapsed;
}

/** Statement participates in the reveal driver (observer ctor or observe wiring). */
function isRevealDriverStatement(statement: string): boolean {
  return IO_RE.test(statement) || OBSERVE_CALL_RE.test(statement);
}

/** Statement participates in the sticky driver (scroll listener). */
function isStickyDriverStatement(statement: string): boolean {
  return SCROLL_LISTENER_RE.test(statement);
}

function detectReveal(css: string, revealJs: string): RevealBehavior | undefined {
  if (!IO_RE.test(revealJs) || !IO_ADD_CLASS_RE.test(revealJs)) return undefined;
  if (!REVEAL_CSS_GATE_RE.test(css)) return undefined;
  const threshold = Number(IO_THRESHOLD_RE.exec(revealJs)?.[1] ?? DEFAULT_THRESHOLD);
  const translateY = TRANSLATE_Y_RE.exec(css)?.[1] ?? '0px';
  const durationMatch = DURATION_RE.exec(css);
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
  const revealJs = statements.filter(isRevealDriverStatement).join('\n');
  const stickyJs = statements.filter(isStickyDriverStatement).join('\n');
  const reveal = detectReveal(css, revealJs);
  const sticky = detectSticky(css, stickyJs);

  // A statement is claimed only by a DETECTED behavior — driver JS whose CSS
  // half is missing stays residue, so the gap report still surfaces it.
  const residue = statements.filter(
    (s) =>
      !(reveal && isRevealDriverStatement(s)) && !(sticky && isStickyDriverStatement(s)),
  );
  const gaps: BehaviorGap[] = residue.length
    ? [{ pattern: 'uncatalogued-js', jsExcerpt: toExcerpt(residue.join(' ')) }]
    : [];

  const detected: DetectedBehaviors = { gaps };
  if (reveal) detected.reveal = reveal;
  if (sticky) detected.sticky = sticky;
  return detected;
}
