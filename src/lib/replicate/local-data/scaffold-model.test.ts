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

  it('chooses the content array over config arrays and filters orphan containers out of mounts', () => {
    const html = `
      <main>
        <div class="obj-grid obj-grid--featured" id="featuredGrid"></div>
        <div class="obj-grid obj-grid--archive" id="archiveGrid"></div>
        <div class="obj-grid obj-grid--market" id="marketGrid"></div>
        <div id="emptyFilterSlot"></div>
        <div id="emptyModalSlot"></div>
        <div id="emptyPromoSlot"></div>
        <div id="emptyFooterSlot"></div>
        <div id="notEmpty"><span>static</span></div>
      </main>
    `;
    const js = `
      const OBJET_CATS = [
        { id: 'all', label: 'Everything' },
        { id: 'glass', label: 'Glass' },
        { id: 'textiles', label: 'Textiles' },
        { id: 'lighting', label: 'Lighting' },
        { id: 'ceramics', label: 'Ceramics' },
        { id: 'prints', label: 'Prints' },
        { id: 'metal', label: 'Metal' },
      ];
      const OBJETS = [
        { id: 'opaline-1965', title: 'Opaline Vase', story: 'A sufficiently long provenance description that reads as body content here.', category: 'glass', price: 120 },
        { id: 'boutis-quilt', title: 'Boutis Coverlet', story: 'Another long provenance description well past the content length threshold value.', category: 'textiles', price: 240 },
        { id: 'anglepoise-1934', title: 'Anglepoise Lamp', story: 'Collected from a small atelier with enough narrative body text to become content.', category: 'lighting', price: 410 },
        { id: 'raku-bowl', title: 'Raku Bowl', story: 'Smoke-fired ceramic with a long descriptive note about condition and origin.', category: 'ceramics', price: 95 },
        { id: 'atelier-print', title: 'Atelier Print', story: 'Numbered print with framing notes and enough prose to be imported as content.', category: 'prints', price: 180 },
        { id: 'brass-candlestick', title: 'Brass Candlestick', story: 'Patinated brass object with a durable story field for the scaffold body.', category: 'metal', price: 75 },
        { id: 'murano-dish', title: 'Murano Dish', story: 'Layered glass dish with source copy that should stay attached to the item.', category: 'glass', price: 130 },
        { id: 'linen-panel', title: 'Linen Panel', story: 'Handwoven panel with source copy that should become item content.', category: 'textiles', price: 205 },
      ];
      const NAV = [
        { id: 'home', label: 'Home', href: '/' },
        { id: 'shop', label: 'Shop', href: '/shop' },
      ];
      function objetCard(o){ return '<article class="obj-card"></article>'; }
      function openObjet(id){ return OBJETS.find((objet) => objet.id === id); }
      mountGrid('#featuredGrid', OBJETS, 3);
      mountGrid('#archiveGrid', OBJETS.filter((objet) => objet.category !== 'lighting'));
      mountGrid('#marketGrid', OBJETS.map(objetCard));
    `;

    const result = scaffoldDataModel({ html, js });

    expect(result.model.cpt.slug).toBe('objet');
    expect(result.model.items.map((item) => item.id)).toEqual([
      'opaline-1965',
      'boutis-quilt',
      'anglepoise-1934',
      'raku-bowl',
      'atelier-print',
      'brass-candlestick',
      'murano-dish',
      'linen-panel',
    ]);
    expect(result.model.taxonomy.terms.length).toBeGreaterThanOrEqual(5);
    expect(result.model.mounts.map((mount) => mount.selector).sort()).toEqual(['#archiveGrid', '#featuredGrid', '#marketGrid']);
    expect(result.discovered.unmatchedContainers?.sort()).toEqual(['#emptyFilterSlot', '#emptyFooterSlot', '#emptyModalSlot', '#emptyPromoSlot']);
    expect(result.discovered.arrays.map((array) => array.name)).toEqual(expect.arrayContaining(['OBJET_CATS', 'OBJETS', 'NAV']));
  });
});
