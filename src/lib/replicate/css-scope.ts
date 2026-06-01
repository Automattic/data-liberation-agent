import postcss, { type Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';

export interface ScopeOpts {
  /** Wrapper selector to scope everything under, e.g. `body.lib-alt-site`. */
  scope: string;
  /** Stable short id (used later for @keyframes namespacing). */
  scopeId?: string;
  /** Rewrite url(...) targets; return null to leave unchanged. */
  rewriteUrl?: (url: string) => string | null;
}

const ROOTISH = new Set(['html', 'body', ':root']);

function scopeSelector(selector: string, scope: string): string {
  return selectorParser((selectors) => {
    selectors.each((sel) => {
      const first = sel.first;
      if (
        first &&
        (first.type === 'tag' || first.type === 'pseudo') &&
        ROOTISH.has(first.toString())
      ) {
        first.replaceWith(selectorParser.string({ value: scope }));
        return;
      }
      // Reverse-order prepends: each prepend pushes ahead of the current first node, so
      // inserting the combinator first then the scope yields `scope <combinator> <original…>`.
      sel.prepend(selectorParser.combinator({ value: ' ' }));
      sel.prepend(selectorParser.string({ value: scope }));
    });
  }).processSync(selector);
}

export function scopeCss(css: string, opts: ScopeOpts): string {
  const root = postcss.parse(css);

  root.walkRules((rule: Rule) => {
    if (
      rule.parent &&
      rule.parent.type === 'atrule' &&
      /keyframes$/i.test((rule.parent as { name?: string }).name ?? '')
    )
      return;
    rule.selector = rule.selectors.map((s) => scopeSelector(s, opts.scope)).join(', ');
  });

  if (opts.scopeId) {
    const renamed = new Map<string, string>();
    root.walkAtRules(/^keyframes$/i, (at) => {
      const from = at.params.trim();
      const to = `${from}__${opts.scopeId}`;
      renamed.set(from, to);
      at.params = to;
    });
    if (renamed.size > 0) {
      root.walkDecls(/^(animation|animation-name)$/i, (decl) => {
        for (const [from, to] of renamed) {
          decl.value = decl.value.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
        }
      });
    }
  }

  if (opts.rewriteUrl) {
    root.walkDecls((decl) => {
      decl.value = decl.value.replace(
        /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi,
        (m, q, url) => {
          const next = opts.rewriteUrl!(url);
          return next ? `url(${q}${next}${q})` : m;
        },
      );
    });
  }

  return root.toString();
}
