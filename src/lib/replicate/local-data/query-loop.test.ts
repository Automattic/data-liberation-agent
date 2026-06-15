// src/lib/replicate/local-data/query-loop.test.ts
import { describe, it, expect } from 'vitest';
import { parse } from '@wordpress/block-serialization-default-parser';
import { buildQueryLoop, DATA_CARD_BLOCK } from './query-loop.js';
import type { MountSpec } from './types.js';

const NEWEST: MountSpec = {
  selector: '#newestGrid',
  sourceCall: "mountGrid('#newestGrid', newestObjets(4))",
  query: { postType: 'objet', perPage: 4, orderBy: 'date', order: 'DESC' },
  wrapperClass: 'obj-grid obj-grid--4',
};

const SHOP: MountSpec = {
  selector: '#shopGrid',
  sourceCall: "mountGrid('#shopGrid', OBJETS)",
  query: { postType: 'objet', perPage: -1, orderBy: 'date', order: 'ASC' },
  wrapperClass: 'obj-grid obj-grid--4',
};

describe('buildQueryLoop', () => {
  it('emits a core/query > core/post-template > dla/data-card tree', () => {
    const { markup } = buildQueryLoop(NEWEST);
    const blocks = parse(markup).filter((b) => b.blockName);
    expect(blocks).toHaveLength(1);
    const query = blocks[0];
    expect(query.blockName).toBe('core/query');
    const tmpl = query.innerBlocks[0];
    expect(tmpl.blockName).toBe('core/post-template');
    expect(tmpl.innerBlocks[0].blockName).toBe(DATA_CARD_BLOCK);
  });

  it('anchors the mount id on the query wrapper (kept JS selectors keep binding)', () => {
    const { markup } = buildQueryLoop(NEWEST);
    expect(markup).toContain('"anchor":"newestGrid"');
    expect(markup).toContain('<div class="wp-block-query" id="newestGrid">');
  });

  it('puts the grid wrapper class on the post-template <ul>', () => {
    const { markup } = buildQueryLoop(NEWEST);
    const tmpl = parse(markup)[0].innerBlocks[0];
    expect(tmpl.attrs!.className).toBe('obj-grid obj-grid--4');
  });

  it('translates the query (postType, perPage, order) onto core/query', () => {
    const q = parse(buildQueryLoop(NEWEST).markup)[0].attrs!.query as Record<string, unknown>;
    expect(q.postType).toBe('objet');
    expect(q.perPage).toBe(4);
    expect(q.order).toBe('desc');
    expect(q.orderBy).toBe('date');
    expect(q.inherit).toBe(false);
  });

  it('clamps the -1 "all" sentinel to a finite perPage', () => {
    const q = parse(buildQueryLoop(SHOP).markup)[0].attrs!.query as Record<string, unknown>;
    expect(q.perPage).toBe(100);
    expect(q.order).toBe('asc');
  });

  it('emits a li-flatten rule scoped to the mount id', () => {
    expect(buildQueryLoop(NEWEST).css).toBe(
      '#newestGrid .wp-block-post-template > li{display:contents}',
    );
  });

  it('disambiguates multiple loops via queryId', () => {
    expect(buildQueryLoop(NEWEST, 0).markup).toContain('"queryId":0');
    expect(buildQueryLoop(SHOP, 1).markup).toContain('"queryId":1');
  });

  it('non-id selectors get no anchor and no li-flatten css', () => {
    const r = buildQueryLoop({ ...NEWEST, selector: '.obj-grid' });
    expect(r.markup).not.toContain('"anchor"');
    expect(r.markup).toContain('<div class="wp-block-query">');
    expect(r.css).toBe('');
  });
});
