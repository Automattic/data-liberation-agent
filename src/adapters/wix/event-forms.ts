import type { Page } from 'playwright';

/** Wix Events returns 200 for expired /form URLs, then navigates to the event. */
export function eventFormRedirect(requested: string, settled: string): string | undefined {
  try {
    const form = new URL(requested);
    const target = new URL(settled);
    const match = form.pathname.match(/^(.*\/event-details\/[^/]+)\/form\/?$/);
    if (!match || form.origin !== target.origin) return undefined;
    return target.pathname.replace(/\/+$/, '') === match[1] ? target.origin + match[1] : undefined;
  } catch {
    return undefined;
  }
}

/** A timeout means the registration may still be active; never infer expiry from age or markup. */
export async function resolveEventFormRedirect(page: Page, url: string): Promise<string | undefined> {
  if (!/\/event-details\/[^/]+\/form\/?$/.test(new URL(url).pathname)) return undefined;
  try {
    await page.waitForURL((settled) => !!eventFormRedirect(url, settled.href), { timeout: 6500 });
  } catch {
    // Keep the form if the destination was not observed within the bounded probe.
  }
  return eventFormRedirect(url, page.url());
}
