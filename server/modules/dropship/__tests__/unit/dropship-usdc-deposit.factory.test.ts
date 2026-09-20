import { describe, expect, it } from "vitest";
import {
  USDC_WATCHER_ENV,
  resolveDropshipUsdcWatcherConfigFromEnv,
} from "../../infrastructure/dropship-usdc-deposit.factory";
import { DEFAULT_USDC_WATCHER_CONFIG } from "../../application/dropship-usdc-deposit-service";

describe("resolveDropshipUsdcWatcherConfigFromEnv (funding design phase 6)", () => {
  it("uses the documented defaults when nothing is set", () => {
    expect(resolveDropshipUsdcWatcherConfigFromEnv({})).toEqual(DEFAULT_USDC_WATCHER_CONFIG);
    expect(DEFAULT_USDC_WATCHER_CONFIG).toEqual({
      chainId: 8453,
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      minConfirmations: 6,
      settleTag: "safe",
      voidAfterBlocks: 60,
      maxBlockSpan: 2_000,
      startBlock: null,
      addressBatchSize: 200,
      settlementBatchSize: 200,
    });
  });

  it("reads every tuning variable, lowercasing the token address", () => {
    expect(resolveDropshipUsdcWatcherConfigFromEnv({
      [USDC_WATCHER_ENV.tokenAddress]: " 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 ",
      [USDC_WATCHER_ENV.minConfirmations]: "12",
      [USDC_WATCHER_ENV.settleTag]: "finalized",
      [USDC_WATCHER_ENV.voidAfterBlocks]: "120",
      [USDC_WATCHER_ENV.maxBlockSpan]: "500",
      [USDC_WATCHER_ENV.startBlock]: "35000000",
      [USDC_WATCHER_ENV.addressBatchSize]: "50",
      [USDC_WATCHER_ENV.settlementBatchSize]: "25",
    })).toEqual({
      chainId: 8453,
      tokenAddress: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
      minConfirmations: 12,
      settleTag: "finalized",
      voidAfterBlocks: 120,
      maxBlockSpan: 500,
      startBlock: 35_000_000,
      addressBatchSize: 50,
      settlementBatchSize: 25,
    });
  });

  it("refuses a value it cannot use instead of silently defaulting it", () => {
    for (const env of [
      { [USDC_WATCHER_ENV.minConfirmations]: "0" },
      { [USDC_WATCHER_ENV.minConfirmations]: "six" },
      { [USDC_WATCHER_ENV.minConfirmations]: "1.5" },
      { [USDC_WATCHER_ENV.settleTag]: "latest" },
      { [USDC_WATCHER_ENV.tokenAddress]: "0x1234" },
      { [USDC_WATCHER_ENV.startBlock]: "-1" },
      { [USDC_WATCHER_ENV.maxBlockSpan]: "99999999999999999999" },
    ]) {
      expect(() => resolveDropshipUsdcWatcherConfigFromEnv(env)).toThrowError(expect.objectContaining({ code: "DROPSHIP_USDC_WATCHER_MISCONFIGURED" }));
    }
  });

  it("treats a blank variable as unset", () => {
    expect(resolveDropshipUsdcWatcherConfigFromEnv({ [USDC_WATCHER_ENV.minConfirmations]: "   ", [USDC_WATCHER_ENV.settleTag]: "" })).toEqual(DEFAULT_USDC_WATCHER_CONFIG);
  });
});
