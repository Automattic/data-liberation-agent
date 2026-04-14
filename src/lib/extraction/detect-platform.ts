interface UrlPattern {
  pattern: RegExp;
  platform: string;
}

interface HttpSignal {
  header: string;
  value?: string;
  platform: string;
  signal: string;
}

interface SourceSignal {
  pattern: RegExp;
  platform: string;
  signal: string;
}

export interface DetectionResult {
  platform: string;
  confidence: 'high' | 'medium' | 'low';
  signals: string[];
}

export interface FullDetectionResult extends DetectionResult {
  url: string;
}

const URL_PATTERNS: UrlPattern[] = [
  { pattern: /wixsite\.com|wix\.com/i, platform: 'wix' },
  { pattern: /squarespace\.com/i, platform: 'squarespace' },
  { pattern: /webflow\.io|webflow\.com/i, platform: 'webflow' },
  { pattern: /myshopify\.com|shopify\.com/i, platform: 'shopify' },
  { pattern: /weebly\.com/i, platform: 'weebly' },
];

const HTTP_SIGNALS: HttpSignal[] = [
  { header: 'x-wix-request-id', platform: 'wix', signal: 'X-Wix-Request-Id header' },
  { header: 'server', value: 'squarespace', platform: 'squarespace', signal: 'Server: Squarespace header' },
  { header: 'x-servedby', value: 'squarespace', platform: 'squarespace', signal: 'X-ServedBy: squarespace header' },
  { header: 'x-powered-by', value: 'webflow', platform: 'webflow', signal: 'X-Powered-By: Webflow header' },
  { header: 'x-wf-region', platform: 'webflow', signal: 'x-wf-region header (Webflow infrastructure)' },
  { header: 'x-shopid', platform: 'shopify', signal: 'X-ShopId header' },
  { header: 'powered-by', value: 'shopify', platform: 'shopify', signal: 'Powered-by: Shopify header' },
  { header: 'x-host', value: 'weebly.net', platform: 'weebly', signal: 'X-Host: *.weebly.net header (Weebly backend)' },
];

const SOURCE_SIGNALS: SourceSignal[] = [
  { pattern: /wixstatic\.com/i, platform: 'wix', signal: 'wixstatic.com in page source' },
  { pattern: /cdn\.shopify\.com/i, platform: 'shopify', signal: 'cdn.shopify.com in page source' },
  { pattern: /static\.squarespace\.com/i, platform: 'squarespace', signal: 'static.squarespace.com in page source' },
  { pattern: /data-wf-domain/i, platform: 'webflow', signal: 'data-wf-domain attribute in page source' },
  { pattern: /_shopify_s|_shopify_y|Shopify\.theme/i, platform: 'shopify', signal: 'Shopify markers in page source' },
  { pattern: /editmysite\.com/i, platform: 'weebly', signal: 'editmysite.com CDN in page source' },
  { pattern: /wsite-menu-item|wsite-content|_W\.configDomain\s*=\s*["'].*weebly/i, platform: 'weebly', signal: 'Weebly markers in page source' },
  { pattern: /zyrosite\.com/i, platform: 'hostinger', signal: 'zyrosite.com CDN in page source (Hostinger Website Builder)' },
  { pattern: /<meta[^>]+name=["']generator["'][^>]+content=["']Hostinger[^"']*["']/i, platform: 'hostinger', signal: 'Hostinger generator meta tag' },
];

export function detectFromUrl(url: string): string | null {
  const normalized = url.includes('://') ? url : `https://${url}`;
  for (const { pattern, platform } of URL_PATTERNS) {
    if (pattern.test(normalized)) return platform;
  }
  return null;
}

export async function detectFromHttp(url: string): Promise<DetectionResult> {
  const signals: string[] = [];
  let platform = 'unknown';
  let confidence: 'high' | 'medium' | 'low' = 'low';

  try {
    const normalized = url.includes('://') ? url : `https://${url}`;
    const response = await fetch(normalized, {
      signal: AbortSignal.timeout(10000),
      redirect: 'follow',
    });

    for (const sig of HTTP_SIGNALS) {
      const headerVal = response.headers.get(sig.header);
      if (headerVal && (!sig.value || headerVal.toLowerCase().includes(sig.value))) {
        platform = sig.platform;
        confidence = 'high';
        signals.push(sig.signal);
      }
    }

    if (platform === 'unknown') {
      const html = await response.text();
      for (const sig of SOURCE_SIGNALS) {
        if (sig.pattern.test(html)) {
          platform = sig.platform;
          confidence = 'medium';
          signals.push(sig.signal);
        }
      }
    }
  } catch {
    // Network error — return unknown
  }

  return { platform, confidence, signals };
}

export async function detect(url: string): Promise<FullDetectionResult> {
  const urlResult = detectFromUrl(url);
  if (urlResult) {
    return {
      url,
      platform: urlResult,
      confidence: 'high',
      signals: [`URL contains ${urlResult} domain`],
    };
  }

  const httpResult = await detectFromHttp(url);
  return { url, ...httpResult };
}
