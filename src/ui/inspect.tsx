import React, { useState, useEffect } from 'react';
import { render, useApp, Box, Text } from 'ink';
import Spinner from 'ink-spinner';
import { Header } from './header.js';
import { platformColor, confidenceBadge, pluralize } from './format.js';
import { detect, type FullDetectionResult } from '../lib/detect-platform/index.js';
import { fetchSitemap, classifyUrl } from '../lib/extraction/sitemap.js';

export interface InspectProps {
  url: string;
}

type Phase = 'detecting' | 'scanning' | 'done' | 'error';


function Inspect({ url }: InspectProps) {
  const app = useApp();
  const [phase, setPhase] = useState<Phase>('detecting');
  const [detection, setDetection] = useState<FullDetectionResult | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [urlCount, setUrlCount] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // Phase 1: Detect platform
        const det = await detect(url);
        setDetection(det);

        // Phase 2: Scan sitemap
        setPhase('scanning');
        const urls = await fetchSitemap(url);
        setUrlCount(urls.length);

        const c: Record<string, number> = {};
        for (const u of urls) {
          const type = classifyUrl(u);
          c[type] = (c[type] || 0) + 1;
        }
        setCounts(c);

        setPhase('done');
      } catch (err) {
        setError((err as Error).message);
        setPhase('error');
      }
    })();
  }, [url]);

  useEffect(() => {
    if (phase === 'done' || phase === 'error') {
      const timer = setTimeout(() => app.exit(), 100);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  const feasibility = detection?.platform === 'unknown' ? 'limited' : 'ready';

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Header subtitle={`inspect ${url}`} />

      {/* Detection */}
      <Box>
        {phase === 'detecting' ? (
          <>
            <Text color="yellow"><Spinner type="dots" /></Text>
            <Text> Detecting platform...</Text>
          </>
        ) : detection ? (
          <>
            <Text color="green">✓</Text>
            <Text> Platform: </Text>
            <Text bold color={platformColor(detection.platform)}>
              {detection.platform === 'unknown' ? 'Unknown' : detection.platform}
            </Text>
            <Text dimColor> {confidenceBadge(detection.confidence)} {detection.confidence}</Text>
            {detection.signals.length > 0 && (
              <Text dimColor> ({detection.signals.join(', ')})</Text>
            )}
          </>
        ) : null}
      </Box>

      {/* Sitemap scan */}
      {phase !== 'detecting' && (
        <Box>
          {phase === 'scanning' ? (
            <>
              <Text color="yellow"><Spinner type="dots" /></Text>
              <Text> Scanning sitemap...</Text>
            </>
          ) : (
            <>
              <Text color={urlCount > 0 ? 'green' : 'yellow'}>{urlCount > 0 ? '✓' : '⚠'}</Text>
              <Text> Sitemap: </Text>
              <Text bold>{urlCount}</Text>
              <Text> URLs found</Text>
            </>
          )}
        </Box>
      )}

      {/* Content breakdown */}
      {Object.keys(counts).length > 0 && phase !== 'scanning' && (
        <Box flexDirection="column" marginTop={1} marginLeft={2}>
          {Object.entries(counts)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => (
              <Box key={type}>
                <Text dimColor>{String(count).padStart(4)} </Text>
                <Text>{pluralize(type, count)}</Text>
              </Box>
            ))}
        </Box>
      )}

      {/* Feasibility summary */}
      {phase === 'done' && detection && (
        <Box marginTop={1}>
          {feasibility === 'ready' ? (
            <>
              <Text color="green">✓</Text>
              <Text> Extraction: </Text>
              <Text color="green" bold>ready</Text>
            </>
          ) : (
            <>
              <Text color="yellow">⚠</Text>
              <Text> Extraction: </Text>
              <Text color="yellow" bold>limited</Text>
              <Text dimColor> (unknown platform)</Text>
            </>
          )}
        </Box>
      )}

      {/* Error */}
      {phase === 'error' && (
        <Box marginTop={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      )}
    </Box>
  );
}

export function runInspect(url: string): void {
  const { waitUntilExit } = render(
    <Inspect url={url} />,
  );
  waitUntilExit().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
