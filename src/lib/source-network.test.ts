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
	it('keeps mixed browser/HTTP traffic below a learned ceiling and stops on a forced block', async () => {
		const governorUrl = new URL('./source-request-governor.ts', import.meta.url).href;
		const { stdout } = await child(`
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { SourceRequestGovernor } from ${JSON.stringify(governorUrl)};
let throttles = 0;
let forceBlock = false;
const arrivals = [];
const server = createServer((req, res) => {
  const now = Date.now();
  arrivals.push(now);
  const recent = arrivals.filter(time => now - time < 1000).length;
  if (forceBlock || throttles >= 2) { res.writeHead(403); res.end(); }
  else if (recent > 4) { throttles++; res.writeHead(429, { 'retry-after': '1' }); res.end(); }
  else res.end('ok');
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const origin = 'http://127.0.0.1:' + server.address().port;
const governor = new SourceRequestGovernor(origin, { recoveryStep: 1 });
try {
  for (let i = 0; i < 5; i++) await governor.run(() => fetch(origin + '/' + i), { maxAttempts: 1 });
  const ceiling = governor.stats().learnedRateCeiling;
  assert.equal(ceiling, 2.5);
  const start = arrivals.length;
  await Promise.all(Array.from({length: 8}, (_, i) => governor.run(() => fetch(origin + '/next-' + i), { browser: i % 2 === 0 })));
  assert.equal(throttles, 1);
  const paced = arrivals.slice(start);
  for (let i = 1; i < paced.length; i++) assert.ok(paced[i] - paced[i - 1] >= 1000 / ceiling - 15);
  forceBlock = true;
  await governor.run(() => fetch(origin + '/forced'));
  assert.equal(governor.stats().stopReason, 'source_blocked_client');
  const count = arrivals.length;
  await assert.rejects(governor.run(() => fetch(origin + '/pending')), { code: 'source_blocked_client' });
  assert.equal(arrivals.length, count);
  console.log('paced and resumable');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
`);
		expect(stdout.trim()).toBe('paced and resumable');
	});
	it( 'fetches a local origin whose TCP connection takes more than 250 ms', async () => {
		const { stdout } = await child( `
const { sourceFetch: request } = await import(${ JSON.stringify( sourceFetchUrl ) });
${ slowConnect }
` );
		expect( stdout.trim() ).toBe( 'captured' );
	} );

	it( 'the delayed-connect fixture fails with the unmodified Node default', async () => {
		await expect( child( `const request = fetch;\n${ slowConnect }` ) ).rejects.toMatchObject( {
			// Node 24 can hit the fixture's outer deadline before surfacing the
			// per-address timeout. Both are a failed connection, never a response.
			stderr: expect.stringMatching( /ETIMEDOUT|TimeoutError/ ),
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
