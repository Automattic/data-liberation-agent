# Structured content index

`website/content-index.json` keeps its `data-liberation-agent/content-index/v1`
schema, posts, terms and redirects. Adapters may additionally attach a typed
`product` to a `StructuredContentEntry`. Export projects these provider-neutral
`generic/products/v1` rows into an optional top-level `products` array. Product
rows are independent of route coverage: `source_path` is present only when the
product's permalink has an allocated exported route. Product data is not copied
into `posts`.

The Shopify adapter maps the public catalog's titles, handles, descriptions,
product types, tags and collection titles. Decimal prices come only from variant
evidence; a higher compare-at price becomes regular price and price becomes sale
price. Named options produce variants with explicit attribute labels and slug
keys/values; Title/Default Title is simple. Missing prices or availability,
ambiguous option identities and duplicate combinations omit the row with a
`product_row_omitted` enumeration diagnostic, without dropping its page entry.

Rows may carry `currency`, an optional ISO 4217 code applying to all prices and
variants in the row. Shopify reads the store currency once per catalog enumeration
from `/cart.js`, falling back to `/meta.json`, through the source request governors.
If neither supplies a valid currency code, rows omit the field and enumeration
reports `product_currency_unavailable`; no default currency is invented.

Product image URLs join the existing capture asset verification and source
request governors. Already verified page images are reused. Catalog-only images
participate in portable media selection, byte limits, hashing and deduplication.
Emitted image sources are relative to the website root, like every other
content-index path, such as `media/beans.svg`. An unavailable or excluded image is omitted with a
`product_image_omitted` export diagnostic; no remote URL is shipped in its place.

Fixture evidence for #2103:

Before: `{"schema":"data-liberation-agent/content-index/v1","posts":[...],"terms":[...],"redirects":[...]}` (no products).

After (excerpt):

```json
{
  "products": [{
    "name": "Coffee",
    "slug": "coffee",
    "description": "<p>Roasted</p>",
    "category": "Coffee",
    "categories": ["Favorites"],
    "tags": ["fresh", "beans"],
    "regular_price": "10.00",
    "sale_price": "8.00",
    "sku": "BEAN",
    "stock_status": "instock",
    "source_path": "/products/coffee/index.html"
  }]
}
```

The browserless catalog regression enumerates products and collections fixtures,
verifies a page image before catalog acquisition, exports the website, and checks
both the index rows and actual localized image files. It requires no Chromium
pass. The contract is documented upstream in Blocks Engine's
[`products.md`](https://github.com/Automattic/blocks-engine/blob/trunk/php-transformer/docs/contracts/products.md#product-rows).
