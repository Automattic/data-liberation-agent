export type PreviewPhase = 'download' | 'spawn' | 'probe' | 'import';

export interface PreviewPidRecord {
  pid: number;
  port: number;
  startedAt: string;
}

export interface StartPreviewOpts {
  outputDir: string;
  port?: number;
  open?: boolean;
  onPhase?: (phase: PreviewPhase) => void;
  detached?: boolean;
}

export type PreviewSource = 'studio' | 'playground';

export interface StartPreviewResult {
  status: 'ready' | 'failed';
  url?: string;
  pid?: number;
  port?: number;
  warnings?: string[];
  error?: string;
  logTail?: string[];
  source?: PreviewSource;
  siteName?: string;
}

export interface StopPreviewResult {
  status: 'stopped' | 'not-running';
}
