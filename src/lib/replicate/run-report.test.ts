import { describe, it, expect } from 'vitest';
import { buildRunReport, type RunReportInput } from './run-report.js';

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
});
