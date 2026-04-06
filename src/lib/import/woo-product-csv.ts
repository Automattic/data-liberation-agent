import { writeFileSync, appendFileSync, readFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { mkdirSync } from 'fs';
import Papa from 'papaparse';

// ---------------------------------------------------------------------------
// WooCommerce Product CSV Builder
// ---------------------------------------------------------------------------

export interface WooProduct {
  name: string;
  type?: 'simple' | 'variable' | 'grouped' | 'external' | 'variation';
  sku?: string;
  published?: boolean;
  description?: string;
  shortDescription?: string;
  regularPrice?: string;
  salePrice?: string;
  categories?: string[];
  tags?: string[];
  images?: string[];
  weight?: string;
  length?: string;
  width?: string;
  height?: string;
  inStock?: boolean;
  stock?: number;
  attributes?: Array<{
    name: string;
    values: string[];
    visible?: boolean;
    global?: boolean;
  }>;
  parentSku?: string;
}


export class WooProductCsvBuilder {
  private products: WooProduct[] = [];

  addProduct(product: WooProduct): void {
    if (this._streaming) {
      this.flushProduct(product);
    } else {
      this.products.push(product);
    }
  }

  /**
   * Determine the maximum number of attribute columns needed across all products.
   */
  private maxAttributes(): number {
    let max = 0;
    for (const p of this.products) {
      if (p.attributes && p.attributes.length > max) {
        max = p.attributes.length;
      }
    }
    return max;
  }

  /**
   * Build the header row.
   */
  private buildHeaders(): string[] {
    const headers = [
      'ID',
      'Type',
      'SKU',
      'Name',
      'Published',
      'Short description',
      'Description',
      'Regular price',
      'Sale price',
      'Categories',
      'Tags',
      'Images',
      'Weight (lbs)',
      'Length (in)',
      'Width (in)',
      'Height (in)',
      'In stock?',
      'Stock',
    ];

    const attrCount = this.maxAttributes();
    for (let i = 1; i <= attrCount; i++) {
      headers.push(`Attribute ${i} name`);
      headers.push(`Attribute ${i} value(s)`);
      headers.push(`Attribute ${i} visible`);
      headers.push(`Attribute ${i} global`);
    }

    headers.push('Parent');

    return headers;
  }

  /**
   * Build a CSV row for a single product.
   */
  private buildRow(product: WooProduct, attrCount: number): string[] {
    const row: string[] = [
      '', // ID — empty for new products
      product.type || 'simple',
      product.sku || '',
      product.name,
      product.published === false ? '0' : '1',
      product.shortDescription || '',
      product.description || '',
      product.regularPrice || '',
      product.salePrice || '',
      product.categories ? product.categories.join(' | ') : '',
      product.tags ? product.tags.join(' | ') : '',
      product.images ? product.images.join(', ') : '',
      product.weight || '',
      product.length || '',
      product.width || '',
      product.height || '',
      product.inStock === false ? '0' : product.inStock === true ? '1' : '',
      product.stock != null ? String(product.stock) : '',
    ];

    for (let i = 0; i < attrCount; i++) {
      const attr = product.attributes?.[i];
      if (attr) {
        row.push(attr.name);
        row.push(attr.values.join(', '));
        row.push(attr.visible === false ? '0' : '1');
        row.push(attr.global === true ? '1' : '0');
      } else {
        row.push('', '', '', '');
      }
    }

    row.push(product.parentSku || '');

    return row;
  }

  /**
   * Serialize all products to a CSV file at the given path.
   */
  serialize(outputPath: string): void {
    mkdirSync(dirname(outputPath), { recursive: true });

    const headers = this.buildHeaders();
    const attrCount = this.maxAttributes();

    const data = this.products.map(p => this.buildRow(p, attrCount));
    const csv = Papa.unparse({ fields: headers, data }, { newline: '\n' });
    writeFileSync(outputPath, csv, 'utf8');
  }

  // ---------------------------------------------------------------------------
  // Streaming mode — write products as JSONL, then build CSV from that
  // ---------------------------------------------------------------------------

  private _streamDir: string | null = null;
  private _jsonlPath: string | null = null;
  private _streaming = false;

  get isStreaming(): boolean {
    return this._streaming;
  }

  /**
   * Begin streaming mode. Products are appended as JSONL lines.
   */
  openStream(outputDir: string): void {
    mkdirSync(outputDir, { recursive: true });
    this._streamDir = outputDir;
    this._jsonlPath = join(outputDir, 'products.jsonl');
    this._streaming = true;
    // Clear any existing JSONL from a previous run
    writeFileSync(this._jsonlPath, '', 'utf8');
  }

  /**
   * Append a product as a JSONL line. No memory accumulation.
   */
  flushProduct(product: WooProduct): void {
    if (!this._streaming || !this._jsonlPath) {
      throw new Error('Cannot flushProduct: streaming is not active. Call openStream() first.');
    }
    appendFileSync(this._jsonlPath, JSON.stringify(product) + '\n', 'utf8');
  }

  /**
   * End streaming. Reads the JSONL, computes maxAttributes, writes products.csv.
   * Returns the path to the CSV file.
   */
  closeStream(): string {
    if (!this._streaming || !this._jsonlPath || !this._streamDir) {
      throw new Error('Cannot closeStream: streaming is not active.');
    }

    const csvPath = join(this._streamDir, 'products.csv');
    const products = readJsonl(this._jsonlPath);

    if (products.length > 0) {
      // Temporarily load products to use existing serialize logic
      this.products = products;
      this.serialize(csvPath);
      this.products = [];
    }

    this._streaming = false;
    return csvPath;
  }
}

/**
 * Read a products.jsonl file back into WooProduct objects.
 */
function readJsonl(path: string): WooProduct[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const products: WooProduct[] = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      products.push(JSON.parse(line) as WooProduct);
    } catch {
      // Skip malformed lines
    }
  }
  return products;
}
