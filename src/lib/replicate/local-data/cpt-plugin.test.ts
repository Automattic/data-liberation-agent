// src/lib/replicate/local-data/cpt-plugin.test.ts
import { describe, it, expect } from 'vitest';
import { buildCptMuPlugin, cptMuPluginFilename } from './cpt-plugin.js';
import { DATA_MODEL_SCHEMA, type DataModel } from './types.js';

const MODEL: DataModel = {
  cpt: { slug: 'objet', singular: 'Objet', plural: 'Objets', public: true, supports: ['title', 'editor', 'thumbnail', 'custom-fields'] },
  taxonomy: {
    slug: 'objet_cat',
    label: 'Categories',
    hierarchical: true,
    terms: [
      { slug: 'glass', label: 'Glass' },
      { slug: 'textiles', label: 'Textiles' },
    ],
  },
  fields: [
    { key: 'price_eur', type: 'integer' },
    { key: 'dimensions', type: 'string' },
  ],
  items: [],
  mounts: [],
  schema: DATA_MODEL_SCHEMA,
};

describe('buildCptMuPlugin', () => {
  it('registers the CPT with labels, public flags, supports, and REST', () => {
    const php = buildCptMuPlugin(MODEL);
    expect(php.startsWith('<?php')).toBe(true);
    expect(php).toContain("register_post_type( 'objet'");
    expect(php).toContain("'name'          => 'Objets'");
    expect(php).toContain("'singular_name' => 'Objet'");
    expect(php).toContain("'public'       => true");
    expect(php).toContain("'has_archive'  => true");
    expect(php).toContain("'show_in_rest' => true");
    expect(php).toContain("'supports'     => array( 'title', 'editor', 'thumbnail', 'custom-fields' )");
  });

  it('registers the taxonomy bound to the CPT with hierarchy + REST', () => {
    const php = buildCptMuPlugin(MODEL);
    expect(php).toContain("register_taxonomy( 'objet_cat', 'objet'");
    expect(php).toContain("'hierarchical'      => true");
    expect(php).toContain("'name'          => 'Categories'");
  });

  it('registers each field as REST-exposed single post meta', () => {
    const php = buildCptMuPlugin(MODEL);
    expect(php).toContain("register_post_meta( 'objet', 'price_eur'");
    expect(php).toContain("'type'         => 'integer'");
    expect(php).toContain("register_post_meta( 'objet', 'dimensions'");
    expect(php).toContain("'type'         => 'string'");
    expect(php).toContain("'single'       => true");
    expect(php).toContain("'show_in_rest' => true");
  });

  it('guards direct access and is init-hooked (runs every request)', () => {
    const php = buildCptMuPlugin(MODEL);
    expect(php).toContain("if ( ! defined( 'ABSPATH' ) ) { exit; }");
    expect(php).toContain("add_action( 'init', function () {");
  });

  it('escapes single quotes in labels (no PHP breakout)', () => {
    const php = buildCptMuPlugin({ ...MODEL, cpt: { ...MODEL.cpt, plural: "O'Briens" } });
    expect(php).toContain("\\'Briens");
    expect(php).not.toContain("=> 'O'Briens'");
  });

  it('derives a conventional mu-plugin filename', () => {
    expect(cptMuPluginFilename(MODEL)).toBe('dla-data-objet.php');
  });

  it('public:false CPT disables archive + public', () => {
    const php = buildCptMuPlugin({ ...MODEL, cpt: { ...MODEL.cpt, public: false } });
    expect(php).toContain("'public'       => false");
    expect(php).toContain("'has_archive'  => false");
  });
});
