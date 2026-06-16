import { describe, it, expect } from 'vitest';
import { scaffoldDataModel } from './scaffold-model.js';

const HTML = `<main><div class="obj-grid obj-grid--4" id="newestGrid"></div></main>`;
const JS = `
  const OBJETS = [
    { id: 'opaline-1965', title: 'Opaline Vase', story: 'A sufficiently long provenance description that reads as body content here.', category: 'glass', price: 120 },
    { id: 'boutis-quilt', title: 'Boutis Coverlet', story: 'Another long provenance description well past the content length threshold value.', category: 'textiles', price: 240 },
  ];
  function objCard(o){ return '<article class="obj-card"></article>'; }
  function open(id){ return OBJETS.find(x => x.id === id); }
  mountGrid('#newestGrid', newestObjets(4));
`;

describe('scaffoldDataModel', () => {
  it('fills items, taxonomy, fields, mounts, sourceArrays deterministically', () => {
    const { model, discovered } = scaffoldDataModel({ html: HTML, js: JS });
    expect(model.items.map((i) => i.id)).toEqual(['opaline-1965', 'boutis-quilt']);
    expect(model.items[0].meta).toEqual({ price: 120 });
    expect(model.items[0].content).toContain('provenance');
    expect(model.taxonomy.terms.map((t) => t.slug).sort()).toEqual(['glass', 'textiles']);
    expect(model.fields).toContainEqual({ key: 'price', type: 'integer' });
    expect(model.mounts[0]).toMatchObject({
      selector: '#newestGrid',
      wrapperClass: 'obj-grid obj-grid--4',
      query: { postType: model.cpt.slug, perPage: 4 },
    });
    expect(model.sourceArrays).toContain('OBJETS');
    expect(discovered.arrays.find((a) => a.name === 'OBJETS')?.recordCount).toBe(2);
  });

  it('leaves card.template empty with a todo, and a query-order todo', () => {
    const { model, skillTodos } = scaffoldDataModel({ html: HTML, js: JS });
    expect(model.card?.template).toBe('');
    expect(skillTodos.some((t) => t.path === 'card.template')).toBe(true);
    expect(skillTodos.some((t) => t.path.startsWith('mounts[0].query.order'))).toBe(true);
  });

  it('emits an items[].id todo when id inference is low-confidence', () => {
    const js = `const A = [{ ref: { x: 1 } }, { ref: { x: 2 } }]; mount('#g', A);`;
    const { skillTodos } = scaffoldDataModel({ html: `<div id="g"></div>`, js });
    expect(skillTodos.some((t) => t.path === 'items[].id')).toBe(true);
  });

  it('degrades to an items todo (never invents) when no static array is found', () => {
    const { model, skillTodos } = scaffoldDataModel({ html: '<div id="g"></div>', js: `fetch('/api').then(r=>r.json());` });
    expect(model.items).toEqual([]);
    expect(skillTodos.some((t) => t.path === 'items')).toBe(true);
  });
});
