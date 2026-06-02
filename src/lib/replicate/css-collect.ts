import * as cheerio from 'cheerio';

export interface CollectOpts {
  html: string;
  inlineStyleText: string;
  baseUrl: string;
  /** Override for tests; defaults to global fetch -> text. */
  fetcher?: (url: string) => Promise<string>;
}

const defaultFetcher = async (url: string): Promise<string> => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.text();
};

export async function collectCss(opts: CollectOpts): Promise<string> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const $ = cheerio.load(opts.html);
  const seen = new Set<string>();
  const hrefs: string[] = [];
  $('link[rel="stylesheet"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) {
      try {
        const resolved = new URL(href, opts.baseUrl).toString();
        if (!seen.has(resolved)) {
          seen.add(resolved);
          hrefs.push(resolved);
        }
      } catch { /* skip unparseable hrefs */ }
    }
  });
  const sheets: string[] = [];
  if (opts.inlineStyleText.trim()) sheets.push(opts.inlineStyleText);
  for (const url of hrefs) {
    try { sheets.push(await fetcher(url)); } catch { /* keep-going: skip failed sheet */ }
  }
  return sheets.join('\n\n');
}
