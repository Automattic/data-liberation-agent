import type { CheerioAPI } from 'cheerio';
import type { Element } from 'domhandler';
import type { InstanceStyleSheet } from './instance-styles.js';

export interface EmitJetpackFormOpts {}

export interface EmitJetpackFormResult {
  markup: string;
  fieldCount: number;
}

export function emitJetpackForm(
  $: CheerioAPI,
  formEl: Element,
  sheet: InstanceStyleSheet,
  opts: EmitJetpackFormOpts = {},
): EmitJetpackFormResult | null {
  void $;
  void formEl;
  void sheet;
  void opts;
  return null;
}
