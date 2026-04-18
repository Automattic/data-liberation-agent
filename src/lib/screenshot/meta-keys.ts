/**
 * Postmeta/CSV meta keys used by Tier 2 stamping to join screenshots onto
 * imported content. Stable public-facing keys — renaming is a breaking change
 * for any consumer reading a previously-imported WordPress site.
 */
export const LIBERATION_META_KEYS = {
  desktop: '_liberation_screenshot_desktop',
  desktopScrolled: '_liberation_screenshot_desktop_scrolled',
  mobile: '_liberation_screenshot_mobile',
  mobileScrolled: '_liberation_screenshot_mobile_scrolled',
  html: '_liberation_html',
} as const;
