// Project only bounded contract fields, never diagnostics' free-text paths or timestamps.
export const sorted = values => [...new Set(values)].sort();
export function counts(values) {
  return Object.fromEntries(sorted(values).map(code => [code, values.filter(value => value === code).length]));
}
export function summarize(site, receipt, findings, diagnostics, report, execution) {
  const paths = sorted([
    ...(receipt?.routes ?? []).map(row => '/' + row.path.replace(/^website\//, '').replace(/index\.html$/, '')),
    ...(report?.routes ?? []),
    ...(report?.scores ?? []).map(row => row.route),
    ...(report?.pending ?? []).map(row => row.route),
  ]);
  const offline = report?.selfConsistency;
  return {
    host: new URL(site.url).host, url: site.url, expectedPlatform: site.platform,
    platform: receipt?.source?.platform ?? null,
    counts: {
      // The route budget caps `discovered`; the inventory is what discovery found.
      inventory: receipt?.summary ? (receipt.summary.routesDiscovered ?? 0) + (receipt.summary.routesOmitted ?? 0) : null,
      discovered: receipt?.summary?.routesDiscovered ?? null,
      captured: receipt?.summary?.routesCaptured ?? null,
      exported: receipt ? receipt.routes.length : null,
    },
    // Source findings is the canonical deduplicated loss projection. Do not count
    // the same losses again in receipt/diagnostics. Uncoded failures stay visible.
    findings: counts((findings?.findings ?? []).map(row => row.code)),
    failures: counts((diagnostics?.failures ?? []).map(row => row.code ?? 'capture_failed')),
    compare: {
      pass: report?.pass ?? null,
      selfConsistency: offline?.pass ?? null,
      frozenFidelity: report ? report.status ?? (report.pass ? 'proven' : 'failed') : 'unproven',
      routes: paths.map(route => {
        const scores = (report?.scores ?? []).filter(row => row.route === route);
        const pending = (report?.pending ?? []).some(row => row.route === route);
        return {
          route,
          selfConsistency: offline ? !(offline.findings ?? []).some(row => row.route === route) : null,
          frozenFidelity: scores.some(row => !row.pass) ? 'failed' : pending || !scores.length ? 'unproven' : 'proven',
          findings: counts((offline?.findings ?? []).filter(row => row.route === route).map(row => row.kind)),
        };
      }),
    },
    ...execution,
  };
}
