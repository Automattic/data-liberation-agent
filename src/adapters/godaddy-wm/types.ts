// ---------------------------------------------------------------------------
// Draft.js interfaces
// ---------------------------------------------------------------------------

export interface DraftEntity {
  type: string;
  mutability?: string;
  data?: { src?: string; alt?: string; href?: string; target?: string; [k: string]: unknown };
}

export interface DraftStyleRange {
  offset: number;
  length: number;
  style: string;
}

export interface DraftEntityRange {
  offset: number;
  length: number;
  key: number;
}

export interface DraftBlock {
  key: string;
  text: string;
  type: string;
  depth?: number;
  inlineStyleRanges?: DraftStyleRange[];
  entityRanges?: DraftEntityRange[];
  data?: Record<string, unknown>;
}

export interface DraftContentState {
  blocks: DraftBlock[];
  entityMap: Record<string, DraftEntity>;
}

// ---------------------------------------------------------------------------
// _BLOG_DATA interfaces
// ---------------------------------------------------------------------------

export interface BlogDataPost {
  title?: string;
  date?: string;
  publishedDate?: string;
  content?: string;
  fullContent?: string;
  slug?: string;
  featuredImage?: string;
  categories?: string[];
}

export interface BlogData {
  post?: BlogDataPost;
}
