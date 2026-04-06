import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { WooProductCsvBuilder } from '../src/lib/import/woo-product-csv.js';

describe('WooProductCsvBuilder', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'woo-csv-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function buildAndRead(builder: WooProductCsvBuilder): string {
    const csvPath = join(tempDir, 'products.csv');
    builder.serialize(csvPath);
    return readFileSync(csvPath, 'utf8');
  }

  function parseRows(csv: string): string[][] {
    // Simple CSV parser that handles quoted fields
    const rows: string[][] = [];
    const lines = csv.split('\n');
    for (const line of lines) {
      if (!line) continue;
      const fields: string[] = [];
      let i = 0;
      while (i <= line.length) {
        if (i === line.length) {
          fields.push('');
          break;
        }
        if (line[i] === '"') {
          // Quoted field
          let val = '';
          i++; // skip opening quote
          while (i < line.length) {
            if (line[i] === '"' && i + 1 < line.length && line[i + 1] === '"') {
              val += '"';
              i += 2;
            } else if (line[i] === '"') {
              i++; // skip closing quote
              break;
            } else {
              val += line[i];
              i++;
            }
          }
          fields.push(val);
          if (i < line.length && line[i] === ',') i++; // skip comma
        } else {
          // Unquoted field
          const nextComma = line.indexOf(',', i);
          if (nextComma === -1) {
            fields.push(line.slice(i));
            break;
          } else {
            fields.push(line.slice(i, nextComma));
            i = nextComma + 1;
          }
        }
      }
      rows.push(fields);
    }
    return rows;
  }

  it('serializes simple products to CSV', () => {
    const builder = new WooProductCsvBuilder();
    builder.addProduct({
      name: 'Blue T-Shirt',
      sku: 'BLUE-TEE-001',
      regularPrice: '29.99',
      description: '<p>A nice blue t-shirt.</p>',
      categories: ['Clothing'],
      tags: ['summer', 'blue'],
      images: ['https://example.com/blue-tee.jpg'],
      inStock: true,
      stock: 50,
    });

    const csv = buildAndRead(builder);
    const rows = parseRows(csv);

    // Check headers
    expect(rows[0]).toContain('ID');
    expect(rows[0]).toContain('Type');
    expect(rows[0]).toContain('SKU');
    expect(rows[0]).toContain('Name');
    expect(rows[0]).toContain('Published');
    expect(rows[0]).toContain('Regular price');
    expect(rows[0]).toContain('Categories');
    expect(rows[0]).toContain('Tags');
    expect(rows[0]).toContain('Images');

    // Check data row
    const dataRow = rows[1];
    const headerRow = rows[0];
    const idx = (name: string) => headerRow.indexOf(name);

    expect(dataRow[idx('ID')]).toBe('');
    expect(dataRow[idx('Type')]).toBe('simple');
    expect(dataRow[idx('SKU')]).toBe('BLUE-TEE-001');
    expect(dataRow[idx('Name')]).toBe('Blue T-Shirt');
    expect(dataRow[idx('Published')]).toBe('1');
    expect(dataRow[idx('Regular price')]).toBe('29.99');
    expect(dataRow[idx('Categories')]).toBe('Clothing');
    expect(dataRow[idx('Tags')]).toBe('summer | blue');
    expect(dataRow[idx('Images')]).toBe('https://example.com/blue-tee.jpg');
    expect(dataRow[idx('In stock?')]).toBe('1');
    expect(dataRow[idx('Stock')]).toBe('50');
  });

  it('serializes variable products with attributes', () => {
    const builder = new WooProductCsvBuilder();
    builder.addProduct({
      name: 'Variable T-Shirt',
      type: 'variable',
      sku: 'VAR-TEE',
      regularPrice: '34.99',
      attributes: [
        { name: 'Size', values: ['S', 'M', 'L'], visible: true, global: true },
        { name: 'Color', values: ['Red', 'Blue'], visible: true, global: false },
      ],
    });

    const csv = buildAndRead(builder);
    const rows = parseRows(csv);

    const headerRow = rows[0];
    expect(headerRow).toContain('Attribute 1 name');
    expect(headerRow).toContain('Attribute 1 value(s)');
    expect(headerRow).toContain('Attribute 1 visible');
    expect(headerRow).toContain('Attribute 1 global');
    expect(headerRow).toContain('Attribute 2 name');
    expect(headerRow).toContain('Attribute 2 value(s)');

    const dataRow = rows[1];
    const idx = (name: string) => headerRow.indexOf(name);

    expect(dataRow[idx('Type')]).toBe('variable');
    expect(dataRow[idx('Attribute 1 name')]).toBe('Size');
    expect(dataRow[idx('Attribute 1 value(s)')]).toBe('S, M, L');
    expect(dataRow[idx('Attribute 1 visible')]).toBe('1');
    expect(dataRow[idx('Attribute 1 global')]).toBe('1');
    expect(dataRow[idx('Attribute 2 name')]).toBe('Color');
    expect(dataRow[idx('Attribute 2 value(s)')]).toBe('Red, Blue');
    expect(dataRow[idx('Attribute 2 visible')]).toBe('1');
    expect(dataRow[idx('Attribute 2 global')]).toBe('0');
  });

  it('handles categories with hierarchy', () => {
    const builder = new WooProductCsvBuilder();
    builder.addProduct({
      name: 'Graphic Tee',
      categories: ['Clothing', 'Clothing > T-Shirts'],
    });

    const csv = buildAndRead(builder);
    const rows = parseRows(csv);
    const headerRow = rows[0];
    const dataRow = rows[1];
    const idx = (name: string) => headerRow.indexOf(name);

    expect(dataRow[idx('Categories')]).toBe('Clothing | Clothing > T-Shirts');
  });

  it('handles multiple images', () => {
    const builder = new WooProductCsvBuilder();
    builder.addProduct({
      name: 'Multi-Image Product',
      images: [
        'https://example.com/main.jpg',
        'https://example.com/side.jpg',
        'https://example.com/back.jpg',
      ],
    });

    const csv = buildAndRead(builder);
    const rows = parseRows(csv);
    const headerRow = rows[0];
    const dataRow = rows[1];
    const idx = (name: string) => headerRow.indexOf(name);

    expect(dataRow[idx('Images')]).toBe(
      'https://example.com/main.jpg, https://example.com/side.jpg, https://example.com/back.jpg'
    );
  });

  it('escapes CSV fields correctly', () => {
    const builder = new WooProductCsvBuilder();
    builder.addProduct({
      name: 'Product with "quotes"',
      description: '<p>Has commas, "quotes", and\nnewlines</p>',
      shortDescription: 'Simple text',
    });

    const csv = buildAndRead(builder);

    // The name should be quoted with escaped double-quotes
    expect(csv).toContain('"Product with ""quotes"""');

    // The description should be quoted (contains commas, quotes, newlines)
    expect(csv).toContain('"<p>Has commas, ""quotes"", and\nnewlines</p>"');
  });

  it('writes empty string for missing optional fields', () => {
    const builder = new WooProductCsvBuilder();
    builder.addProduct({
      name: 'Minimal Product',
    });

    const csv = buildAndRead(builder);
    const rows = parseRows(csv);
    const headerRow = rows[0];
    const dataRow = rows[1];
    const idx = (name: string) => headerRow.indexOf(name);

    expect(dataRow[idx('Name')]).toBe('Minimal Product');
    expect(dataRow[idx('SKU')]).toBe('');
    expect(dataRow[idx('Description')]).toBe('');
    expect(dataRow[idx('Short description')]).toBe('');
    expect(dataRow[idx('Regular price')]).toBe('');
    expect(dataRow[idx('Sale price')]).toBe('');
    expect(dataRow[idx('Categories')]).toBe('');
    expect(dataRow[idx('Tags')]).toBe('');
    expect(dataRow[idx('Images')]).toBe('');
    expect(dataRow[idx('Weight (lbs)')]).toBe('');
    expect(dataRow[idx('In stock?')]).toBe('');
    expect(dataRow[idx('Stock')]).toBe('');
    expect(dataRow[idx('Parent')]).toBe('');
    // Type defaults to simple
    expect(dataRow[idx('Type')]).toBe('simple');
    // Published defaults to 1
    expect(dataRow[idx('Published')]).toBe('1');
  });

  it('handles draft (unpublished) products', () => {
    const builder = new WooProductCsvBuilder();
    builder.addProduct({
      name: 'Draft Product',
      published: false,
    });

    const csv = buildAndRead(builder);
    const rows = parseRows(csv);
    const headerRow = rows[0];
    const dataRow = rows[1];
    const idx = (name: string) => headerRow.indexOf(name);

    expect(dataRow[idx('Published')]).toBe('0');
  });

  it('handles product variations with parentSku', () => {
    const builder = new WooProductCsvBuilder();
    builder.addProduct({
      name: 'Parent Shirt',
      type: 'variable',
      sku: 'SHIRT-001',
      attributes: [
        { name: 'Size', values: ['S', 'M', 'L'] },
      ],
    });
    builder.addProduct({
      name: 'Parent Shirt - Small',
      sku: 'SHIRT-001-S',
      regularPrice: '19.99',
      parentSku: 'SHIRT-001',
      attributes: [
        { name: 'Size', values: ['S'] },
      ],
    });

    const csv = buildAndRead(builder);
    const rows = parseRows(csv);
    const headerRow = rows[0];
    const idx = (name: string) => headerRow.indexOf(name);

    // Parent row
    expect(rows[1][idx('Parent')]).toBe('');
    // Variation row
    expect(rows[2][idx('Parent')]).toBe('SHIRT-001');
    expect(rows[2][idx('SKU')]).toBe('SHIRT-001-S');
  });

  it('serializes multiple products', () => {
    const builder = new WooProductCsvBuilder();
    builder.addProduct({ name: 'Product A', sku: 'A' });
    builder.addProduct({ name: 'Product B', sku: 'B' });
    builder.addProduct({ name: 'Product C', sku: 'C' });

    const csv = buildAndRead(builder);
    const rows = parseRows(csv);

    // 1 header + 3 data rows
    expect(rows.length).toBe(4);
  });

  it('streams products as JSONL then builds CSV on closeStream', () => {
    const builder = new WooProductCsvBuilder();
    builder.openStream(tempDir);

    builder.addProduct({ name: 'Streamed A', sku: 'SA', regularPrice: '10.00' });
    builder.addProduct({ name: 'Streamed B', sku: 'SB', regularPrice: '20.00', attributes: [{ name: 'Color', values: ['Red', 'Blue'], visible: true, global: false }] });

    // JSONL should exist before closeStream
    const jsonlPath = join(tempDir, 'products.jsonl');
    expect(existsSync(jsonlPath)).toBe(true);
    const lines = readFileSync(jsonlPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).name).toBe('Streamed A');

    // Close stream — should produce CSV
    const csvPath = builder.closeStream();
    expect(existsSync(csvPath)).toBe(true);

    const csv = readFileSync(csvPath, 'utf8');
    const rows = parseRows(csv);
    expect(rows).toHaveLength(3); // header + 2 products
    expect(rows[1][3]).toBe('Streamed A'); // Name column
    expect(rows[2][3]).toBe('Streamed B');
    // Should have attribute columns from product B
    expect(csv).toContain('Attribute 1 name');
    expect(csv).toContain('Color');
  });
});
