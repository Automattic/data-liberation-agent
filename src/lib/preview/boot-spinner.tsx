import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export interface BootSpinnerProps {
  done?: boolean;
  url?: string;
  error?: string;
}

function phaseLabel(elapsedMs: number): string {
  if (elapsedMs < 10_000) return 'Downloading WordPress…';
  if (elapsedMs < 25_000) return 'Starting WordPress…';
  return 'Importing content…';
}

export function BootSpinner({ done, url, error }: BootSpinnerProps) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (done || error) return;
    const start = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - start), 500);
    return () => clearInterval(id);
  }, [done, error]);

  if (error) {
    return (
      <Box>
        <Text color="red">❌ {error}</Text>
      </Box>
    );
  }
  if (done && url) {
    return (
      <Box>
        <Text color="green">✅ Ready at </Text>
        <Text color="cyan">{url}</Text>
      </Box>
    );
  }
  return (
    <Box>
      <Text color="cyan">
        <Spinner type="dots" />
      </Text>
      <Text> {phaseLabel(elapsed)}</Text>
    </Box>
  );
}
