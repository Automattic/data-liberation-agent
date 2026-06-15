// src/lib/replicate/local-data/validate-model.ts
//
// Validate an agent-authored DataModel before it drives CPT registration + post
// insertion + query-loop injection. Mirrors the gate idea from
// wordpress-block-design-compiler's validateContentModel, adapted to this
// project's DataModel shape (one CPT + one taxonomy + fields + items + mounts +
// card). The converter runs this and, on errors, SKIPS the data path (warn-only,
// never aborts the whole conversion) so a malformed model degrades visibly
// instead of installing a broken type or clobbering content.
import type {
  DataModel,
  DataFieldType,
  DataFieldFormat,
} from './types.js';
import { DATA_MODEL_SCHEMA } from './types.js';

const POST_TYPE_MAX = 20;
const TAXONOMY_MAX = 32;
const FIELD_TYPES: ReadonlySet<DataFieldType> = new Set(['string', 'integer', 'number', 'boolean']);
const FIELD_FORMATS: ReadonlySet<DataFieldFormat> = new Set(['email', 'url', 'textarea', 'date']);
const RESERVED_POST_TYPES = new Set([
  'post', 'page', 'attachment', 'revision', 'nav_menu_item', 'wp_block', 'wp_template', 'wp_template_part',
]);
const RESERVED_TAXONOMIES = new Set(['category', 'post_tag', 'nav_menu', 'link_category', 'post_format']);

export interface ValidateModelResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  counts: { fields: number; items: number; terms: number; mounts: number };
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

function checkSlug(value: string, kind: string, max: number, errors: string[]): void {
  if (!value) {
    errors.push(`${kind} slug is required.`);
    return;
  }
  if (value.length > max) errors.push(`${kind} slug "${value}" is ${value.length} chars; WordPress max is ${max}.`);
  if (!SLUG_RE.test(value)) errors.push(`${kind} slug must be lowercase letters/numbers/-/_ : ${value}`);
}

/**
 * Validate a DataModel. Pure (no IO) — returns errors/warnings/counts. The
 * model is treated as untrusted (agent-authored); every cross-reference is
 * checked so install never silently drops data.
 */
export function validateDataModel(model: DataModel): ValidateModelResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!model || typeof model !== 'object') {
    return { valid: false, errors: ['model is not an object.'], warnings: [], counts: { fields: 0, items: 0, terms: 0, mounts: 0 } };
  }

  if (model.schema !== DATA_MODEL_SCHEMA) {
    warnings.push(`schema is ${model.schema ?? '(absent)'}; current is ${DATA_MODEL_SCHEMA}.`);
  }

  // CPT
  const cpt = model.cpt;
  if (!cpt?.slug) {
    errors.push('cpt.slug is required.');
  } else {
    checkSlug(cpt.slug, 'cpt', POST_TYPE_MAX, errors);
    if (RESERVED_POST_TYPES.has(cpt.slug)) errors.push(`cpt.slug is reserved by WordPress: ${cpt.slug}`);
  }

  // Taxonomy
  const tax = model.taxonomy;
  const termSlugs = new Set<string>();
  if (!tax?.slug) {
    errors.push('taxonomy.slug is required.');
  } else {
    checkSlug(tax.slug, 'taxonomy', TAXONOMY_MAX, errors);
    if (RESERVED_TAXONOMIES.has(tax.slug)) errors.push(`taxonomy.slug is reserved by WordPress: ${tax.slug}`);
    for (const t of tax.terms ?? []) {
      if (!t.slug) errors.push('taxonomy term is missing a slug.');
      else if (termSlugs.has(t.slug)) errors.push(`duplicate taxonomy term slug: ${t.slug}`);
      termSlugs.add(t.slug);
    }
  }

  // Fields
  const fieldKeys = new Set<string>();
  for (const f of model.fields ?? []) {
    if (!f.key) errors.push('field key is required.');
    else if (!KEY_RE.test(f.key)) errors.push(`field key must be alphanumeric/_/- : ${f.key}`);
    if (fieldKeys.has(f.key)) errors.push(`duplicate field key: ${f.key}`);
    fieldKeys.add(f.key);
    if (!FIELD_TYPES.has(f.type)) errors.push(`field ${f.key} type must be one of ${[...FIELD_TYPES].join(', ')}.`);
    if (f.format && !FIELD_FORMATS.has(f.format)) errors.push(`field ${f.key} format must be one of ${[...FIELD_FORMATS].join(', ')}.`);
    if (f.format && f.type !== 'string') warnings.push(`field ${f.key} has format "${f.format}" but type "${f.type}" (format applies to string fields).`);
  }

  // Items
  const itemIds = new Set<string>();
  for (const it of model.items ?? []) {
    if (!it.id) errors.push('item is missing an id.');
    else if (itemIds.has(it.id)) errors.push(`duplicate item id: ${it.id}`);
    itemIds.add(it.id);
    if (!it.title) warnings.push(`item ${it.id} has no title.`);
    for (const key of Object.keys(it.meta ?? {})) {
      if (!fieldKeys.has(key)) warnings.push(`item ${it.id} sets undeclared meta key: ${key}`);
    }
    for (const term of it.terms ?? []) {
      if (!termSlugs.has(term)) warnings.push(`item ${it.id} references unknown taxonomy term: ${term}`);
    }
  }

  // Mounts
  for (const m of model.mounts ?? []) {
    if (!/^[#.][\w-]+$/.test(m.selector ?? '')) warnings.push(`mount selector is not a simple #id/.class: ${m.selector}`);
    if (cpt?.slug && m.query?.postType && m.query.postType !== cpt.slug) {
      warnings.push(`mount ${m.selector} queries postType "${m.query.postType}" ≠ cpt.slug "${cpt.slug}".`);
    }
  }

  // Card template references (every map.<name> and meta.<key> used must exist).
  if (model.card?.template) {
    const tpl = model.card.template;
    const maps = model.card.maps ?? {};
    for (const mref of tpl.matchAll(/map\.([A-Za-z0-9_]+)\./g)) {
      if (!(mref[1] in maps)) errors.push(`card template references undefined map: ${mref[1]}`);
    }
    for (const fref of tpl.matchAll(/meta\.([A-Za-z0-9_]+)/g)) {
      if (!fieldKeys.has(fref[1])) warnings.push(`card template references undeclared meta key: ${fref[1]}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    counts: {
      fields: model.fields?.length ?? 0,
      items: model.items?.length ?? 0,
      terms: tax?.terms?.length ?? 0,
      mounts: model.mounts?.length ?? 0,
    },
  };
}
