# Incomplete source TLS chains

Signature: `capture/tls-incomplete-chain-aia`.

The shared capture entrypoint retries its initial Node HTTP request after a
best-effort AIA recovery, only for `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` or
`UNABLE_TO_VERIFY_LEAF_SIGNATURE`. CLI, MCP and capture-engine callers use the
same entrypoint. Successful initial requests do not perform a TLS preflight.

Recovery inspects the presented chain without sending application data. It
follows CA Issuers HTTP(S) URLs, accepting DER or PEM certificates, with at most
five issuer downloads, three redirects per download, 256 KiB per response and
an eight-second overall deadline. Downloads use capture's normal SSRF guard;
local issuer endpoints require the caller's explicit trusted origin just like
other local HTTP resources. Cycles, invalid signatures, non-CA issuers and
expired certificates stop recovery.

A downloaded certificate is not an independent trust anchor. The chain must
reach a CA already in Node's default set, and a fresh strict TLS handshake must
succeed with the completed chain before any certificates are installed. Hostname,
purpose, constraints and validity verification remain enabled. The process CA
set is extended, not replaced; this also benefits later discovery and media
requests without modifying individual fetch call sites. Concurrent recovery for
one origin is coalesced, and concurrent origins merge their additions. Recovery
failures leave the normal capture request to report its verification error.
Node versions without `getCACertificates` / `setDefaultCACertificates` retain
normal TLS behavior (these APIs require Node 22.19+ or 24.5+).

## Issue #1218 live verification

Observed in this checkout on Node v24.18.0:

- Before recovery, plain `fetch('https://dionews.com.br')` failed with
  `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.
- After `completeSourceTlsChain` received that failure, the same plain fetch
  returned HTTP 200, without `NODE_EXTRA_CA_CERTS` or a verification bypass.
- A CLI browser capture of that source with `--route-limit 1` exported its
  entrypoint successfully (four routes omitted by the declared budget).
- `compare` checked the entrypoint offline without findings but remained
  **unproven** at all three baseline widths: source evidence reported
  `page.evaluate: TypeError: Number.parseFloat is not a function`. This is not
  a claim of visual fidelity; TLS recovery and entrypoint export succeeded.

The deterministic regression uses local HTTP and HTTPS servers and a generated
root → intermediate → leaf chain. HTTPS serves only the leaf and HTTP serves
its AIA issuer. It verifies failure before recovery and ordinary fetch success
afterwards, plus unchanged trust on malformed, cyclic, untrusted and expired
chains and blocked private issuer URLs. It requires OpenSSL and skips recovery
coverage on Node versions lacking the CA-set APIs.
