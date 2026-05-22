// src/lib/replicate/run-report.ts
// Assembles the verdict-first run report the operator reads to answer "is this
// liberation good?". Order: verdict → summary → details. Responsiveness is the
// HARD gate (fail); fallbacks/misfits/provenance flags are warnings.
export interface ClusterReport { key: string; representative: string; built: boolean; gatePassed: boolean; }
export interface ArchetypeResponsive { archetype: string; responsive: boolean; }
export interface RunReportInput {
  site: string;
  clusters: ClusterReport[];
  pagesComposed: number;
  pagesMisfit: number;
  responsive: ArchetypeResponsive[];
  provenanceFlags: number;
  fallbackPages: number;
  cost?: { tokens?: number; subagents?: number; skillCalls?: number };
  qualitativeNotes?: string[];
  knownGaps?: string[];
}
export type Verdict = 'pass' | 'warn' | 'fail';
export interface RunReport {
  site: string;
  verdict: { overall: Verdict; perArchetype: ArchetypeResponsive[] };
  summary: {
    clustersBuilt: number; clustersFailed: number;
    pagesComposed: number; pagesMisfit: number;
    responsivePass: number; responsiveFail: number;
    provenanceFlags: number; fallbackPages: number;
    cost: { tokens?: number; subagents?: number; skillCalls?: number };
  };
  details: { clusters: ClusterReport[]; qualitativeNotes: string[]; knownGaps: string[] };
}

export function buildRunReport(input: RunReportInput): RunReport {
  const clustersFailed = input.clusters.filter((c) => !c.built || !c.gatePassed).length;
  const responsiveFail = input.responsive.filter((r) => !r.responsive).length;
  const responsivePass = input.responsive.length - responsiveFail;

  let overall: Verdict;
  if (clustersFailed > 0 || responsiveFail > 0) {
    overall = 'fail';
  } else if (
    input.fallbackPages > 0 || input.pagesMisfit > 0 ||
    input.provenanceFlags > 0 || (input.knownGaps?.length ?? 0) > 0
  ) {
    overall = 'warn';
  } else {
    overall = 'pass';
  }

  return {
    site: input.site,
    verdict: { overall, perArchetype: input.responsive },
    summary: {
      clustersBuilt: input.clusters.length - clustersFailed,
      clustersFailed,
      pagesComposed: input.pagesComposed,
      pagesMisfit: input.pagesMisfit,
      responsivePass,
      responsiveFail,
      provenanceFlags: input.provenanceFlags,
      fallbackPages: input.fallbackPages,
      cost: input.cost ?? {},
    },
    details: {
      clusters: input.clusters,
      qualitativeNotes: input.qualitativeNotes ?? [],
      knownGaps: input.knownGaps ?? [],
    },
  };
}
