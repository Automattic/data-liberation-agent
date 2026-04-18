import { describe, it, expect, vi } from 'vitest';
import { waitForStable, triggerLazyLoad, withEvaluateTimeout } from './page-helpers.js';

type MockPage = {
  waitForLoadState: ReturnType<typeof vi.fn>;
  evaluate: ReturnType<typeof vi.fn>;
};

function makePage(): MockPage {
  return {
    waitForLoadState: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue(undefined),
  };
}

describe('waitForStable', () => {
  it('waits for load then settles', async () => {
    const page = makePage();
    await waitForStable(page as never, 10);
    expect(page.waitForLoadState).toHaveBeenCalledWith('load');
  });

  it('swallows networkidle failures (chatty analytics)', async () => {
    const page = makePage();
    page.waitForLoadState = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('networkidle timeout'));
    await expect(waitForStable(page as never, 10)).resolves.toBeUndefined();
  });
});

describe('triggerLazyLoad', () => {
  it('scrolls and waits, does not throw', async () => {
    const page = makePage();
    await triggerLazyLoad(page as never);
    expect(page.evaluate).toHaveBeenCalled();
  });

  it('does not throw on networkidle hang', async () => {
    const page = makePage();
    page.waitForLoadState = vi.fn().mockRejectedValue(new Error('timeout'));
    await expect(triggerLazyLoad(page as never)).resolves.toBeUndefined();
  });

  it('does not throw on page.evaluate failure', async () => {
    const page = makePage();
    page.evaluate = vi.fn().mockRejectedValue(new Error('page crashed'));
    await expect(triggerLazyLoad(page as never)).resolves.toBeUndefined();
  });
});

describe('withEvaluateTimeout', () => {
  it('resolves normal evaluates', async () => {
    const result = await withEvaluateTimeout(Promise.resolve(42), 1000);
    expect(result).toBe(42);
  });

  it('rejects with timeout on slow promise', async () => {
    const slow = new Promise((resolve) => setTimeout(resolve, 5_000));
    await expect(withEvaluateTimeout(slow, 50)).rejects.toThrow(/timeout/i);
  });

  it('propagates non-timeout rejections unchanged', async () => {
    const failing = Promise.reject(new Error('custom error'));
    await expect(withEvaluateTimeout(failing, 1000)).rejects.toThrow('custom error');
  });
});
