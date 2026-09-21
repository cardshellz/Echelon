import { afterEach, expect, it, vi } from "vitest";
import type { ChannelFulfillmentAuthorityService } from "../../channel-fulfillment-authority.service";
import { getChannelFulfillmentCommandWorkerHeartbeat, resetChannelFulfillmentCommandWorkerForTest,
  startChannelFulfillmentCommandWorker } from "../../channel-fulfillment-command.worker";

afterEach(() => { resetChannelFulfillmentCommandWorkerForTest(); vi.useRealTimers(); });

it("continues fresh fulfillment while one correction is slow, without launching overlapping correction batches", async () => {
  vi.useFakeTimers();
  let finish: () => void = () => undefined;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  const runLabelLifecycleBatch = vi.fn().mockReturnValue(waiting);
  const runDueBatch = vi.fn().mockResolvedValue({ claimed: 0 });
  const stop = startChannelFulfillmentCommandWorker({ runLabelLifecycleBatch, runDueBatch } as unknown as ChannelFulfillmentAuthorityService, { intervalMs: 1000 });
  await vi.advanceTimersByTimeAsync(3000);
  expect(runDueBatch).toHaveBeenCalledTimes(4);
  expect(runLabelLifecycleBatch).toHaveBeenCalledTimes(1);
  expect(getChannelFulfillmentCommandWorkerHeartbeat().labelLifecycleInFlight).toBe(true);
  finish(); await vi.advanceTimersByTimeAsync(1000);
  expect(runLabelLifecycleBatch).toHaveBeenCalledTimes(2);
  stop();
});
