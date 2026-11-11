import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { options, parseCliOptions, convertMcpOptions, mcpInputSchema, HELP, type Verb } from './options.js';

describe('shared option contract', () => {
  it('every descriptor parses identically through CLI and MCP, including defaults', () => {
    const directory = mkdtempSync('.options-test-');
    const jsonPath = join(directory, 'recipe.json');
    writeFileSync(jsonPath, JSON.stringify({ routes: [] }));
    try {
      for (const verb of Object.keys(options) as Verb[]) {
        const positionalKey = verb === 'liberate' || verb === 'inspect' ? 'url' : 'directory';
        const positional = positionalKey === 'url' ? 'https://example.com/' : './run';
        expect(parseCliOptions(verb, [positional]).options).toEqual(convertMcpOptions(verb, { [positionalKey]: positional }));
        const schema = mcpInputSchema(verb);
        for (const d of options[verb]) {
          expect(HELP).toContain(`--${d.flag}`);
          if (d.surfaces && !d.surfaces.includes('mcp')) {
            expect(schema.properties).not.toHaveProperty(d.mcpKey ?? d.key);
            expect(() => convertMcpOptions(verb, { [positionalKey]: positional, [d.key]: true })).toThrow('Unknown');
            expect(parseCliOptions(verb, [positional, `--${d.flag}`]).options[d.key]).toBe(true);
            continue;
          }
          expect(schema.properties).toHaveProperty(d.mcpKey ?? d.key);
          const value = d.type === 'boolean' ? !d.invert
            : d.type === 'json' ? { routes: [] }
            : d.type === 'strings' ? ['https://example.com', 'https://other.example.com']
            : d.type === 'duration' ? 30000
            : d.type === 'integer' || d.type === 'count' ? Math.max(d.min ?? 1, 2)
            : d.enum?.[0] ?? 'test-value';
          const cliValue = d.type === 'json' ? jsonPath : d.type === 'duration' ? '30s' : String(value);
          const flags = d.type === 'boolean' ? [`--${d.flag}`]
            : d.type === 'strings' ? d.repeat ? (value as string[]).flatMap(v => [`--${d.flag}`, v]) : [`--${d.flag}`, (value as string[]).join(',')]
            : [`--${d.flag}`, cliValue];
          expect(parseCliOptions(verb, [...flags, positional]).options, `${verb}.${d.key}`).toEqual(convertMcpOptions(verb, { [positionalKey]: positional, [d.mcpKey ?? d.key]: value }));
          if (d.type === 'count') {
            expect(parseCliOptions(verb, [positional, `--${d.flag}`, 'all']).options).toEqual(convertMcpOptions(verb, { [positionalKey]: positional, [d.key]: 'all' }));
          }
          if (d.type === 'integer' || d.type === 'count' || d.type === 'duration') {
            for (const invalid of [NaN, Infinity, -1, 1.5]) {
              expect(() => convertMcpOptions(verb, { [positionalKey]: positional, [d.key]: invalid }), `${verb}.${d.key}=${invalid}`).toThrow(`--${d.flag} requires`);
            }
            expect(() => parseCliOptions(verb, [positional, `--${d.flag}`, 'NaN'])).toThrow(`--${d.flag} requires`);
          }
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects unknown flags before interpreting their values as a URL', () => {
    expect(() => parseCliOptions('liberate', ['--route-limt', '5', 'https://example.com'])).toThrow('Did you mean --route-limit?');
    expect(() => parseCliOptions('inspect', ['https://example.com', '--sample-limt', '5'])).toThrow('Did you mean --sample-limit?');
  });

  it('rejects missing values, extra positionals and out-of-range numbers', () => {
    expect(() => parseCliOptions('compare', ['./run', '--candidate'])).toThrow();
    expect(() => parseCliOptions('liberate', ['https://example.com', 'extra'])).toThrow('Unexpected argument');
    expect(() => parseCliOptions('inspect', ['https://example.com', '--sample-limit', '11'])).toThrow('--sample-limit requires');
    expect(() => parseCliOptions('liberate', ['https://example.com', '--runtime-route-limit', '51'])).toThrow('--runtime-route-limit requires');
  });
});
