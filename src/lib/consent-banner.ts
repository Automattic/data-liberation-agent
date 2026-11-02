/** Portable consent intent; field names are shared with static-site-importer. */
export interface ConsentBanner {
  schema: 'static-site-importer/consent-banner/v1';
  text: string;
  accept_label: string;
  reject_label?: string;
  policy_link?: { label: string; href: string };
  position?: 'top' | 'bottom' | 'center';
  colors?: { background: string; text: string; button_background: string; button_text: string };
  source_selector?: string;
}
