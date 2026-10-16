/**
 * Runs inside the page during serialization. Google Maps JS paints temporary
 * tiles and controls, whose event handlers cannot survive portable HTML. Its
 * own view link is durable evidence of the map's centre, zoom and language.
 * Port only that observed view, on the clone, so later source probes keep the
 * original live map. Maps without an unambiguous location remain untouched.
 * All helpers stay inside this function so its browser copy is self-contained.
 */
export function portRenderedGoogleMaps(
  source: Document,
  snapshot: HTMLElement,
  evidenceAttributes: { src: string; width: string; height: string },
): void {
  const maps = source.querySelectorAll('.gm-style');
  const copies = snapshot.querySelectorAll('.gm-style');
  let ported = false;
  for (let index = 0; index < maps.length; index++) {
    const map = maps[index]!;
    const copy = copies[index];
    const markerEvidence = map.getAttribute('data-blocks-engine-capture-google-map-marker');
    copy?.removeAttribute('data-blocks-engine-capture-google-map-marker');
    const bounds = map.getBoundingClientRect();
    if (!copy || bounds.width <= 0 || bounds.height <= 0 || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)) continue;
    if (typeof map.checkVisibility === 'function' && !map.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) continue;
    let embed: URL | undefined;
    for (const link of map.querySelectorAll<HTMLAnchorElement>('a[href]')) {
      let view: URL;
      try { view = new URL(link.href); } catch { continue; }
      if (view.protocol !== 'https:' || !['maps.google.com', 'www.google.com', 'google.com'].includes(view.hostname) || !/^\/maps\/?$/.test(view.pathname)) continue;
      const coordinates = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(view.searchParams.get('ll') ?? '');
      if (!coordinates) continue;
      const lat = Number(coordinates[1]);
      const lng = Number(coordinates[2]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) continue;
      const candidate = new URL('https://maps.google.com/maps');
      // ll is the viewport centre, not a marker. q would invent a pin there.
      // Keep the observed precision instead of manufacturing a rounded point.
      candidate.searchParams.set('ll', coordinates[0]);
      const zoom = view.searchParams.get('z');
      if (zoom !== null && (!/^\d+(?:\.\d+)?$/.test(zoom) || Number(zoom) > 30)) continue;
      if (zoom !== null) candidate.searchParams.set('z', zoom);
      const mapType = view.searchParams.get('t');
      if (mapType && /^[mkph]$/.test(mapType)) candidate.searchParams.set('t', mapType);
      const language = view.searchParams.get('hl');
      if (language && /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/.test(language)) candidate.searchParams.set('hl', language);
      candidate.searchParams.set('output', 'embed');
      // Conflicting view links are not sufficient evidence to choose one map.
      if (embed && embed.href !== candidate.href) { embed = undefined; break; }
      embed = candidate;
    }
    if (!embed) continue;
    if (markerEvidence) {
      try {
        const marker: unknown = JSON.parse(markerEvidence);
        const {lat,lng} = marker as {lat?:unknown;lng?:unknown};
        if (typeof lat === 'string' && typeof lng === 'string' && /^-?\d+(?:\.\d+)?$/.test(lat) && /^-?\d+(?:\.\d+)?$/.test(lng) && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng)) && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180) {
          // q is justified only by source-owned marker evidence, never ll.
          embed.searchParams.delete('output');
          embed.searchParams.set('q', `${lat},${lng}`);
          embed.searchParams.set('output', 'embed');
        }
      } catch {
        // Invalid marker evidence cannot turn a view centre into a pin.
      }
    }
    const frame = source.createElement('iframe');
    frame.src = embed.href;
    frame.title = 'Google Maps';
    frame.className = 'data-blocks-engine-capture-google-map-embed';
    frame.width = String(Math.max(1, Math.round(bounds.width)));
    frame.height = String(Math.max(1, Math.round(bounds.height)));
    frame.setAttribute(evidenceAttributes.src, frame.src);
    frame.setAttribute(evidenceAttributes.width, frame.width);
    frame.setAttribute(evidenceAttributes.height, frame.height);
    copy.replaceChildren(frame);
    ported = true;
  }
  if (ported) {
    // Export strips inline iframe styles. An ordinary sheet keeps the bounded
    // surface filling its original responsive owner after that sanitization.
    const style = source.createElement('style');
    style.textContent = '.data-blocks-engine-capture-google-map-embed{display:block;width:100%;height:100%;border:0}';
    snapshot.querySelector('head')?.appendChild(style);
  }
}
