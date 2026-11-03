/** Portable consent intent; field names are shared with static-site-importer. */
export interface ConsentBanner {
  schema: 'static-site-importer/consent-banner/v1';
  text: string;
  accept_label: string;
  reject_label?: string;
  policy_link?: { label: string; href: string };
  position?: 'top' | 'bottom' | 'center';
  colors?: { background: string; text: string; button_background: string; button_text: string };
  presentation?: {
    span: 'full' | 'inset';
    edge_offset?: string;
    padding?: string;
    font_family?: string;
    font_size?: string;
    line_height?: string;
    button?: { border_radius?: string; padding?: string; font_size?: string; font_family?: string };
  };
  source_selector?: string;
}
