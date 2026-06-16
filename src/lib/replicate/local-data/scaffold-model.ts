import { runInNewContext } from 'node:vm';
import { DATA_MODEL_SCHEMA, type DataModel, type DataItem, type MountSpec } from './types.js';
import { validateDataModel } from './validate-model.js';
import {
  discoverDataArrays,
  discoverIdLookups,
  discoverMounts,
  parseProgram,
  walk,
  type DiscoveredArray,
  type DiscoveredMount,
} from './discover-js-data.js';
import { inferFields } from './infer-fields.js';
import type { DiscoveredArrayInfo, ScaffoldResult, ScaffoldTodo } from './scaffold-types.js';

export interface ScaffoldInput {
  html: string;
  js: string;
  skippedFiles?: string[];
}

const MAX_FALLBACK_ARRAY_CHARS = 200_000;

const slugify = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const singular = (value: string): string => value.replace(/s$/i, '');
const titleCase = (value: string): string => value.replace(/[-_]+/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase()).trim();
const scalar = (value: unknown): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value);

export function scaffoldDataModel(input: ScaffoldInput): ScaffoldResult {
  const todos: ScaffoldTodo[] = [];
  const arrays = discoverScaffoldArrays(input.js);
  const idLookupNames = discoverIdLookups(input.js);
  const discoveredMounts = discoverMounts(input.html, input.js);
  const discoveredArrays: DiscoveredArrayInfo[] = arrays.map((array) => ({
    name: array.name,
    confidence: array.confidence,
    recordCount: array.records?.length,
    reason: array.confidence === 'low' ? array.evidence.slice(0, 120) : undefined,
  }));
  const discovered = {
    arrays: discoveredArrays,
    skippedFiles: input.skippedFiles ?? [],
    unmatchedContainers: discoveredMounts
      .filter((mount) => mount.confidence === 'low' || !mount.sourceCall)
      .map((mount) => mount.selector),
  };
  const primary = choosePrimaryArray(arrays, idLookupNames, discoveredMounts);

  if (!primary?.records) {
    const empty = emptyModel();
    todos.push({
      path: 'items',
      instruction: 'No static data array literal was found (data may be fetched or built procedurally). Author items[] and the model by hand from the source.',
      evidence: arrays[0]?.evidence ?? '(no array-like declarations found)',
    });
    return { model: empty, skillTodos: todos, discovered, validation: validateDataModel(empty) };
  }

  const records = primary.records;
  const inferred = inferFields(records);
  const typeNoun = singular(primary.name === '(anonymous)' ? 'item' : primary.name).toLowerCase();
  const cptSlug = slugify(typeNoun) || 'item';

  const termSet = new Map<string, string>();
  if (inferred.termKey) {
    for (const record of records) {
      const termValue = record[inferred.termKey];
      if (typeof termValue === 'string') termSet.set(slugify(termValue), titleCase(termValue));
    }
  }

  const items: DataItem[] = records.map((record) => {
    const meta: Record<string, string | number | boolean> = {};
    for (const field of inferred.fields) {
      const value = record[field.key];
      if (scalar(value)) meta[field.key] = value;
    }

    const galleryRaw = inferred.galleryKey ? record[inferred.galleryKey] : undefined;
    const gallery = Array.isArray(galleryRaw)
      ? galleryRaw.map((entry) => {
          if (typeof entry === 'string') return { caption: entry };
          const image = entry as { caption?: unknown; url?: string };
          return { caption: String(image.caption ?? ''), url: image.url };
        })
      : [];
    const termValue = inferred.termKey ? record[inferred.termKey] : undefined;
    const idValue = record[inferred.idKey];

    return {
      id: scalar(idValue) ? String(idValue) : '',
      title: String(record[inferred.titleKey] ?? ''),
      terms: typeof termValue === 'string' ? [slugify(termValue)] : [],
      meta,
      gallery,
      content: inferred.contentKey ? String(record[inferred.contentKey] ?? '') : undefined,
    };
  });

  const mounts: MountSpec[] = [];
  for (const mount of discoveredMounts) {
    if (mount.confidence !== 'high' || !mount.sourceCall) continue;
    const index = mounts.length;
    todos.push({
      path: `mounts[${index}].query.order`,
      instruction: `Confirm ordering/perPage for ${mount.selector}; source call: "${mount.sourceCall}". Default applied: date/DESC. Adjust to match the source's selection semantics.`,
      evidence: mount.evidence,
    });
    mounts.push({
      selector: mount.selector,
      sourceCall: mount.sourceCall,
      query: { postType: cptSlug, perPage: mount.perPageHint ?? -1, orderBy: 'date', order: 'DESC' },
      wrapperClass: mount.wrapperClass,
    });
  }

  todos.unshift({
    path: 'card.template',
    instruction: 'Author card.template: rewrite the source per-item card function into a single-root skeleton with data-dla-* bindings (data-dla-text/attr/class/if), preserving the source classes. Reference: id, title, content, cat.slug, cat.label, meta.<key>, gallery.<n>.caption, map.<name>.<expr>. Add any value-keyed lookups to card.maps.',
    evidence: extractCardFn(input.js),
  });

  if (inferred.confidence.id === 'low') {
    todos.push({
      path: 'items[].id',
      instruction: `The id field was guessed ('${inferred.idKey}') and may be non-unique or non-scalar; confirm/choose the stable per-item id (it is the idempotency key for inserts).`,
      evidence: `record keys: ${Object.keys(records[0] ?? {}).join(', ')}`,
    });
  }
  if (inferred.confidence.title === 'low') {
    todos.push({
      path: 'items[].title',
      instruction: `Title was guessed ('${inferred.titleKey}') with no name match; confirm it is the human title.`,
      evidence: `record keys: ${Object.keys(records[0] ?? {}).join(', ')}`,
    });
  }
  if (inferred.confidence.terms === 'low' && inferred.termKey) {
    todos.push({
      path: 'taxonomy',
      instruction: `Taxonomy column was guessed ('${inferred.termKey}') by low cardinality; confirm it is a content category.`,
      evidence: `distinct: ${[...termSet.keys()].join(', ')}`,
    });
  }

  const model: DataModel = {
    cpt: {
      slug: cptSlug,
      singular: titleCase(typeNoun),
      plural: titleCase((primary.name === '(anonymous)' ? 'items' : primary.name).toLowerCase()),
      public: true,
      supports: ['title', 'editor', 'custom-fields'],
    },
    taxonomy: { slug: `${cptSlug}_cat`, label: 'Categories', hierarchical: true, terms: [...termSet].map(([slug, label]) => ({ slug, label })) },
    fields: inferred.fields,
    items,
    mounts,
    card: { template: '', maps: {} },
    sourceArrays: [...new Set([...idLookupNames, primary.name].filter((name) => name && name !== '(anonymous)'))],
    schema: DATA_MODEL_SCHEMA,
  };

  return { model, skillTodos: todos, discovered, validation: validateDataModel(model) };
}

function choosePrimaryArray(
  arrays: DiscoveredArray[],
  idLookupNames: string[],
  mounts: DiscoveredMount[]
): DiscoveredArray | undefined {
  const candidates = arrays.filter((array) => array.records?.length);
  if (candidates.length === 0) return undefined;

  const idLookupSet = new Set(idLookupNames);
  const byIdLookup = candidates.find((array) => idLookupSet.has(array.name));
  if (byIdLookup) return byIdLookup;

  const sourceCalls = mounts.map((mount) => mount.sourceCall).filter((sourceCall): sourceCall is string => Boolean(sourceCall));
  const byMountSource = candidates.find((array) => sourceCalls.some((sourceCall) => containsIdentifier(sourceCall, array.name)));
  if (byMountSource) return byMountSource;

  return candidates.reduce((best, array) => ((array.records?.length ?? 0) > (best.records?.length ?? 0) ? array : best));
}

function containsIdentifier(source: string, identifier: string): boolean {
  if (!/^[A-Za-z_$][\w$]*$/.test(identifier)) return false;
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9_$])${escaped}($|[^A-Za-z0-9_$])`).test(source);
}

function emptyModel(): DataModel {
  return {
    cpt: { slug: 'item', singular: 'Item', plural: 'Items', public: true, supports: ['title', 'editor', 'custom-fields'] },
    taxonomy: { slug: 'item_cat', label: 'Categories', hierarchical: true, terms: [] },
    fields: [],
    items: [],
    mounts: [],
    card: { template: '', maps: {} },
    sourceArrays: [],
    schema: DATA_MODEL_SCHEMA,
  };
}

function discoverScaffoldArrays(js: string): DiscoveredArray[] {
  const strictArrays = discoverDataArrays(js);
  if (strictArrays.some((array) => array.records?.length)) return strictArrays;
  return [...strictArrays, ...discoverStaticObjectArrays(js, strictArrays)];
}

function discoverStaticObjectArrays(js: string, existing: DiscoveredArray[]): DiscoveredArray[] {
  const ast = parseProgram(js);
  if (!ast) return [];
  const existingEvidence = new Set(existing.map((array) => array.evidence));
  const arrays: DiscoveredArray[] = [];
  const seen = new Set<number>();

  const consider = (node: any, name: string): void => {
    if (!looksLikeObjectArray(node) || seen.has(node.start)) return;
    seen.add(node.start);
    const evidence = evidenceFor(js, node);
    if (existingEvidence.has(evidence)) return;
    const evaluated = evalStaticArray(js, node, evidence);
    arrays.push({ name, ...evaluated });
  };

  walk(ast, (node: any) => {
    if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier') consider(node.init, node.id.name);
    if (node.type === 'AssignmentExpression') {
      const left = node.left;
      const hint = left?.type === 'Identifier' ? left.name : left?.property?.name;
      consider(node.right, hint ?? '(anonymous)');
    }
    if (node.type === 'Property') consider(node.value, String(node.key?.name ?? node.key?.value ?? '(anonymous)'));
  });

  return arrays;
}

function looksLikeObjectArray(node: any): boolean {
  return Boolean(
    node?.type === 'ArrayExpression' &&
      node.elements?.length > 0 &&
      node.elements.every((element: any) => element?.type === 'ObjectExpression')
  );
}

function isStaticLiteral(node: any): boolean {
  if (!node) return false;
  if (node.type === 'Literal') return true;
  if (node.type === 'ArrayExpression') return (node.elements ?? []).every((element: any) => element === null || isStaticLiteral(element));
  if (node.type === 'ObjectExpression') {
    return (node.properties ?? []).every((property: any) => {
      if (!property || property.type !== 'Property' || property.kind !== 'init' || property.method || property.shorthand) return false;
      if (property.computed && !isStaticLiteral(property.key)) return false;
      return isStaticLiteral(property.value);
    });
  }
  if (node.type === 'UnaryExpression' && ['-', '+', '!', '~'].includes(node.operator)) return isStaticLiteral(node.argument);
  if (node.type === 'TemplateLiteral') return (node.expressions ?? []).length === 0;
  return false;
}

function evalStaticArray(
  js: string,
  node: any,
  evidence: string
): Pick<DiscoveredArray, 'records' | 'confidence' | 'evidence'> {
  const slice = js.slice(node.start, node.end);
  if (slice.length > MAX_FALLBACK_ARRAY_CHARS) return { confidence: 'low', evidence: `literal too large (${slice.length} chars) :: ${evidence}` };
  if (!isStaticLiteral(node)) return { confidence: 'low', evidence };
  try {
    const records = runInNewContext(`(${slice})`, Object.create(null), { timeout: 1000 }) as Array<Record<string, unknown>>;
    if (!Array.isArray(records)) return { confidence: 'low', evidence };
    return { records, confidence: 'high', evidence };
  } catch (error) {
    return { confidence: 'low', evidence: `${(error as Error).message} :: ${evidence}` };
  }
}

function evidenceFor(js: string, node: any): string {
  const slice = js.slice(node.start, node.end);
  return slice.length > 400 ? `${slice.slice(0, 400)}...` : slice;
}

function extractCardFn(js: string): string {
  const match = js.match(/function\s+\w*[Cc]ard\s*\([^)]*\)\s*\{[\s\S]*?\}/);
  if (!match) return '(no *Card function found; author from the rendered card markup)';
  return match[0].length > 600 ? `${match[0].slice(0, 600)}...` : match[0];
}
