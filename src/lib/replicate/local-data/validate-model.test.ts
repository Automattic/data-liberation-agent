// src/lib/replicate/local-data/validate-model.test.ts
import { describe, it, expect } from 'vitest';
import { validateDataModel } from './validate-model.js';
import { DATA_MODEL_SCHEMA, type DataModel } from './types.js';

function model(over: Partial<DataModel> = {}): DataModel {
  return {
    cpt: { slug: 'objet', singular: 'Objet', plural: 'Objets', public: true, supports: ['title', 'editor'] },
    taxonomy: {
      slug: 'objet_cat', label: 'Categories', hierarchical: true,
      terms: [{ slug: 'glass', label: 'Glass' }, { slug: 'textiles', label: 'Textiles' }],
    },
    fields: [{ key: 'price_eur', type: 'integer' }, { key: 'story', type: 'string', format: 'textarea' }],
    items: [{ id: 'a-1', title: 'A', terms: ['glass'], meta: { price_eur: 12 }, gallery: [] }],
    mounts: [{ selector: '#g', sourceCall: '', query: { postType: 'objet', perPage: 4 } }],
    card: { template: '<article data-dla-class="map.TONE.cat.slug" data-dla-text="meta.price_eur"></article>', maps: { TONE: { glass: 't' } } },
    sourceArrays: ['OBJETS'],
    schema: DATA_MODEL_SCHEMA,
    ...over,
  };
}

describe('validateDataModel', () => {
  it('accepts a well-formed model', () => {
    const r = validateDataModel(model());
    expect(r.valid).toBe(true);
    expect(r.errors).toEqual([]);
    expect(r.counts).toEqual({ fields: 2, items: 1, terms: 2, mounts: 1 });
  });

  it('rejects reserved + malformed cpt/taxonomy slugs', () => {
    const r = validateDataModel(model({
      cpt: { slug: 'post', singular: 'P', plural: 'P', public: true, supports: [] },
      taxonomy: { slug: 'Category!', label: '', hierarchical: true, terms: [] },
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /reserved/.test(e))).toBe(true);
    expect(r.errors.some((e) => /lowercase/.test(e))).toBe(true);
  });

  it('flags duplicate field keys, item ids, and term slugs', () => {
    const r = validateDataModel(model({
      fields: [{ key: 'p', type: 'integer' }, { key: 'p', type: 'string' }],
      items: [
        { id: 'x', title: 'X', terms: [], meta: {}, gallery: [] },
        { id: 'x', title: 'Y', terms: [], meta: {}, gallery: [] },
      ],
      taxonomy: { slug: 'objet_cat', label: 'C', hierarchical: true, terms: [{ slug: 'g', label: 'G' }, { slug: 'g', label: 'G2' }] },
    }));
    expect(r.errors).toEqual(expect.arrayContaining([
      expect.stringMatching(/duplicate field key: p/),
      expect.stringMatching(/duplicate item id: x/),
      expect.stringMatching(/duplicate taxonomy term slug: g/),
    ]));
  });

  it('errors on bad field type/format and warns on format-on-non-string', () => {
    const r = validateDataModel(model({
      fields: [{ key: 'a', type: 'weird' as never }, { key: 'b', type: 'integer', format: 'email' }],
    }));
    expect(r.errors.some((e) => /type must be one of/.test(e))).toBe(true);
    expect(r.warnings.some((w) => /format "email" but type "integer"/.test(w))).toBe(true);
  });

  it('warns on undeclared meta keys, unknown terms, and postType mismatch', () => {
    const r = validateDataModel(model({
      items: [{ id: 'a', title: 'A', terms: ['nope'], meta: { ghost: 1 }, gallery: [] }],
      mounts: [{ selector: '#g', sourceCall: '', query: { postType: 'widget', perPage: 1 } }],
    }));
    expect(r.valid).toBe(true); // these are warnings, not errors
    expect(r.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/undeclared meta key: ghost/),
      expect.stringMatching(/unknown taxonomy term: nope/),
      expect.stringMatching(/queries postType "widget"/),
    ]));
  });

  it('errors when the card template references an undefined map', () => {
    const r = validateDataModel(model({
      card: { template: '<article data-dla-class="map.MISSING.cat.slug"></article>', maps: {} },
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => /undefined map: MISSING/.test(e))).toBe(true);
  });

  it('warns when the card template references an undeclared meta key', () => {
    const r = validateDataModel(model({
      card: { template: '<article data-dla-text="meta.nope"></article>', maps: {} },
    }));
    expect(r.warnings.some((w) => /undeclared meta key: nope/.test(w))).toBe(true);
  });
});
