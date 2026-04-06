import { readFileSync, existsSync } from 'fs';
import Papa from 'papaparse';
import type { WooProduct } from './woo-product-csv.js';

/**
 * Read a WooCommerce product CSV file written by WooProductCsvBuilder
 * and return an array of WooProduct objects.
 * Returns an empty array if the file does not exist.
 */
export function readProductsCsv(csvPath: string): WooProduct[] {
  if (!existsSync(csvPath)) {
    return [];
  }

  const content = readFileSync(csvPath, 'utf8');
  const { data: rows } = Papa.parse<Record<string, string>>(content, {
    header: true,
    skipEmptyLines: true,
  });

  const products: WooProduct[] = [];

  for (const row of rows) {
    const get = (name: string): string => row[name] ?? '';

    const product: WooProduct = {
      name: get('Name'),
    };

    const type = get('Type');
    if (type) {
      product.type = type as WooProduct['type'];
    }

    const sku = get('SKU');
    if (sku) product.sku = sku;

    const published = get('Published');
    if (published !== '') {
      product.published = published !== '0';
    }

    const description = get('Description');
    if (description) product.description = description;

    const shortDescription = get('Short description');
    if (shortDescription) product.shortDescription = shortDescription;

    const regularPrice = get('Regular price');
    if (regularPrice) product.regularPrice = regularPrice;

    const salePrice = get('Sale price');
    if (salePrice) product.salePrice = salePrice;

    const categories = get('Categories');
    if (categories) product.categories = categories.split(' | ');

    const tags = get('Tags');
    if (tags) product.tags = tags.split(' | ');

    const images = get('Images');
    if (images) product.images = images.split(', ');

    const weight = get('Weight (lbs)');
    if (weight) product.weight = weight;

    const length = get('Length (in)');
    if (length) product.length = length;

    const width = get('Width (in)');
    if (width) product.width = width;

    const height = get('Height (in)');
    if (height) product.height = height;

    const inStock = get('In stock?');
    if (inStock !== '') {
      product.inStock = inStock !== '0';
    }

    const stock = get('Stock');
    if (stock !== '') {
      const parsed = parseInt(stock, 10);
      if (!isNaN(parsed)) product.stock = parsed;
    }

    // Read attributes (columns Attribute N name/value(s)/visible/global, N = 1..10)
    const attributes: WooProduct['attributes'] = [];
    for (let n = 1; n <= 10; n++) {
      const attrName = get(`Attribute ${n} name`);
      if (!attrName) break;
      const valuesStr = get(`Attribute ${n} value(s)`);
      const visible = get(`Attribute ${n} visible`);
      const global = get(`Attribute ${n} global`);
      attributes.push({
        name: attrName,
        values: valuesStr ? valuesStr.split(', ') : [],
        visible: visible !== '0',
        global: global === '1',
      });
    }
    if (attributes.length > 0) {
      product.attributes = attributes;
    }

    const parentSku = get('Parent');
    if (parentSku) product.parentSku = parentSku;

    products.push(product);
  }

  return products;
}
