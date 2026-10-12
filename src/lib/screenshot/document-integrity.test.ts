import { describe, it, expect } from 'vitest';
import { countBodyTags, documentElementTags, isRouteDrift, isStackingArtifact, serverRedirectTarget } from './document-integrity.js';

describe('document-integrity', () => {
  it('counts a clean single-document page as one body', () => {
    const html = '<!doctype html><html><head></head><body><main>hi</main></body></html>';
    expect(countBodyTags(html)).toBe(1);
    expect(isStackingArtifact(html)).toBe(false);
  });

  it('detects a document nested into itself (the 11× capture artifact)', () => {
    const inner = '<body><main>page</main></body>';
    const html = `<!doctype html><html><head></head>${inner.repeat(11)}</html>`;
    expect(countBodyTags(html)).toBe(11);
    expect(isStackingArtifact(html)).toBe(true);
  });

  it('matches <body> with attributes and is case-insensitive', () => {
    const html = '<HTML><BODY class="x"><div></div></BODY></HTML>';
    expect(countBodyTags(html)).toBe(1);
    expect(isStackingArtifact(html)).toBe(false);
  });

  it('does not count a literal "<body" inside text/attribute strings without a tag delimiter', () => {
    // "<bodyguard" must not be mistaken for a <body> tag.
    const html = '<html><body><p>&lt;bodyguard&gt; and <bodyguard></p></body></html>';
    expect(countBodyTags(html)).toBe(1);
  });

  it('does not count "<body" in scripts, comments, textareas, templates, titles or attribute values', () => {
    const html = `<html><head><title>a <body> b</title></head><body data-x="<body>" title='x > <body class=y>'>
      <script>w.document.write('<body leftmargin="0"><img></body>');</script>
      <style>/* <body> */</style><!-- <body> --><textarea><body></textarea>
      <template><body><template><body></template><body></template></body></html>`;
    expect(countBodyTags(html)).toBe(1);
    expect(isStackingArtifact(html)).toBe(false);
  });

  it('counts real body elements that follow raw-text content', () => {
    const html = '<body><script>var a="<body>"</script><div><body class="b"></body></div></body>';
    expect(countBodyTags(html)).toBe(2);
    expect(isStackingArtifact(html)).toBe(true);
  });
});

describe('documentElementTags', () => {
  const slice = (html: string, at?: { start: number; end: number }) => (at ? html.slice(at.start, at.end) : undefined);

  it('finds the real body tags past body markup inside a script string', () => {
    const html = `<html><head><title>t</title></head><body class="home"><main>a</main>
      <script>w.document.write('<body leftmargin="0"><img src="' + src + '"></body>'); if (i<n.length) go();</script>
      <p>after</p></body></html>`;
    const { open, close } = documentElementTags(html, 'body');
    expect(slice(html, open)).toBe('<body class="home">');
    expect(open?.attributes).toBe(' class="home"');
    expect(slice(html, close)).toBe('</body>');
    expect(html.slice(open!.end, close!.start)).toContain('<p>after</p>');
  });

  it('skips head and body markup in head scripts, comments, templates and attribute values', () => {
    const html = `<html><head><!-- </head> --><script>d.write("<head></head><body>x</body>")</script>
      <meta content="</head><body>"></head><body data-x="a > b"><template></body></template><p>x</p></BODY></html>`;
    const head = documentElementTags(html, 'head');
    expect(html.slice(head.close!.start)).toMatch(/^<\/head><body data-x/);
    const body = documentElementTags(html, 'body');
    expect(slice(html, body.open)).toBe('<body data-x="a > b">');
    expect(slice(html, body.close)).toBe('</BODY>');
  });

  it('reports a missing tag instead of guessing', () => {
    expect(documentElementTags('<html><head></head><main>x</main></html>', 'body')).toEqual({});
    const unclosed = '<html><body><p>x</p><script>"</body>"';
    expect(documentElementTags(unclosed, 'body').close).toBeUndefined();
    // An end tag with no start tag (a head-less document) is still found.
    expect(documentElementTags('<title>x</title></head><body></body>', 'head').close).toEqual({ start: 16, end: 23 });
  });
});

describe('isRouteDrift', () => {
  it('is not drift when the captured URL exactly matches the intended one', () => {
    expect(isRouteDrift('https://example.com/Home', 'https://example.com/Home')).toBe(false);
  });

  it('flags drift when a control navigated to a genuinely different route (the base44 View All case)', () => {
    expect(isRouteDrift('https://example.com/Browse', 'https://example.com/Home')).toBe(true);
  });

  it('flags drift across different origins even when the path matches', () => {
    expect(isRouteDrift('https://evil.example/Home', 'https://example.com/Home')).toBe(true);
  });

  it('tolerates a trailing slash difference', () => {
    expect(isRouteDrift('https://example.com/Home/', 'https://example.com/Home')).toBe(false);
    expect(isRouteDrift('https://example.com/Home', 'https://example.com/Home/')).toBe(false);
  });

  it('tolerates a hash difference (an in-page anchor, or scroll restoration)', () => {
    expect(isRouteDrift('https://example.com/Home#section-2', 'https://example.com/Home')).toBe(false);
  });

  it('tolerates a query string difference (a tracking param a runtime appended)', () => {
    expect(isRouteDrift('https://example.com/Home?ref=abc', 'https://example.com/Home')).toBe(false);
  });

  it('tolerates the SPA\'s own initial replaceState to the same path plus a hash', () => {
    expect(isRouteDrift('https://example.com/Home#/Home', 'https://example.com/Home')).toBe(false);
  });

  it('treats an unparseable URL as drift rather than silently accepting it', () => {
    expect(isRouteDrift('not a url', 'https://example.com/Home')).toBe(true);
    expect(isRouteDrift('https://example.com/Home', 'not a url')).toBe(true);
  });

  it('resolves a same-origin server redirect to another route as its target', () => {
    expect(serverRedirectTarget('https://example.com/about', 'https://example.com/about-us')).toBe('https://example.com/about-us');
    // Same route (trailing slash, query) or another origin is not an alias.
    expect(serverRedirectTarget('https://example.com/about', 'https://example.com/about/?x=1')).toBeUndefined();
    expect(serverRedirectTarget('https://example.com/about', 'https://other.example/about-us')).toBeUndefined();
  });

  it('recognizes observed HTTP/HTTPS aliases without weakening post-load drift', () => {
    expect(serverRedirectTarget('https://example.com/old', 'http://example.com/new/')).toBe('http://example.com/new/');
    expect(serverRedirectTarget('http://example.com/old', 'https://example.com/new/')).toBe('https://example.com/new/');
    expect(serverRedirectTarget('https://example.com/author', 'http://example.com/author/')).toBeUndefined();
    expect(isRouteDrift('http://example.com/author/', 'https://example.com/author')).toBe(true);
    expect(serverRedirectTarget('https://example.com/old', 'http://other.example/new')).toBeUndefined();
    expect(serverRedirectTarget('https://example.com/old', 'http://example.com:8080/new')).toBeUndefined();
    expect(serverRedirectTarget('https://example.com/old', 'http://user:secret@example.com/new')).toBeUndefined();
    expect(serverRedirectTarget('https://example.com/old', 'ftp://example.com/new')).toBeUndefined();
  });
});
