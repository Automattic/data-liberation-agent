export interface ConsentBannerLayout {
  min_width?: number;
  max_width?: number;
  direction: 'row' | 'column';
  align_items?: string;
  /** `stretch`: the control fills the panel's content width. */
  button_align?: 'start' | 'end' | 'stretch';
  text_margin?: string;
  /** Panel span at these widths; an inset panel records the edge it hugs. */
  span?: 'full' | 'inset';
  inline?: 'start' | 'end' | 'center';
  /** Inset panel border-box width and distance from its inline edge, in CSS pixels. */
  width?: number;
  inline_offset?: number;
  /** Distance from the anchored viewport edge at these widths. */
  edge_offset?: string;
  border_radius?: string;
}

/** Portable consent intent; field names are shared with static-site-importer. */
export interface ConsentBanner {
  schema: 'static-site-importer/consent-banner/v1';
  /** Body prose. A leading heading is recorded separately as `title`. */
  text: string;
  title?: string;
  accept_label: string;
  reject_label?: string;
  policy_link?: { label: string; href: string };
  position?: 'top' | 'bottom' | 'center';
  colors?: { background: string; text: string; button_background: string; button_text: string };
  presentation?: {
    span: 'full' | 'inset';
    edge_offset?: string;
    padding?: string;
    gap?: string;
    font_family?: string;
    font_size?: string;
    line_height?: string;
    text_margin?: string;
    /** Computed `box-shadow` of the painted panel. */
    box_shadow?: string;
    title?: { font_size?: string; line_height?: string; font_weight?: string; margin?: string; padding?: string };
    layout?: ConsentBannerLayout[];
    button?: { border_radius?: string; border_width?: string; border_style?: string; border_color?: string; padding?: string; font_size?: string; font_family?: string; line_height?: string; font_weight?: string; letter_spacing?: string; min_height?: string; margin?: string };
  };
  source_selector?: string;
}
