import type { Browser, BrowserContext, BrowserContextOptions, Page, Route } from 'playwright';

/** Configure Chromium itself, not just context headers (Chromium adds hints later).
 * Every page is configured before its first request, including popups. Routing is
 * also a barrier for pages created by the browser rather than context.newPage().
 */
export async function installSourceIdentity(context: BrowserContext, options: BrowserContextOptions): Promise<void> {
  const userAgent = options.userAgent;
  if (!userAgent) return;
  const chrome = userAgent.match(/(?:Chrome|Chromium)\/([\d.]+)/);
  const mobile = /Mobile|Android|iPhone|iPad/.test(userAgent);
  const platform = /iPhone|iPad/.test(userAgent) ? 'iOS' : /Android/.test(userAgent) ? 'Android' : /Windows/.test(userAgent) ? 'Windows' : /Macintosh/.test(userAgent) ? 'macOS' : 'Linux';
  const brands = chrome ? [
    { brand: 'Not_A Brand', version: '99' },
    { brand: 'Chromium', version: chrome[1].split('.')[0] },
    { brand: 'Google Chrome', version: chrome[1].split('.')[0] },
  ] : [];
  const metadata = {
    brands,
    fullVersionList: brands.map(entry => ({ ...entry, version: entry.brand === 'Not_A Brand' ? '99.0.0.0' : chrome![1] })),
    fullVersion: chrome?.[1] ?? '', platform, mobile,
    architecture: /Android|iPhone|iPad/.test(userAgent) ? 'arm' : 'x86',
    bitness: '64', model: userAgent.match(/Android[^;]*;\s*([^;)]+?)(?: Build\/[^;)]+)?\)/)?.[1] ?? '',
    platformVersion: platform === 'Windows' ? '10.0.0' : (userAgent.match(/(?:Android |Mac OS X |(?:iPhone )?OS )([\d_\.]+)/)?.[1] ?? '').replaceAll('_', '.'),
    wow64: false,
  };
  const configured = new WeakMap<Page, Promise<void>>();
  const configure = (page: Page): Promise<void> => {
    let pending = configured.get(page);
    if (!pending) {
      pending = (async () => {
        const session = await context.newCDPSession(page);
        await session.send('Network.setUserAgentOverride', {
          userAgent,
          acceptLanguage: options.locale ?? 'en-US',
          platform: platform === 'iOS' ? 'iPhone' : platform === 'macOS' ? 'MacIntel' : platform === 'Windows' ? 'Win32' : platform === 'Android' ? 'Linux armv8l' : 'Linux x86_64',
          // Omitting metadata disables Chromium's UA hints for WebKit identities.
          ...(chrome ? { userAgentMetadata: metadata } : {}),
        });
        // Keep the session alive for the target's lifetime.
      })();
      configured.set(page, pending);
    }
    return pending;
  };
  const ownedPages = new WeakSet<Page>();
  context.on('page', page => {
    page.once('domcontentloaded', () => { void configure(page).catch(() => {}); });
  });
  const newPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await newPage();
    ownedPages.add(page);
    await configure(page);
    return page;
  };
  await context.route('**/*', async route => {
    try { await applyIdentity(route); }
    catch {
      // Closing the page or context mid-request already handled this route;
      // for any other failure the request proceeds rather than stalling.
      await route.fallback().catch(() => {});
    }
  });
  async function applyIdentity(route: Route): Promise<void> {
    let page: Page | undefined;
    try { page = route.request().frame().page(); } catch { /* Popup navigation precedes its frame. */ }
    if (page) await configure(page);
    const headers = await route.request().allHeaders();
    if (!chrome) {
      for (const name of Object.keys(headers)) if (name.toLowerCase().startsWith('sec-ch-ua')) delete headers[name];
    } else {
      // The initial request of a popup may have been assembled before the CDP
      // override. Supply the same metadata-derived headers for that request.
      const serialize = (entries: typeof brands) => entries.map(entry => `"${entry.brand}";v="${entry.version}"`).join(', ');
      const highHints: Record<string, string> = {
        'sec-ch-ua-full-version-list': serialize(metadata.fullVersionList),
        'sec-ch-ua-full-version': JSON.stringify(metadata.fullVersion),
        'sec-ch-ua-platform-version': JSON.stringify(metadata.platformVersion),
        'sec-ch-ua-arch': JSON.stringify(metadata.architecture),
        'sec-ch-ua-bitness': JSON.stringify(metadata.bitness),
        'sec-ch-ua-model': JSON.stringify(metadata.model),
        'sec-ch-ua-wow64': '?0',
        'sec-ch-ua-form-factors': mobile ? '"Mobile"' : '"Desktop"',
      };
      for (const name of Object.keys(headers)) if (name.startsWith('sec-ch-ua')) {
        delete headers[name];
        if (highHints[name]) headers[name] = highHints[name];
      }
      headers['sec-ch-ua'] = brands.map(entry => `"${entry.brand}";v="${entry.version}"`).join(', ');
      headers['sec-ch-ua-mobile'] = mobile ? '?1' : '?0';
      headers['sec-ch-ua-platform'] = JSON.stringify(platform);
    }
    if (!page || !ownedPages.has(page)) {
      // Popup main requests have no target yet. Fetch with the context's cookies
      // and explicit identity instead of allowing Chromium to add native hints.
      const response = await route.fetch({ headers, maxRedirects: 0 });
      try { await route.fulfill({ response }); }
      finally { await response.dispose(); }
    } else await route.continue({ headers });
  }
  if (!chrome) await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'userAgentData', { configurable: true, get: () => undefined });
    Object.defineProperty(Navigator.prototype, 'vendor', { configurable: true, get: () => 'Apple Computer, Inc.' });
  });
}

/** Source contexts must use this factory, not just spread identity options. */
export async function createSourceContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  const context = await browser.newContext({ ...options, serviceWorkers: 'block' });
  try {
    await installSourceIdentity(context, options);
    return context;
  } catch (error) {
    await context.close().catch(() => {});
    throw error; // failure-class: operational
  }
}

/** Like browser.newPage, but with context-wide source identity and page-owned cleanup. */
export async function createSourcePage(browser: Browser, options: BrowserContextOptions): Promise<Page> {
  const context = await createSourceContext(browser, options);
  try {
    const page = await context.newPage();
    page.once('close', () => { void context.close().catch(() => {}); });
    return page;
  } catch (error) {
    await context.close().catch(() => {});
    throw error; // failure-class: operational
  }
}
