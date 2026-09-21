import { afterEach, expect, it, vi } from "vitest";
import { startShipStationLabelReconciliationScheduler } from "../../shipstation-label-reconciliation.scheduler";
afterEach(() => vi.useRealTimers());
it("runs in a bounded independent lane, prevents overlap, and stops", async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const runOnce = vi.fn(() => new Promise<{ outcome: "processed"; voids: number; orders: number }>(resolve => {
    finish = () => resolve({ outcome: "processed", voids: 1, orders: 1 });
  }));
  const logger = { info: vi.fn(), error: vi.fn() };
  const scheduler = startShipStationLabelReconciliationScheduler({ runOnce }, logger);
  await vi.advanceTimersByTimeAsync(30000); expect(runOnce).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(600000); expect(runOnce).toHaveBeenCalledTimes(1);
  finish(); await vi.advanceTimersByTimeAsync(0); expect(logger.info).toHaveBeenCalledTimes(1);
  scheduler.stop(); await vi.advanceTimersByTimeAsync(600000); expect(runOnce).toHaveBeenCalledTimes(1);
});
it("retries after failure and never logs raw provider data", async () => {
  vi.useFakeTimers();
  const runOnce = vi.fn().mockRejectedValueOnce(new Error("secret provider response")).mockResolvedValue({ outcome: "idle", voids: 0, orders: 0 });
  const logger = { info: vi.fn(), error: vi.fn() };
  const scheduler = startShipStationLabelReconciliationScheduler({ runOnce }, logger);
  await vi.advanceTimersByTimeAsync(300000);
  expect(runOnce).toHaveBeenCalledTimes(2); expect(logger.error).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(logger.error.mock.calls)).not.toContain("secret provider response"); scheduler.stop();
});
