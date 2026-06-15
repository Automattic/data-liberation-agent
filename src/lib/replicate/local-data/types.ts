// src/lib/replicate/local-data/types.ts
//
// Data model for the "JS data-mount -> WordPress-driven data" path: a local
// site's JS-rendered card grids (an empty <div id="newestGrid"> filled at
// runtime by mountGrid(...)) become a real CPT + taxonomy + query loops, while
// the styling/animation/interaction JS is kept. The agent skill `model-local-data`
// produces a DataModel (from the source JS + author schema hints); the
// deterministic src consumes it to install the CPT, insert posts, and emit
// class-faithful core/query loops in place of the mounts.

/** A custom-field definition on the CPT (stored as post meta). */
export interface DataField {
  /** Meta key, e.g. 'price_eur'. */
  key: string;
  /** Coarse type for sanitization + REST registration. */
  type: 'string' | 'integer' | 'number' | 'boolean';
}

/** A taxonomy bound to the CPT. */
export interface DataTaxonomy {
  /** Taxonomy slug, e.g. 'objet_cat'. */
  slug: string;
  /** Human label, e.g. 'Categories'. */
  label: string;
  /** Whether terms are hierarchical (category-like) vs flat (tag-like). */
  hierarchical: boolean;
  /** The full term set (slug + label), e.g. {slug:'glass',label:'Glass'}. */
  terms: Array<{ slug: string; label: string }>;
}

/** One gallery image for an item. The mockup uses caption-only placeholder
 * tiles (no real files); url is optional until real attachments are supplied. */
export interface DataGalleryImage {
  caption: string;
  url?: string;
}

/** A single content item -> one CPT post. */
export interface DataItem {
  /** Stable source id (e.g. 'opaline-vase-1965') -> meta._dla_item_id, the
   * idempotency key for update-in-place inserts. */
  id: string;
  /** post_title. */
  title: string;
  /** Term slugs assigned in the CPT's taxonomy. */
  terms: string[];
  /** Field key -> value (meta). Values are coerced per the field type on insert. */
  meta: Record<string, string | number | boolean>;
  /** Gallery images (placeholder captions and/or real urls). */
  gallery: DataGalleryImage[];
  /** Optional long body -> post_content (e.g. the 'story' field may double as content). */
  content?: string;
}

/** The CPT definition. */
export interface DataCpt {
  /** Post-type slug, e.g. 'objet'. */
  slug: string;
  /** Singular + plural labels. */
  singular: string;
  plural: string;
  /** Whether the type is publicly queryable / has archives. */
  public: boolean;
  /** Editor supports (title/editor/thumbnail/custom-fields …). */
  supports: string[];
}

/** Maps a source JS data-mount to the query that should replace it. */
export interface MountSpec {
  /** The mount element selector / id in the source, e.g. '#newestGrid'. */
  selector: string;
  /** The source JS expression that filled it (recorded for neutralization +
   * provenance), e.g. "mountGrid('#newestGrid', newestObjets(4))". */
  sourceCall: string;
  /** Query parameters for the replacement core/query loop. */
  query: {
    postType: string;
    /** -1 = all. */
    perPage: number;
    /** Ordering, e.g. 'date' | 'title' | 'menu_order'. */
    orderBy?: 'date' | 'title' | 'menu_order';
    order?: 'ASC' | 'DESC';
    /** Optional taxonomy term-slug filter for the initial render. */
    termSlug?: string;
  };
  /** Wrapper class(es) on the mount div (carried CSS hooks, e.g. 'obj-grid obj-grid--4'). */
  wrapperClass?: string;
}

/** The full model the agent skill emits and the deterministic src consumes. */
export interface DataModel {
  cpt: DataCpt;
  taxonomy: DataTaxonomy;
  fields: DataField[];
  items: DataItem[];
  mounts: MountSpec[];
  /** Schema version so persisted data-model.json invalidates on shape change. */
  schema: number;
}

export const DATA_MODEL_SCHEMA = 1;
