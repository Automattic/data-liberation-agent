/**
 * Generic JS-reveal un-freeze for the carry path. Builder themes gate entrance
 * animations on a hook class whose initial CSS state is hidden (opacity:0 /
 * visibility:hidden / display:none) and whose reveal is fired by runtime JS
 * (IntersectionObserver / hydration). Carry strips scripts, so those elements stay
 * frozen. We detect the gate classes from the SOURCE CSS (no hardcoded theme names)
 * and emit a scoped override forcing the revealed end-state.
 *
 * Leave `nav-reveal-unfreeze.ts` unchanged — its `:has()` ancestor-targeting
 * override for the Wix horizontal-menu case is distinct from this generic path.
 */
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

/**
 * Match opacity values that represent a visually-hidden initial state:
 *   - exact zero:          opacity:0 / opacity: 0
 *   - zero with decimal:   opacity:0.0  / opacity:0.00
 *   - small fraction:      opacity:.01  / opacity:0.01  / opacity:.05
 *
 * Does NOT match:
 *   - opacity:1  (fully visible)
 *   - opacity:0.5  (partly visible)
 *   - opacity:0.1  (mostly visible for animation purposes)
 *
 * Negative lookahead (?![.0-9]) guards against matching the leading `0` in
 * `0.5` — after consuming `0`, any following `.` or digit aborts the match.
 */
const HIDDEN_OPACITY_RE = /opacity\s*:\s*(?:0?\.0\d*|0(?:\.0+)?)(?![.0-9])/i;

/**
 * Classes whose rule sets a hidden initial reveal state (opacity≈0 / visibility:hidden
 * / display:none) AND look animation-driven (transition / animation / transform present,
 * or an `--offscreen` / `:not()` reveal pattern). Returns bare class names (no dot).
 *
 * Hover/focus rules are excluded — they don't represent a frozen hidden-by-default state.
 */
export function detectRevealGateClasses(css: string): string[] {
  const gates = new Set<string>();
  let root: postcss.Root;
  try {
    root = postcss.parse(css);
  } catch {
    return [];
  }

  root.walkRules((rule) => {
    // Read DECLARATIONS only — never the selector text — so a class literally
    // named `.transition-up` / `.opacity-fade` with `opacity:0` isn't mistaken
    // for an animated reveal gate (the "transition"/"opacity" token would
    // otherwise leak in from the selector via `rule.toString()`).
    const decls = (rule.nodes ?? []).filter(
      (n): n is postcss.Declaration => n.type === 'decl',
    );
    const declText = decls.map((d) => `${d.prop}:${d.value}`).join(';');

    const hidesContent =
      HIDDEN_OPACITY_RE.test(declText) ||
      /visibility\s*:\s*hidden/i.test(declText) ||
      /display\s*:\s*none/i.test(declText);
    if (!hidesContent) return;

    const animated = decls.some((d) => /^(?:transition|animation|transform)/i.test(d.prop));
    // The `--offscreen` / `:not()` reveal heuristic intentionally reads the
    // SELECTOR (that's where the offscreen state lives, e.g. Dawn's
    // `.scroll-trigger--offscreen{visibility:hidden}`).
    const offscreen = /--offscreen|:not\(/i.test(rule.selector);
    if (!animated && !offscreen) return;

    // Skip hover/focus variant rules — they describe an interactive state, not a
    // frozen entrance gate.
    if (/:hover|:focus/i.test(rule.selector)) return;

    // A compound selector (e.g. `.a.b{opacity:0}`) yields BOTH `a` and `b`. This
    // is intentionally over-broad: forcing the revealed end-state on either class
    // is safe for a static carry (no JS means no state ever toggles them back).
    selectorParser((sels) => {
      sels.walkClasses((c) => {
        gates.add(c.value);
      });
    }).processSync(rule.selector);
  });

  return [...gates];
}

/**
 * Append a scoped end-state override for any JS-reveal gate class present in
 * `domHtml`. No-ops (returns `css` unchanged) when no detected gates appear in
 * the DOM.
 *
 * @param css       The already-scoped, treeshaken sheet to augment.
 * @param sourceCss The original source CSS used to detect gate classes.
 * @param domHtml   The carried DOM the sheet styles (chrome or main region).
 * @param scope     The sheet's wrapper selector (e.g. `body.lib-carry-site`).
 */
export function appendRevealUnfreeze(
  css: string,
  sourceCss: string,
  domHtml: string,
  scope: string,
): string {
  // Match on a class-token boundary, not a raw substring, so a short gate class
  // (e.g. `in`) isn't considered present just because the DOM contains
  // `section-inner`. A class token is delimited by start/whitespace/quote on the
  // left and whitespace/quote/`>` on the right.
  const inDom = (g: string) =>
    new RegExp(`(?:^|[\\s"'])${g.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s"'>])`).test(domHtml);
  const gates = detectRevealGateClasses(sourceCss).filter(inDom);
  if (gates.length === 0) return css;

  const sel = gates.map((g) => `:where(${scope}) .${g}`).join(',\n');
  const override =
    `\n\n/* carry: un-freeze stripped JS-reveal entrance gates (opacity/visibility/transform initial state). */\n` +
    `${sel}{opacity:1!important;visibility:visible!important;transform:none!important}\n`;
  return css + override;
}
