#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Wall time is evidence, not a regression metric: network/browser scheduling varies.
export function diff(before, after) {
  if (before.schema !== 'parity/v1' || after.schema !== 'parity/v1') throw new Error('Expected parity/v1 summaries');
  const changes = [];
  const add = (host, field, oldValue, newValue, regression) => {
    if (oldValue !== newValue) changes.push({ host, field, before: oldValue, after: newValue, regression });
  };
  const metric = (host, field, a, b, higherBetter) => add(host, field, a, b,
    b == null || (a != null && (higherBetter ? b < a : b > a)));
  const status = (host, field, a, b) => {
    const rank = { proven: 2, failed: 0, unproven: 1, true: 2, false: 0, null: -1 };
    add(host, field, a, b, rank[String(b)] < rank[String(a)]);
  };
  const codes = (host, prefix, a = {}, b = {}) => {
    for (const code of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      metric(host, `${prefix}.${code}`, a[code] ?? 0, b[code] ?? 0, false);
    }
  };
  const oldSites = new Map(before.sites.map(site => [site.host, site]));
  const newSites = new Map(after.sites.map(site => [site.host, site]));
  for (const host of [...new Set([...oldSites.keys(), ...newSites.keys()])].sort()) {
    const a = oldSites.get(host), b = newSites.get(host);
    if (!a || !b) { add(host, 'site', !!a, !!b, !b); continue; }
    // Changing the experiment is never silently treated as parity.
    for (const key of ['url', 'expectedPlatform']) add(host, key, a[key], b[key], true);
    add(host, 'platform', a.platform, b.platform, b.platform !== b.expectedPlatform);
    for (const key of ['inventory', 'discovered', 'captured', 'exported']) metric(host, `counts.${key}`, a.counts[key], b.counts[key], true);
    for (const key of ['liberate', 'compare']) status(host, `exitCodes.${key}`, a.exitCodes[key] === 0, b.exitCodes[key] === 0);
    codes(host, 'findings', a.findings, b.findings);
    codes(host, 'failures', a.failures, b.failures);
    for (const key of ['pass', 'selfConsistency', 'frozenFidelity']) status(host, `compare.${key}`, a.compare[key], b.compare[key]);
    const oldRoutes = new Map(a.compare.routes.map(row => [row.route, row]));
    const newRoutes = new Map(b.compare.routes.map(row => [row.route, row]));
    for (const route of [...new Set([...oldRoutes.keys(), ...newRoutes.keys()])].sort()) {
      const x = oldRoutes.get(route), y = newRoutes.get(route);
      if (!x || !y) { add(host, `route ${route}`, !!x, !!y, !y); continue; }
      for (const key of ['selfConsistency', 'frozenFidelity']) status(host, `${route} ${key}`, x[key], y[key]);
      codes(host, `${route} findings`, x.findings, y.findings);
    }
  }
  return changes;
}
/**
 * A candidate field regresses only when it is worse than every baseline run. Two
 * or more baselines of unchanged code define the source's own run-to-run range
 * (timeouts, frozen-fidelity cells and interaction findings vary with load), so
 * a change inside that range is reported as unstable rather than a regression.
 */
export function diffAgainstBaselines(baselines, candidate) {
  const perBaseline = baselines.map(baseline => diff(baseline, candidate));
  const key = change => `${change.host}\u0000${change.field}`;
  const regressedIn = new Map();
  for (const changes of perBaseline) for (const change of changes) {
    if (change.regression) regressedIn.set(key(change), (regressedIn.get(key(change)) ?? 0) + 1);
  }
  const seen = new Set();
  const result = [];
  for (const change of perBaseline.flat()) {
    if (seen.has(key(change))) continue;
    seen.add(key(change));
    const regressions = regressedIn.get(key(change)) ?? 0;
    const kind = regressions === baselines.length ? 'regression' : regressions > 0 ? 'unstable' : 'improvement';
    result.push({ ...change, regression: kind === 'regression', kind });
  }
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = process.argv.slice(2);
  if (paths.length < 2) throw new Error('Usage: node scripts/parity/diff.mjs <baseline/summary.json>... <candidate/summary.json>');
  const [candidate, ...baselines] = paths.reverse().map(path => JSON.parse(readFileSync(path, 'utf8')));
  const changes = diffAgainstBaselines(baselines.reverse(), candidate);
  for (const change of changes) console.log(`${change.kind.toUpperCase()} ${change.host} ${change.field}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`);
  process.exitCode = changes.some(change => change.regression) ? 1 : 0;
}
