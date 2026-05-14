import { describe, it, expect, vi } from 'vitest';
import { analyzePage, type PageAnalysis } from './site-analysis.js';

function makeMockPage(returnValue: unknown) {
  return { evaluate: vi.fn().mockResolvedValue(returnValue) };
}

describe('analyzePage', () => {
  it('returns palette, typography, and metadata', async () => {
    const mock: PageAnalysis = {
      palette: [
        { hex: '#ffffff', count: 100 },
        { hex: '#000000', count: 50 },
      ],
      typography: {
        h1: { fontFamily: 'Helvetica', fontSize: '32px', fontWeight: '700', lineHeight: '40px' },
        body: { fontFamily: 'Helvetica', fontSize: '16px', fontWeight: '400', lineHeight: '24px' },
      },
      metadata: {
        title: 'About',
        metaDescription: 'Learn more',
        openGraph: { 'og:title': 'About', 'og:image': 'https://example.com/og.png' },
        jsonLdTypes: ['WebPage'],
        htmlBytes: 12_345,
      },
    };
    const page = makeMockPage(mock);
    const result = await analyzePage(page as never);
    expect(result.palette).toHaveLength(2);
    expect(result.typography.h1?.fontFamily).toBe('Helvetica');
    expect(result.metadata.title).toBe('About');
  });

  it('validates return shape and rejects garbage — missing palette', async () => {
    const page = makeMockPage({ not: 'valid' });
    await expect(analyzePage(page as never)).rejects.toThrow(/palette|shape/i);
  });

  it('rejects when typography missing', async () => {
    const page = makeMockPage({ palette: [], metadata: {} });
    await expect(analyzePage(page as never)).rejects.toThrow(/typography|shape/i);
  });

  it('rejects when metadata missing', async () => {
    const page = makeMockPage({ palette: [], typography: {} });
    await expect(analyzePage(page as never)).rejects.toThrow(/metadata|shape/i);
  });
});
