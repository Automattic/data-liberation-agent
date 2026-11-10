import { existsSync } from 'node:fs';
import { chromium } from 'playwright';
import { expect, it } from 'vitest';
import { launchChromium } from './browser-kit.js';

const skipBrowser = Boolean(process.env.SKIP_BROWSER_TESTS) || !existsSync(chromium.executablePath());

it.skipIf(skipBrowser)('gathers no UDP ICE candidates when page script opens a WebRTC connection', async () => {
  const browser = await launchChromium();
  try {
    const page = await browser.newPage();
    // What a fingerprinting script does: open a peer connection against a public
    // STUN server and collect ICE candidates. Each UDP candidate is a packet out.
    const candidates = await page.evaluate(async () => {
      const pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
      const found: string[] = [];
      const done = new Promise<void>(resolve => {
        pc.onicecandidate = event => (event.candidate ? found.push(event.candidate.candidate) : resolve());
        setTimeout(resolve, 5_000);
      });
      pc.createDataChannel('probe');
      await pc.setLocalDescription(await pc.createOffer());
      await done;
      pc.close();
      return found;
    });
    expect(candidates.filter(candidate => / udp /i.test(candidate))).toEqual([]);
  } finally {
    await browser.close();
  }
});
