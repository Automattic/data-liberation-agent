import { parseArgs, type ParseArgsConfig } from 'node:util';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { parseDurationMs } from './lib/duration.js';
import { resolveOutputBase } from './lib/paths.js';

export const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
export type Verb = 'liberate' | 'inspect' | 'compare' | 'publish';
type Kind = 'string' | 'boolean' | 'integer' | 'duration' | 'count' | 'json' | 'strings';
export interface OptionDescriptor {
  key: string;
  flag: string;
  type: Kind;
  help: string;
  enum?: string[];
  min?: number;
  max?: number;
  default?: unknown | (() => unknown);
  invert?: boolean;
  repeat?: boolean;
  mcpKey?: string;
  surfaces?: ('cli' | 'mcp')[];
  metavar?: string;
}
const boolean = (key: string, flag: string, help: string): OptionDescriptor => ({ key, flag, help, type: 'boolean', default: false });
const integer = (key: string, flag: string, help: string, min = 1, max?: number): OptionDescriptor => ({ key, flag, help, type: 'integer', min, max });
const duration = (key: string, flag: string, help: string): OptionDescriptor => ({ key, flag, help, type: 'duration', min: 1 });

/** The transport contract. Omitted values deliberately defer to the verb's own defaults. */
export const options: Record<Verb, OptionDescriptor[]> = {
  liberate: [
    { key: 'acquisition', flag: 'acquisition', type: 'string', enum: ['browser', 'http'], help: 'browser (default), or http for an unverified review candidate', metavar: 'mode' },
    { key: 'trustedOrigins', flag: 'trusted-origin', type: 'strings', repeat: true, default: () => [], help: 'Vouch for an exact origin you own (scheme, host, port), e.g. http://localhost:8884. Repeatable. Other internal hosts and redirects stay blocked.' },
    { key: 'routeLimit', flag: 'route-limit', type: 'count', min: 1, help: 'Capture at most n routes, homepage plus an even spread; browser default: 17-minute time window; http default all. Omitted routes are diagnosed, not failed.' },
    { key: 'routeSelection', flag: 'route-selection', type: 'string', enum: ['discovery-order', 'template-coverage'], metavar: 'mode', help: 'discovery-order (default), or template-coverage: fetch server HTML and keep one route per template group first; writes template-groups.json.' },
    boolean('templateClusters', 'template-clusters', 'Opt-in template-clustered capture: verify a member before deriving others from HTTP content. Derived routes are reported as losses and uncompared scope.'),
    integer('runtimeRouteLimit', 'runtime-route-limit', 'Observe HTTP runtime regions on at most n routes (0-50; default 0).', 0, 50),
    { key: 'outputBase', mcpKey: 'outputDir', flag: 'output', type: 'string', default: resolveOutputBase, metavar: 'dir', help: 'Output base directory (default: ~/data-liberation or DLA_OUTPUT_DIR).' },
    boolean('resume', 'resume', 'Reuse artifacts already on disk instead of recapturing.'),
    boolean('checkpoint', 'checkpoint', 'Defer export while time-budget-skipped routes remain; resume into the same directory.'),
    boolean('screenshots', 'screenshots', 'Also capture full-page and scrolled PNG screenshots.'),
    { ...boolean('serve', 'serve', 'Keep a local server running until interrupted. Otherwise liberation writes the site and exits.'), surfaces: ['cli'] },
    { key: 'learnFluid', flag: 'no-learn-fluid', type: 'boolean', invert: true, default: true, help: 'Skip the width sweep and freeze the layout at one width. Learning is on by default.' },
    { key: 'referenceSample', flag: 'reference-sample', type: 'count', min: 1, help: 'Freeze baseline reference evidence for n sampled routes (default 1: homepage), or all. Unsampled routes remain uncompared scope.' },
    duration('timeBudgetMs', 'time-budget', 'Stop starting routes and export when this much time passes, e.g. 13m, 780s (bare numbers are ms). Default: 17m unless --route-limit is set. Browser only; leave post-capture headroom.'),
    duration('routeDeadlineMs', 'route-deadline', 'Bound each route, e.g. 30s; optional probes get smaller budgets within this deadline.'),
    { ...duration('routeReserveMs', 'route-reserve', 'Hold this much of the time budget per started route for downstream work, e.g. 8s. Default 0. No effect without a time budget. Browser only; excluded routes are route_capture_skipped_budget.'), min: 0 },
    integer('maxFileBytes', 'max-file-bytes', 'Largest exported file (default 52428800, 50 MiB). Larger assets are reported as asset_exceeds_file_limit.'),
    integer('maxTotalBytes', 'max-total-bytes', 'Most exported bytes (default 262144000, 250 MiB). Drop non-entry assets largest first, fonts last, then non-entry routes; reported as asset_exceeds_total_budget / route_exceeds_total_budget.'),
    integer('maxFiles', 'max-files', 'Most exported files (default 5000), enforced like --max-total-bytes.'),
    { key: 'deviceMode', flag: 'device-mode', type: 'string', enum: ['auto', 'dual', 'reflow-only'], metavar: 'mode', help: 'auto (default) captures desktop only when phones reflow the same document; dual always captures both; reflow-only always captures desktop only.' },
    { key: 'portableMotion', flag: 'portable-motion', type: 'json', help: 'Author a portable runtime from hash-pinned independent scripts, verified against the live source before export.' },
  ],
  inspect: [
    { key: 'rendered', flag: 'http-only', type: 'boolean', invert: true, default: true, help: 'Skip rendered observations; complexity remains unknown.' },
    integer('discoveryLimit', 'discovery-limit', 'Maximum routes inventoried (1-100, default 50).', 1, 100),
    integer('sampleLimit', 'sample-limit', 'Maximum routes fetched for observations (1-10, default 5).', 1, 10),
    integer('requestTimeoutMs', 'request-timeout', 'Per-request timeout in ms (1000-30000, default 10000).', 1000, 30000),
    integer('overallTimeoutMs', 'overall-timeout', 'Total inspection timeout in ms (1000-60000, default 30000).', 1000, 60000),
  ],
  compare: [
    boolean('screenshots', 'screenshots', 'Write source/liberated/diff PNG evidence. Pixel score never decides pass/fail.'),
    { key: 'stage', flag: 'stage', type: 'string', enum: ['capture', 'materialization', 'drift'], help: 'capture (default), materialization, or live-source drift.' },
    { key: 'profiles', flag: 'profiles', type: 'strings', help: 'Frozen document identities, comma-separated; default all declared cells.', metavar: 'ids' },
    { key: 'candidateUrl', flag: 'candidate', type: 'string', help: 'Compare the portable capture to another rendered copy.', metavar: 'url' },
    { key: 'motionContract', flag: 'motion-contract', type: 'json', help: 'With --stage drift --candidate, verify text, canvas-pointer and click behavior at named widths.' },
  ],
  publish: [
    { key: 'target', flag: 'to', type: 'string', default: 'spacefast', help: 'Publish target (default spacefast).', metavar: 'target' },
    { key: 'token', flag: 'token', type: 'string', default: () => process.env.SPACEFAST_TOKEN, help: 'Account token (or SPACEFAST_TOKEN), or anonymous space claim key. Without it returns a claim link.' },
    { key: 'space', flag: 'space', type: 'string', help: 'Existing space id to add a version to. Keep its account token or claim key.' },
  ],
};

function visible(d: OptionDescriptor, surface: 'cli' | 'mcp'): boolean {
  return !d.surfaces || d.surfaces.includes(surface);
}
function validate(d: OptionDescriptor, value: unknown, cli: boolean): unknown {
  const fail = (message: string): never => { throw new Error(`--${d.flag} requires ${message}`); };
  if (d.type === 'boolean') {
    if (typeof value !== 'boolean') return fail('a boolean');
    return cli && d.invert ? !value : value;
  }
  if (d.type === 'json') {
    const parsed = cli ? JSON.parse(readFileSync(String(value), 'utf8')) as unknown : value;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fail('a JSON object');
    return parsed;
  }
  if (d.type === 'strings') {
    const values = cli ? d.repeat ? value : String(value).split(',').map(v => v.trim()) : value;
    if (!Array.isArray(values) || values.some(v => typeof v !== 'string' || !v)) return fail('non-empty strings');
    return values;
  }
  if (d.type === 'count' && value === 'all') return value;
  if (d.type === 'integer' || d.type === 'count' || d.type === 'duration') {
    const n = cli ? d.type === 'duration' ? (d.min === 0 && /^0(?:ms|s|m|h)?$/.test(String(value)) ? 0 : parseDurationMs(String(value))) : Number(value) : value;
    const description = d.type === 'duration' ? 'a positive duration such as 30s or 30000ms' : d.type === 'count' ? 'a positive integer or "all"' : d.min === 1 && d.max === undefined ? 'a positive integer' : `an integer between ${d.min} and ${d.max}`;
    if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < (d.min ?? 1) || (d.max !== undefined && n > d.max)) return fail(description);
    return n;
  }
  if (typeof value !== 'string' || !value) return fail('a value');
  if (d.enum && !d.enum.includes(value)) return fail(d.enum.length === 3 ? `${d.enum[0]}, ${d.enum[1]} or ${d.enum[2]}` : d.enum.join(' or '));
  return value;
}
function convert(verb: Verb, input: Record<string, unknown>, surface: 'cli' | 'mcp'): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const d of options[verb]) {
    const value = input[surface === 'cli' ? d.flag : d.mcpKey ?? d.key];
    result[d.key] = value === undefined ? typeof d.default === 'function' ? d.default() : d.default : validate(d, value, surface === 'cli');
  }
  if (verb === 'liberate') {
    result.http = result.acquisition === 'http' || result.runtimeRouteLimit !== undefined ? { runtimeRouteLimit: result.runtimeRouteLimit } : undefined;
    delete result.runtimeRouteLimit;
  }
  return result;
}
export function convertMcpOptions(verb: Verb, input: Record<string, unknown>): Record<string, unknown> {
  const positional = verb === 'inspect' || verb === 'liberate' ? 'url' : 'directory';
  const known = new Set([positional, ...options[verb].filter(d => visible(d, 'mcp')).map(d => d.mcpKey ?? d.key)]);
  for (const key of Object.keys(input)) if (!known.has(key)) throw new Error(`Unknown ${verb} option: ${key}`);
  if (typeof input[positional] !== 'string' || !input[positional]) throw new Error(`${positional} required`);
  return convert(verb, input, 'mcp');
}

function distance(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) next.push(Math.min(next[j] + 1, row[j + 1] + 1, row[j] + (a[i] === b[j] ? 0 : 1)));
    row = next;
  }
  return row[b.length];
}
export function parseCliOptions(verb: Verb, args: string[]): { positional?: string; options: Record<string, unknown> } {
  const descriptors = options[verb].filter(d => visible(d, 'cli'));
  const config: ParseArgsConfig['options'] = Object.fromEntries(descriptors.map(d => [d.flag, { type: d.type === 'boolean' ? 'boolean' : 'string', multiple: d.repeat ?? false }]));
  let parsed;
  try {
    parsed = parseArgs({ args, options: config, strict: true, allowPositionals: true });
  } catch (error) {
    const failure = error as Error & { code?: string };
    if (failure.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
      const flag = failure.message.match(/Unknown option '([^']+)'/)?.[1] ?? '';
      const suggestion = descriptors.map(d => `--${d.flag}`).sort((a, b) => distance(flag, a) - distance(flag, b))[0];
      throw new Error(`${failure.message}${suggestion ? `. Did you mean ${suggestion}?` : ''}`);
    }
    // A negative numeric value is still a value, not an option. Let the shared
    // validator give the same diagnostic as MCP (parseArgs requires '=' here).
    if (failure.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
      const normalized = args.slice();
      const i = normalized.findIndex((v, i) => descriptors.some(d => `--${d.flag}` === v && d.type !== 'boolean') && /^-\d/.test(normalized[i + 1] ?? ''));
      if (i >= 0) { normalized.splice(i, 2, `${normalized[i]}=${normalized[i + 1]}`); return parseCliOptions(verb, normalized); }
    }
    throw error;
  }
  if (parsed.positionals.length > 1) throw new Error(`Unexpected argument: ${parsed.positionals[1]}`);
  return { positional: parsed.positionals[0], options: convert(verb, parsed.values, 'cli') };
}

export function mcpInputSchema(verb: Verb) {
  const positional = verb === 'inspect' || verb === 'liberate' ? 'url' : 'directory';
  const properties: Record<string, unknown> = { [positional]: { type: 'string', description: positional === 'url' ? 'Source site URL.' : 'Liberated run directory.' } };
  for (const d of options[verb].filter(d => visible(d, 'mcp'))) {
    const numeric = { type: 'integer', minimum: d.min ?? 1, ...(d.max === undefined ? {} : { maximum: d.max }) };
    const schema = d.type === 'count' ? { anyOf: [numeric, { type: 'string', enum: ['all'] }] }
      : d.type === 'integer' || d.type === 'duration' ? numeric
      : d.type === 'strings' ? { type: 'array', items: { type: 'string' } }
      : { type: d.type === 'json' ? 'object' : d.type, ...(d.enum ? { enum: d.enum } : {}) };
    properties[d.mcpKey ?? d.key] = { ...schema, description: d.help, ...(d.default !== undefined && typeof d.default !== 'function' ? { default: d.default } : {}) };
  }
  return { type: 'object' as const, properties, required: [positional], additionalProperties: false };
}
export const HELP = `
  data-liberation — Liberate any website into a complete, portable HTML site

  Usage:
    data-liberation <url>              Liberate a website
    data-liberation inspect <url>      Assess a source without writing a site
    data-liberation compare <dir>      Verify a liberated copy
    data-liberation publish <dir>      Publish a liberated site
    data-liberation mcp                Start MCP server (stdio transport)
    data-liberation --version          Show version
    data-liberation --help             Show usage
${(Object.keys(options) as Verb[]).map(verb => `
  ${verb[0].toUpperCase() + verb.slice(1)} options:
${options[verb].filter(d => visible(d, 'cli')).map(d => {
  const label = d.type === 'boolean' ? '' : ` <${d.metavar ?? (d.type === 'count' ? 'n|all' : d.type === 'integer' ? 'n' : d.type === 'duration' ? 'duration' : d.type === 'json' ? 'json' : 'value')}>`;
  return `    --${d.flag}${label}  ${d.help}`;
}).join('\n')}`).join('\n')}

  Environment:
    DLA_OUTPUT_DIR       Default output base directory
    SPACEFAST_TOKEN      Publish token for the spacefast target
`;
