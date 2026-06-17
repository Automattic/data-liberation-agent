export const JETPACK_FORMS_PLUGIN_INSTALL = {
  pluginSlug: 'jetpack',
  wpArgs: ['plugin', 'install', 'jetpack', '--activate'],
  gateDescription: 'formsConverted >= 1',
  flowLocation: 'after theme activation and before optional local interactivity plugin activation',
  failureMode: 'non-fatal warning only',
  warningPrefix: 'jetpack install/activate failed',
  localFormsNote: 'Jetpack Forms blocks render and store submissions locally without a WordPress.com connection.',
} as const;

export function shouldInstallJetpackFormsPlugin(formsConverted: number): boolean {
  return formsConverted >= 1;
}

export function jetpackFormsPluginInstallWarning(error: Error): string {
  return `${JETPACK_FORMS_PLUGIN_INSTALL.warningPrefix}: ${error.message}. ${JETPACK_FORMS_PLUGIN_INSTALL.localFormsNote}`;
}
