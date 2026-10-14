import { expect, type Page } from "@playwright/test";

const CLOCK_START = new Date("2026-10-13T12:00:00Z");
// Let startup and form interactions run normally before pausing for the command.
const COMMAND_TIME = new Date("2026-10-13T12:05:00Z");
// Assert the production backoff contract independently of its implementation.
const RETRY_DELAYS_MS = [2_000, 4_000, 8_000];

export async function installFinancialRetryClock(page: Page): Promise<void> {
  await page.clock.install({ time: CLOCK_START });
}

/** Exercise real failed requests and retry timers without waiting fourteen seconds. */
export async function expectFinancialRetryBoundaries(
  page: Page,
  submit: () => Promise<void>,
  attemptCount: () => number,
): Promise<void> {
  await page.clock.pauseAt(COMMAND_TIME);
  const observer = await page.evaluateHandle((delays) => {
    const registrations: Array<{ delayMs: number; scheduledAt: number }> = [];
    const browserWindow: Window = window;
    const schedule = browserWindow.setTimeout;
    // Observe the fake clock's timers; do not change callbacks, delays or results.
    browserWindow.setTimeout = (handler: TimerHandler, timeout?: number, ...args: unknown[]): number => {
      const timer = schedule(handler, timeout, ...args);
      if (timeout !== undefined && delays.includes(timeout)) {
        registrations.push({ delayMs: timeout, scheduledAt: Date.now() });
      }
      return timer;
    };
    return { registrations, restore: () => { browserWindow.setTimeout = schedule; } };
  }, RETRY_DELAYS_MS);

  try {
    expect(attemptCount()).toBe(0);
    await submit();
    await expect.poll(attemptCount).toBe(1);
    for (const [index, delayMs] of RETRY_DELAYS_MS.entries()) {
      // A failed network event can precede the client scheduling its retry.
      // Wait for registration before advancing, rather than racing that work.
      await expect.poll(() => observer.evaluate((state) => state.registrations.map((timer) => timer.delayMs)))
        .toEqual(RETRY_DELAYS_MS.slice(0, index + 1));
      const scheduledAt = await observer.evaluate((state) => state.registrations.at(-1)!.scheduledAt);
      expect(await page.evaluate(() => Date.now())).toBe(scheduledAt);
      await page.clock.runFor(delayMs - 1);
      expect(attemptCount()).toBe(index + 1);
      await page.clock.runFor(1);
      await expect.poll(attemptCount).toBe(index + 2);
    }
    expect(attemptCount()).toBe(4);
  } finally {
    await observer.evaluate((state) => state.restore());
    await observer.dispose();
    // Reload, permissions and explicit recovery continue under normal timing.
    await page.clock.resume();
  }
}
