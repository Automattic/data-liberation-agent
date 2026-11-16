import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify( execFile );

// Isolate net defaults and the native TCP test shim from Vitest and other tests.
async function child( code: string, timeout = 250 ) {
	return exec( process.execPath, [
		`--network-family-autoselection-attempt-timeout=${ timeout }`,
		'--import', 'tsx', '--input-type=module', '-e', code,
	], { timeout: 15_000 } );
}

const sourceFetchUrl = new URL( './media-fetch/capture-requests.ts', import.meta.url ).href;

// Delaying a server's HTTP response (or its 'connection' listener) does not
// delay the kernel's handshake. Instead hold the native connect invocation for
// 400 ms, below net.Socket but above the OS, while Node's real per-address timer
// runs. DNS supplies two addresses so family autoselection actually runs. This
// exercises a real fetch and local HTTP server without root/netem privileges.
const slowConnect = `
import assert from 'node:assert/strict';
import dns from 'node:dns';
import { createServer } from 'node:http';
import { once } from 'node:events';
const { TCP } = process.binding('tcp_wrap');
const connect = TCP.prototype.connect;
const close = TCP.prototype.close;
const pending = new WeakMap();
let attempts = 0;
TCP.prototype.connect = function (...args) {
  attempts++;
  pending.set(this, setTimeout(() => {
    pending.delete(this);
    connect.apply(this, args);
  }, 400));
  return 0;
};
TCP.prototype.close = function (...args) {
  clearTimeout(pending.get(this));
  pending.delete(this);
  return close.apply(this, args);
};
const lookup = dns.lookup;
dns.lookup = (host, options, callback) => {
  if (host !== 'slow-source.test') return lookup(host, options, callback);
  assert.equal(options.all, true);
  queueMicrotask(() => callback(null, [
    { address: '127.0.0.1', family: 4 },
    { address: '127.0.0.2', family: 4 },
  ]));
};
const server = createServer((req, res) => res.end('captured'));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const url = 'http://slow-source.test:' + server.address().port;
try {
  const response = await request(url, { signal: AbortSignal.timeout(3000) });
  assert.equal(await response.text(), 'captured');
  assert.equal(attempts, 1);
  console.log('captured');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
`;

describe( 'Node source connection budget', () => {
	it( 'fetches a local origin whose TCP connection takes more than 250 ms', async () => {
		const { stdout } = await child( `
const { sourceFetch: request } = await import(${ JSON.stringify( sourceFetchUrl ) });
${ slowConnect }
` );
		expect( stdout.trim() ).toBe( 'captured' );
	} );

	it( 'the delayed-connect fixture fails with the unmodified Node default', async () => {
		await expect( child( `const request = fetch;\n${ slowConnect }` ) ).rejects.toMatchObject( {
			stderr: expect.stringContaining( 'ETIMEDOUT' ),
		} );
	} );

	it( 'preserves a longer application-configured timeout', async () => {
		const { stdout } = await child( `
import { getDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
await import(${ JSON.stringify( sourceFetchUrl ) });
console.log(getDefaultAutoSelectFamilyAttemptTimeout());
`, 5000 );
		expect( stdout.trim() ).toBe( '5000' );
	} );
} );
