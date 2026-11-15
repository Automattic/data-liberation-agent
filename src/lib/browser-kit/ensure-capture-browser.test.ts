import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ launch: vi.fn(), exec: vi.fn() }));
vi.mock('./browser-kit.js', () => ({ launchChromium: mocks.launch }));
vi.mock('node:child_process', () => ({ execFile: mocks.exec }));

afterEach(() => vi.resetAllMocks());

it('installs using the engine Playwright CLI and verifies launch after a missing executable', async () => {
  const close = vi.fn().mockResolvedValue(undefined);
  mocks.launch.mockRejectedValueOnce(new Error("Executable doesn't exist at /missing/chromium"))
    .mockResolvedValueOnce({ close });
  mocks.exec.mockImplementation((_node, _args, _opts, callback) => callback(null, '', ''));
  const { ensureCaptureBrowser } = await import('./ensure-capture-browser.js');
  await ensureCaptureBrowser();
  expect(mocks.exec).toHaveBeenCalledWith(process.execPath,
    [expect.stringMatching(/playwright\/cli\.js$/), 'install', 'chromium'],
    expect.objectContaining({ timeout: 180_000 }), expect.any(Function));
  expect(mocks.launch).toHaveBeenCalledTimes(2);
  expect(close).toHaveBeenCalledOnce();
});

it('reports browser-unavailable without installing for other launch failures', async () => {
  mocks.launch.mockRejectedValue(new Error('sandbox failed'));
  const { ensureCaptureBrowser } = await import('./ensure-capture-browser.js');
  await expect(ensureCaptureBrowser()).rejects.toThrow('browser-unavailable: sandbox failed');
  expect(mocks.exec).not.toHaveBeenCalled();
});
