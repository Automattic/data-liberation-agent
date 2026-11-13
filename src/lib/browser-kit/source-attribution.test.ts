import { expect, it } from 'vitest';
import { SourceRequestGovernors } from '../source-request-governor.js';

it('extends the request ledger without changing network counts, and bounds repeated URL evidence', async () => {
  const governors = new SourceRequestGovernors();
  const governor = governors.forOrigin('https://source.test');
  await governor.run(async () => ({ status: 200, headers: new Headers() }), {
    category: 'subresource', attribution: { phase: 'media', url: 'https://source.test/shared.css' },
  });
  governor.attributeRequest({ phase: 'baseline', device: 'desktop', outcome: 'hit', url: 'https://source.test/shared.css' });
  for (let i = 0; i < 10100; i++) {
    const url = `https://source.test/${i}`;
    governor.attributeRequest({ phase: 'navigate', device: 'mobile', outcome: 'miss:no_entry', url });
    governor.attributeRequest({ phase: 'settle', device: 'mobile', outcome: 'hit', url });
  }
  expect(governor.stats().requests).toBe(1);
  const report = governors.attribution();
  expect(report.origins[0].totals['unattributed/media not_routed']).toBe(1);
  expect(report.origins[0].totals['desktop/baseline hit']).toBe(1);
  expect(report.origins[0].totals['mobile/settle hit']).toBe(10100);
  expect(report.origins[0].droppedUrlRequests).toBe(202);
  expect(report.repeatedUrls).toHaveLength(50);
  expect(report.repeatedUrls.every(entry => entry.count === 2)).toBe(true);
  expect(JSON.stringify(report)).not.toContain('body');
});
