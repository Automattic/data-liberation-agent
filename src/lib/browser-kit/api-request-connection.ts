/**
 * Headers for a Playwright APIRequestContext request (`context.request.*`,
 * `page.request.*`, `route.fetch`) that must not reuse a pooled socket.
 *
 * Every APIRequestContext in the process shares one keep-alive agent. A
 * reused TLS socket whose peer has already gone reports an empty peer
 * certificate, and playwright-core before 1.63 reads `subject.CN` from it
 * inside a socket event handler: the TypeError is uncaught and the whole
 * capture exits. `Connection: close` keeps each response's socket out of that
 * pool, so no request of ours is ever handed a stale one.
 */
export function closingConnection(headers: Record<string, string> = {}): Record<string, string> {
  const closing: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() !== 'connection') closing[name] = value;
  closing.connection = 'close';
  return closing;
}
