/**
 * Width a portable visual iframe keeps.
 *
 * Capture attests each visible iframe's rendered pixel box in one viewport.
 * That box is the right fallback for frames whose authored width is absent or
 * already absolute, but an authored percentage (`width="100%"`) is a statement
 * about the containing block, not a pixel size: freezing it to the capture
 * viewport's measurement makes the frame overflow every narrower viewport.
 * Percentage widths always resolve against a definite containing-block width,
 * so they stay portable and win over the attested measurement.
 */
export function portableVisualIframeWidth( authored: string | undefined, attested: string ): string {
	const value = authored?.trim() ?? '';
	return /^(?:\d+(?:\.\d+)?|\.\d+)%$/.test( value ) && parseFloat( value ) > 0 ? value : attested;
}
