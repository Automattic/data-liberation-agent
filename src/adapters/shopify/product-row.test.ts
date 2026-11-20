import { expect, it } from 'vitest';
import { shopifyProductRow } from './product-row.js';

const product = () => ({ handle: 'cup', title: 'Cup', body_html: '<p>Cup</p>', tags: [], options: [{ name: 'Size', values: ['Small', 'Large'] }], variants: [
	{ price: '12.00', compare_at_price: '10.00', available: true, option1: 'Small' },
	{ price: '15.00', available: false, option1: 'Large' },
] });

it('uses declared prices, never a lower compare-at value, and omits unrepresentable rows', () => {
	expect(shopifyProductRow(product())).toMatchObject({ regular_price: '12.00', stock_status: 'instock' });
	expect(shopifyProductRow(product())).not.toHaveProperty('sale_price');
	for (const change of [
		{ handle: '' }, { title: '' }, { variants: [] },
		{ variants: [{ available: true, option1: 'Small' }] },
		{ variants: [{ price: 'free', available: true, option1: 'Small' }] },
		{ variants: [{ price: '12.00', option1: 'Small' }] },
		{ variants: [product().variants[0], { price: '12.00', available: true, option1: 'Unknown' }] },
		{ variants: [product().variants[0], product().variants[0]] },
	]) expect(shopifyProductRow({ ...product(), ...change })).toBeUndefined();
});

it('maps any single-variant product as simple and keeps Unicode handles (#2141)', () => {
	for (const [name, value] of [['Title', 'Default'], ['Title', 'Default Title'], ['Título', 'Predeterminado']]) {
		const row = shopifyProductRow({ handle: 'miniestufа-electrica-portatil-redondo', title: 'Miniestufa', body_html: '', options: [{ name, values: [value] }],
			variants: [{ price: '20.00', available: true, sku: 'MINI-1', option1: value }] });
		expect(row).toMatchObject({ slug: 'miniestufа-electrica-portatil-redondo', sku: 'MINI-1', regular_price: '20.00', stock_status: 'instock' });
		expect(row).not.toHaveProperty('variants');
	}
	for (const handle of ['a/b', '..', 'a b']) expect(shopifyProductRow({ ...product(), handle })).toBeUndefined();
});
