/**
 * The consent classifier shared by overlay dismissal and device equivalence.
 *
 * Consent managers render their own chrome on their own schedule, often laid
 * out per viewport (Cookiebot orders its buttons by width). That chrome is not
 * the page: `dismissOverlays` removes it before capture, and the per-route
 * device check and export's `documentsDiffer` leave it out of the structure
 * they compare, so a reordered consent dialog never makes a route `dual`.
 */

export const CONSENT_TEXT_RE = /\bcookies?\b|\bconsent\b|\bgdpr\b|\bccpa\b|\baccept all\b|privacy (policy|preferences)/i;
export const CONSENT_VENDOR_RE = /onetrust|cookiebot|usercentrics|termly|osano|trustarc|cookieyes|\bcc-window\b|\bcc-banner\b/i;

/** The consent evidence a candidate carries; see `isConsentNotice`. */
export interface ConsentEvidence {
  /** Lowercased text, truncated. */
  text: string;
  ariaLabel: string | null;
  /** Best-effort CSS path (tag, id, classes). */
  selector: string;
  /** Holds a navigation menu; its link labels are then not consent copy. */
  hasMenu?: boolean;
  /** Lowercased text outside links (set with `hasMenu`). */
  nonLinkText?: string;
}

/** Whether a candidate's text, label or identity names a cookie/consent notice. */
export function isConsentNotice(c: ConsentEvidence): boolean {
  // A pinned header that holds the site's menu commonly links to a "Privacy
  // Policy" or "Cookie Policy" page. Those menu labels are navigation, not a
  // consent notice: judge such chrome by the text outside its links only.
  const text = c.hasMenu && c.nonLinkText !== undefined ? c.nonLinkText : c.text;
  const hay = `${text} ${c.ariaLabel ?? ''} ${c.selector}`;
  return CONSENT_TEXT_RE.test(hay) || CONSENT_VENDOR_RE.test(hay);
}

/** Elements with dialog semantics; a consent notice among them is overlay chrome. */
export const CONSENT_OVERLAY_DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"],[aria-modal="true"]';

/** An element that may root a consent overlay, read from a live page or parsed HTML. */
export interface ConsentOverlayElement {
  tag: string;
  id: string;
  className: string;
  role: string | null;
  ariaModal: boolean;
  ariaLabel: string | null;
  /** Text content (any case, any length; normalized here). */
  text: string;
}

/**
 * Cheap necessary condition for `isConsentOverlayRoot`, so callers only read
 * text for elements that can qualify: dialog semantics or a consent vendor's
 * identity.
 */
export function mayRootConsentOverlay(element: { id: string; className: string; matchesDialog: boolean }): boolean {
  return element.matchesDialog || CONSENT_VENDOR_RE.test(`${element.id} ${element.className}`);
}

/**
 * Whether an element roots a consent overlay subtree: a consent vendor's own
 * element, or a dialog whose text or label is a consent notice. A non-consent
 * dialog (a newsletter modal) or page content mentioning cookies is not one.
 */
export function isConsentOverlayRoot(element: ConsentOverlayElement): boolean {
  const dialog = element.ariaModal || element.role === 'dialog' || element.role === 'alertdialog';
  if (!mayRootConsentOverlay({ id: element.id, className: element.className, matchesDialog: dialog })) return false;
  const classes = element.className.trim() ? `.${element.className.trim().split(/\s+/).join('.')}` : '';
  return isConsentNotice({
    text: element.text.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 400),
    ariaLabel: element.ariaLabel ? element.ariaLabel.toLowerCase() : null,
    selector: `${element.tag.toLowerCase()}${element.id ? `#${element.id}` : ''}${classes}`,
  });
}
