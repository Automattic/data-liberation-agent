import type { Page } from 'playwright';

/**
 * GoDaddy's contact-map component owns one marker at its lat/lon props. The
 * Google view link only gives the independently movable map centre. Preserve
 * the component's location as inert capture evidence while its runtime exists.
 */
export async function preserveGoDaddyMapMarkers(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const host of document.querySelectorAll('[data-aid="CONTACT_MAP_REND"]')) {
      const maps = host.querySelectorAll('.gm-style');
      for (const map of maps) map.removeAttribute('data-blocks-engine-capture-google-map-marker');
      if (maps.length !== 1) continue;
      const key = Object.getOwnPropertyNames(host).find(name => name.startsWith('__reactFiber$'));
      if (!key) continue;
      type Fiber = { memoizedProps?: { type?: unknown; lat?: unknown; lon?: unknown }; return?: Fiber };
      let fiber: Fiber | undefined = (host as unknown as Record<string, Fiber>)[key];
      const seen = new Set<Fiber>();
      for (let depth = 0; fiber && depth < 32 && !seen.has(fiber); depth++, fiber = fiber.return) {
        seen.add(fiber);
        const props = fiber.memoizedProps;
        if (props?.type !== 'google') continue;
        const lat = typeof props.lat === 'number' || typeof props.lat === 'string' ? String(props.lat) : '';
        const lng = typeof props.lon === 'number' || typeof props.lon === 'string' ? String(props.lon) : '';
        if (!/^-?\d+(?:\.\d+)?$/.test(lat) || !/^-?\d+(?:\.\d+)?$/.test(lng)) continue;
        if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lng)) || Math.abs(Number(lat)) > 90 || Math.abs(Number(lng)) > 180) continue;
        maps[0]!.setAttribute('data-blocks-engine-capture-google-map-marker', JSON.stringify({lat,lng}));
        break;
      }
    }
  });
}
