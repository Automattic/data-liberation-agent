import { normalize } from 'node:path';

import type {
  FoundationAggregates,
  FoundationTokens,
  ThemeBuildResult,
} from '@automattic/blocks-engine/theme';
import type { ReplicaFile } from '../../preview/types.js';
import {
  assembleLocalTheme,
  type CarrySourceAssets,
} from './theme-files.js';
import {
  buildLocalFoundation,
  extractCssColors,
  type BreakpointsAgg,
  type CssColorCount,
  type PaletteAgg,
  type TypographyAgg,
} from './foundation.js';

type TokenValue = { value?: string | null };

export interface DlaFoundationInput {
  palette?: PaletteAgg;
  typography?: TypographyAgg;
  breakpoints?: BreakpointsAgg;
  cssSources?: string[];
  cssColors?: CssColorCount[];
}

export interface EngineFoundationTranslation {
  foundationAggregates: FoundationAggregates;
  tokens: FoundationTokens;
}

export interface DlaFunctionsPhpOptions {
  siteTitle: string;
  themeSlug: string;
  carrySourceAssets?: CarrySourceAssets;
  instanceStylesCss?: string;
  jetpackFormParityCss?: string;
  bodyDataByPath?: Record<string, Record<string, string>>;
}

export interface EngineThemeHostFiles {
  themeFiles: ReplicaFile[];
  assetSourceDir: string;
  assetFiles: string[];
  writtenThemeFiles: string[];
}

export function translateDlaFoundationToEngine(input: DlaFoundationInput): EngineFoundationTranslation {
  const cssColors = input.cssColors ?? (input.cssSources ? extractCssColors(input.cssSources) : undefined);
  const local = buildLocalFoundation(
    {
      palette: input.palette ?? emptyPalette(),
      typography: input.typography ?? emptyTypography(),
      breakpoints: input.breakpoints ?? emptyBreakpoints(),
    },
    cssColors ? { cssColors } : undefined,
  );
  const foundation = local.foundation;
  const palette = [
    paletteToken('Surface Base', foundation.color?.surface?.base),
    paletteToken('Surface Inverse', foundation.color?.surface?.inverse),
    paletteToken('Text Default', foundation.color?.text?.default),
    paletteToken('Text Inverse', foundation.color?.text?.inverse),
    paletteToken('Accent Primary', foundation.color?.accent?.primary),
  ].filter((entry): entry is FoundationTokens['palette'][number] => entry !== null);
  const tokens: FoundationTokens = {
    palette,
    typography: {
      ...stringProp('body', foundation.typography?.families?.body?.value),
      ...stringProp('display', foundation.typography?.families?.display?.value),
    },
    breakpoints: {
      ...stringProp('md', foundation.breakpoints?.md),
      ...stringProp('lg', foundation.breakpoints?.lg),
      ...stringProp('xl', foundation.breakpoints?.xl),
    },
  };

  return {
    tokens,
    foundationAggregates: {
      palette: tokens.palette,
      typography: tokens.typography,
      breakpoints: tokens.breakpoints,
    },
  };
}

export function buildDlaFunctionsPhpContent(options: DlaFunctionsPhpOptions): string {
  const file = assembleLocalTheme({
    siteTitle: options.siteTitle,
    themeSlug: options.themeSlug,
    headerPart: '',
    footerPart: '',
    carrySourceAssets: options.carrySourceAssets,
    instanceStylesCss: options.instanceStylesCss,
    jetpackFormParityCss: options.jetpackFormParityCss,
    bodyDataByPath: options.bodyDataByPath,
  }).find((candidate) => candidate.relativePath === 'functions.php');

  if (!file) throw new Error('DLA theme assembly did not emit functions.php');
  return file.content;
}

export function engineThemeResultToHostFiles(
  result: Pick<ThemeBuildResult, 'outDir' | 'model' | 'written'>,
  options: { functionsPhp: string },
): EngineThemeHostFiles {
  const themeFiles = [
    { relativePath: 'style.css', content: result.model.styleCss },
    { relativePath: 'theme.json', content: JSON.stringify(result.model.themeJson, null, 2) + '\n' },
    ...recordFiles('templates', result.model.templates),
    ...recordFiles('parts', result.model.parts),
    ...recordFiles('patterns', result.model.patterns),
    { relativePath: 'functions.php', content: options.functionsPhp },
  ];
  const normalizedWritten = result.written.map(normalizeThemePath);
  const assetFiles = [...new Set(normalizedWritten.filter((path) => path.startsWith('assets/')))].sort();

  return {
    themeFiles,
    assetSourceDir: result.outDir,
    assetFiles,
    writtenThemeFiles: themeFiles.map((file) => file.relativePath),
  };
}

function paletteToken(name: string, role: TokenValue | undefined): FoundationTokens['palette'][number] | null {
  const color = role?.value?.trim();
  return color ? { name, color } : null;
}

function stringProp<K extends string>(key: K, value: string | undefined): Partial<Record<K, string>> {
  const trimmed = value?.trim();
  return trimmed ? { [key]: trimmed } as Partial<Record<K, string>> : {};
}

function recordFiles(baseDir: string, files: Record<string, string>): ReplicaFile[] {
  return Object.entries(files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, content]) => ({
      relativePath: recordRelativePath(baseDir, key),
      content,
    }));
}

function recordRelativePath(baseDir: string, key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith(`${baseDir}/`) || trimmed.includes('/')) return normalizeThemePath(trimmed);
  const filename = /\.[a-z0-9]+$/i.test(trimmed) ? trimmed : `${trimmed}.html`;
  return normalizeThemePath(`${baseDir}/${filename}`);
}

function normalizeThemePath(path: string): string {
  const input = path.replace(/\\/g, '/');
  const normalized = normalize(input).replace(/\\/g, '/');
  if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../') || input.startsWith('/')) {
    throw new Error(`theme path must stay relative: ${path}`);
  }
  return normalized;
}

function emptyPalette(): PaletteAgg {
  return { version: 1, sampledUrls: 0, colors: [] };
}

function emptyTypography(): TypographyAgg {
  return { version: 1, sampledUrls: 0, bySelector: {} };
}

function emptyBreakpoints(): BreakpointsAgg {
  return { version: 1, sampledUrls: 0, minWidth: [], maxWidth: [] };
}
