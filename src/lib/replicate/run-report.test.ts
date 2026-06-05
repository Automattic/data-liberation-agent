import { describe, it, expect } from 'vitest';
import { buildRunReport, type RunReportInput } from './run-report.js';
import type { SectionParity, SectionParitySignals, SectionAcceptance } from './section-parity.js';

const sec = (
  signals: Partial<SectionParitySignals> = {},
  acceptance?: SectionAcceptance,
): SectionParity => ({
  band: 'band',
  score: 10,
  status: 'match',
  evidence: { srcSample: '#fff', repSample: '#fff' },
  signals: {
    sectionPresent: true,
    bgDeltaE: 1,
    columnCountMatch: true,
    mediaPresent: true,
    fallbackUnstyled: false,
    ...signals,
  },
  acceptance,
});

const good = (): RunReportInput => ({
  site: 'example.com',
  clusters: [{ key: 'a', representative: 'https://x/', built: true, gatePassed: true }],
  pagesComposed: 5, pagesMisfit: 0,
  responsive: [{ archetype: 'homepage', responsive: true }],
  provenanceFlags: 0, fallbackPages: 0,
});

describe('buildRunReport', () => {
  it('verdict pass when everything is clean', () => {
    expect(buildRunReport(good()).verdict.overall).toBe('pass');
  });
  it('verdict fail when a cluster gate failed', () => {
    const i = good();
    i.clusters[0].gatePassed = false;
    expect(buildRunReport(i).verdict.overall).toBe('fail');
  });
  it('verdict fail when an archetype is not responsive (hard gate)', () => {
    const i = good();
    i.responsive = [{ archetype: 'homepage', responsive: false }];
    expect(buildRunReport(i).verdict.overall).toBe('fail');
  });
  it('verdict warn on fallback pages', () => {
    const i = good();
    i.fallbackPages = 2;
    expect(buildRunReport(i).verdict.overall).toBe('warn');
  });
  it('summary counts clusters and responsiveness', () => {
    const r = buildRunReport(good());
    expect(r.summary.clustersBuilt).toBe(1);
    expect(r.summary.clustersFailed).toBe(0);
    expect(r.summary.responsivePass).toBe(1);
  });
});

describe('buildRunReport — html fallback islands', () => {
  it('surfaces htmlFallbackSections in the summary', () => {
    const i = good();
    i.htmlFallbackSections = 3;
    expect(buildRunReport(i).summary.htmlFallbackSections).toBe(3);
  });
  it('warns when there are html fallback islands on an otherwise-clean run', () => {
    const i = good();
    i.htmlFallbackSections = 1;
    expect(buildRunReport(i).verdict.overall).toBe('warn');
  });
  it('defaults htmlFallbackSections to 0 when absent (back-compat)', () => {
    expect(buildRunReport(good()).summary.htmlFallbackSections).toBe(0);
  });
  it('surfaces htmlFallbackByReason in the summary', () => {
    const i = good();
    i.htmlFallbackSections = 3;
    i.htmlFallbackByReason = { dropped_images: 2, text_coverage_below_floor: 1 };
    expect(buildRunReport(i).summary.htmlFallbackByReason).toEqual({ dropped_images: 2, text_coverage_below_floor: 1 });
  });
  it('defaults htmlFallbackByReason to {} when absent (back-compat)', () => {
    expect(buildRunReport(good()).summary.htmlFallbackByReason).toEqual({});
  });
});

describe('buildRunReport — section parity gate (faithful recreation)', () => {
  it('back-compat: an otherwise-clean run with no pageParity still passes', () => {
    expect(buildRunReport(good()).verdict.overall).toBe('pass');
  });
  it('passes when every parity section matches the source', () => {
    const i = good();
    i.pageParity = [{ page: '/', sections: [sec(), sec()] }];
    expect(buildRunReport(i).verdict.overall).toBe('pass');
  });
  it('FAILS when any section is divergent (flattened columns)', () => {
    const i = good();
    i.pageParity = [{ page: '/', sections: [sec(), sec({ columnCountMatch: false })] }];
    expect(buildRunReport(i).verdict.overall).toBe('fail');
  });
  it('FAILS (unverified) when a content page has no sampled sections', () => {
    const i = good();
    i.pageParity = [{ page: '/', sections: [] }];
    expect(buildRunReport(i).verdict.overall).toBe('fail');
  });
  it('passes when a divergence is accepted by the human operator with proof', () => {
    const i = good();
    i.pageParity = [
      { page: '/', sections: [sec({ columnCountMatch: false }, { by: 'human', proof: 'approved' })] },
    ];
    expect(buildRunReport(i).verdict.overall).toBe('pass');
  });
  it('still FAILS when the agent self-accepts a structural divergence as class-c', () => {
    const i = good();
    i.pageParity = [
      {
        page: '/',
        sections: [sec({ bgDeltaE: 40 }, { by: 'class-c', proof: 'sampled #aaa vs #bbb' })],
      },
    ];
    expect(buildRunReport(i).verdict.overall).toBe('fail');
  });
  it('FAILS on an unstyled fallback island landing on a CSS-layout section', () => {
    const i = good();
    i.pageParity = [{ page: '/', sections: [sec({ fallbackUnstyled: true })] }];
    expect(buildRunReport(i).verdict.overall).toBe('fail');
  });
  it('counts divergent and accepted sections in the summary', () => {
    const i = good();
    i.pageParity = [
      {
        page: '/',
        sections: [
          sec(),
          sec({ columnCountMatch: false }),
          sec({ mediaPresent: false }, { by: 'human', proof: 'ok' }),
        ],
      },
    ];
    const r = buildRunReport(i);
    expect(r.summary.sectionsDivergent).toBe(1);
    expect(r.summary.sectionsAccepted).toBe(1);
  });
});
