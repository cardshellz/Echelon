import { describe, expect, it } from "vitest";
import { runDropshipUsdcWatcherTick } from "../../infrastructure/dropship-usdc-watcher-runner";
import type {
  DropshipUsdcScanResult,
  DropshipUsdcSettlementResult,
} from "../../application/dropship-usdc-deposit-service";

const scan: DropshipUsdcScanResult = {
  outcome: "scanned",
  headBlockNumber: 1_000,
  safeBlockNumber: 950,
  fromBlock: 901,
  toBlock: 995,
  scannedToBlock: 995,
  addressCount: 2,
  logCount: 1,
  observedCount: 1,
  pendingCount: 1,
  settledCount: 0,
  dustCount: 0,
  replayedCount: 0,
  failedCount: 0,
};

const settlement: DropshipUsdcSettlementResult = {
  outcome: "judged",
  headBlockNumber: 1_000,
  safeBlockNumber: 950,
  scannedCount: 1,
  settledCount: 0,
  waitingCount: 1,
  movedCount: 0,
  voidedCount: 0,
  failedCount: 0,
};

describe("runDropshipUsdcWatcherTick", () => {
  it("scans first and settles second, with one worker id, and reports both", async () => {
    const order: string[] = [];
    const inputs: unknown[] = [];
    const result = await runDropshipUsdcWatcherTick({
      workerId: "worker-test",
      service: {
        runScan: async (input) => { order.push("scan"); inputs.push(input); return scan; },
        runSettlement: async (input) => { order.push("settle"); inputs.push(input); return settlement; },
      },
    });
    expect(order).toEqual(["scan", "settle"]);
    expect(inputs).toEqual([{ workerId: "worker-test" }, { workerId: "worker-test" }]);
    expect(result).toEqual({ scan, settlement });
  });

  it("derives a worker id from the process when none is given", async () => {
    const inputs: { workerId: string }[] = [];
    await runDropshipUsdcWatcherTick({
      service: {
        runScan: async (input) => { inputs.push(input); return scan; },
        runSettlement: async (input) => { inputs.push(input); return settlement; },
      },
    });
    expect(inputs[0]?.workerId).toMatch(/^dropship-usdc-watcher-\d+$/);
    expect(inputs[1]?.workerId).toBe(inputs[0]?.workerId);
  });

  it("lets a scan failure surface instead of settling on stale facts", async () => {
    let settled = false;
    await expect(runDropshipUsdcWatcherTick({
      workerId: "worker-test",
      service: {
        runScan: async () => { throw new Error("node down"); },
        runSettlement: async () => { settled = true; return settlement; },
      },
    })).rejects.toThrow("node down");
    expect(settled).toBe(false);
  });
});
