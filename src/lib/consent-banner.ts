export interface ConsentBannerLayout {
  min_width?: number;
  max_width?: number;
  direction: 'row' | 'column';
  align_items?: string;
  button_align?: 'start' | 'end';
  text_margin?: string;
}

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
    text_margin?: string;
    layout?: ConsentBannerLayout[];
    button?: { border_radius?: string; border_width?: string; border_style?: string; border_color?: string; padding?: string; font_size?: string; font_family?: string; line_height?: string };
  };
  source_selector?: string;
}
