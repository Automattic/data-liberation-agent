/**
 * Attempt to fetch a Shopify JSON endpoint. Returns null if the store blocks it.
 */
export async function fetchShopifyJson<T>(url: string, bounds?: { maxBytes: number; sameOrigin: boolean }): Promise<T | null> {
  try {
    const resp = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      redirect: bounds?.sameOrigin ? 'error' : 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; DataLiberation/1.0)',
        Accept: 'application/json',
      },
    });
    if (!resp.ok) {
      await resp.body?.cancel();
      return null;
    }
    if (!bounds) return (await resp.json()) as T;
    const reader = resp.body?.getReader();
    if (!reader) return null;
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > bounds.maxBytes) {
          await reader.cancel();
          return null;
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
    } finally {
      reader.releaseLock();
    }
  } catch {
    return null;
  }
}

/**
 * Paginate through a Shopify JSON list endpoint (?limit=250&page=N).
 */
export async function fetchShopifyPaginated<T>(baseUrl: string, key: string): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  const maxPages = 20; // safety limit
  while (page <= maxPages) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    const url = `${baseUrl}${sep}limit=250&page=${page}`;
    const data = await fetchShopifyJson<Record<string, T[]>>(url);
    if (!data || !data[key] || data[key].length === 0) break;
    items.push(...data[key]);
    if (data[key].length < 250) break;
    page++;
  }
  return items;
}
