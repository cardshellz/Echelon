import { describe, expect, it, vi } from "vitest";
import {
  buildPackageHistory,
  packageHistoryNativeRevision,
  PackageHistoryError,
} from "../../package-history.domain";
import { PackageHistoryWorker } from "../../package-history.worker";
import type { PackageHistoryStore } from "../../package-history.ports";
import { parsePackageHistoryBackfillOptions } from "../../../../../scripts/lib/package-history-backfill-options";

import { historyFixture } from "../support/package-history-fixtures";
const instant = new Date("2026-09-23T12:00:00Z"),
  leaseId = "00000000-0000-4000-8000-000000000001";
describe("shipping-owned historical package evidence", () => {
  it("recovers a legacy exact native-line package and excludes a membership without WMS repair", () => {
    const f = historyFixture(),
      before = structuredClone(f);
    const result = buildPackageHistory(f.scope, f.native, f.observations);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0].dimensions).toEqual({
      lengthMm: 254,
      widthMm: 203.2,
      heightMm: 101.6,
    });
    expect(result.packages[0].lines).toEqual([
      { omsOrderLineId: 101, externalLineId: "501", quantity: 1 },
    ]);
    expect(f).toEqual(before);
  });
  it("uses exact owned wms-item identities for the normal flow", () => {
    const f = historyFixture();
    f.observations[0].shipment.shipmentItems[0].lineItemKey = "wms-item-301";
    expect(
      buildPackageHistory(f.scope, f.native, f.observations).packages,
    ).toHaveLength(1);
  });
  it.each(["foreign-native-key", "wms-item-999"])(
    "never joins by matching SKU when the key is %s",
    (key) => {
      const f = historyFixture();
      f.observations[0].shipment.shipmentItems[0].lineItemKey = key;
      expect(() =>
        buildPackageHistory(f.scope, f.native, f.observations),
      ).toThrow("PACKAGE_HISTORY_FOREIGN_LINE");
    },
  );
  it("rejects a foreign owner, order, local line identity or quantity", () => {
    for (const mutate of [
      (f: ReturnType<typeof historyFixture>) => {
        f.native.orderId = "999";
      },
      (f: ReturnType<typeof historyFixture>) => {
        f.scope.externalCustomerId = "123";
      },
      (f: ReturnType<typeof historyFixture>) => {
        f.native.lines[0].quantity = 2;
      },
      (f: ReturnType<typeof historyFixture>) => {
        f.observations[0].shipment.shipmentItems[0].quantity = 2;
      },
    ]) {
      const f = historyFixture();
      mutate(f);
      expect(() =>
        buildPackageHistory(f.scope, f.native, f.observations),
      ).toThrow(PackageHistoryError);
    }
  });
  it("accounts for all packages of a split fulfillment", () => {
    const f = historyFixture();
    f.scope.lines[0].quantity = 2;
    f.native.lines[0].quantity = 2;
    f.native.fulfillments[0].lines[0].quantity = 2;
    f.native.fulfillments[0].tracking.push("TRACK602");
    const second = structuredClone(f.observations[0]);
    second.shipment.shipmentId = 602;
    second.shipment.trackingNumber = "TRACK602";
    f.observations.push(second);
    expect(
      buildPackageHistory(f.scope, f.native, f.observations).packages,
    ).toHaveLength(2);
    f.observations.pop();
    expect(() =>
      buildPackageHistory(f.scope, f.native, f.observations),
    ).toThrow("PACKAGE_HISTORY_LABEL_MISSING");
  });
  it("rejects duplicate active labels and duplicate/mixed contents", () => {
    const f = historyFixture(),
      duplicate = structuredClone(f.observations[0]);
    duplicate.shipment.shipmentId = 602;
    f.observations.push(duplicate);
    expect(() =>
      buildPackageHistory(f.scope, f.native, f.observations),
    ).toThrow("PACKAGE_HISTORY_LABEL_AMBIGUOUS");
    f.observations.pop();
    f.observations[0].shipment.shipmentItems.push({
      ...f.observations[0].shipment.shipmentItems[0],
    });
    expect(() =>
      buildPackageHistory(f.scope, f.native, f.observations),
    ).toThrow("PACKAGE_HISTORY_ITEM_AMBIGUOUS");
  });
  it.each(["voided", "isReturnLabel"] as const)(
    "never uses %s labels as original boxes",
    (field) => {
      const f = historyFixture();
      f.observations[0].shipment[field] = true;
      expect(() =>
        buildPackageHistory(f.scope, f.native, f.observations),
      ).toThrow("PACKAGE_HISTORY_LABEL_MISSING");
    },
  );
  it("does not invent dimensions or lose a proven package when dimensions are absent/invalid", () => {
    const f = historyFixture();
    delete f.observations[0].shipment.dimensions;
    const missing = buildPackageHistory(f.scope, f.native, f.observations)
      .packages[0];
    expect(missing.measurementStatus).toBe("missing");
    expect(missing.dimensions).toBeNull();
    f.observations[0].shipment.dimensions = {
      units: "inches",
      length: 0,
      width: 8,
      height: 4,
    };
    expect(
      buildPackageHistory(f.scope, f.native, f.observations).packages[0]
        .measurementStatus,
    ).toBe("invalid");
  });
  it("is deterministic across equivalent provider collection ordering", () => {
    const f = historyFixture(),
      first = buildPackageHistory(f.scope, f.native, f.observations);
    f.native.lines.reverse();
    f.native.fulfillments.reverse();
    expect(packageHistoryNativeRevision(f.native)).toBe(first.nativeRevision);
    expect(buildPackageHistory(f.scope, f.native, f.observations)).toEqual(
      first,
    );
  });
});
describe("capture retries without operational services", () => {
  function workerFixture() {
    const f = historyFixture(),
      claim = { omsOrderId: 100, generation: "1", leaseId, attempts: 0 };
    const store: PackageHistoryStore = {
      drain: vi.fn(async () => 0),
      claim: vi.fn(async () => [claim]),
      renew: vi.fn(async () => true),
      read: vi.fn(async () => null),
      complete: vi.fn(async () => true),
      fail: vi.fn(async () => {}),
    };
    const source = {
      scope: vi.fn(async () => structuredClone(f.scope)),
      native: vi.fn(async () => structuredClone(f.native)),
      shipments: vi.fn(async () => structuredClone(f.observations)),
    };
    const report = vi.fn(),
      worker = new PackageHistoryWorker({
        store,
        source,
        now: () => instant,
        newId: () => leaseId,
        report,
      });
    return { f, store, source, worker, report };
  }
  it("publishes only after complete stable native and local observations", async () => {
    const f = workerFixture();
    await f.worker.run();
    expect(f.store.complete).toHaveBeenCalledOnce();
    expect(f.source.native).toHaveBeenCalledTimes(2);
    expect(f.source.scope).toHaveBeenCalledTimes(2);
    expect(f.store.fail).not.toHaveBeenCalled();
  });
  it("retries provider outages and later publishes the same idempotent facts", async () => {
    const f = workerFixture();
    f.source.shipments.mockRejectedValueOnce(
      new PackageHistoryError(
        "PACKAGE_HISTORY_PROVIDER_UNAVAILABLE",
        "transient",
      ),
    );
    await f.worker.run();
    expect(f.store.fail).toHaveBeenCalledWith(
      expect.anything(),
      "PACKAGE_HISTORY_PROVIDER_UNAVAILABLE",
      "transient",
      instant,
    );
    await f.worker.run();
    expect(f.store.complete).toHaveBeenCalledOnce();
  });
  it("does not publish stale source/native evidence or a lost lease", async () => {
    for (const fault of ["local", "native", "lease"]) {
      const f = workerFixture();
      if (fault === "local")
        f.source.scope
          .mockResolvedValueOnce(f.f.scope)
          .mockResolvedValue({ ...f.f.scope, orderReference: "changed" });
      if (fault === "native")
        f.source.native
          .mockResolvedValueOnce(f.f.native)
          .mockResolvedValue({ ...f.f.native, reference: "changed" });
      if (fault === "lease") vi.mocked(f.store.renew).mockResolvedValue(false);
      await f.worker.run();
      expect(f.store.complete).not.toHaveBeenCalled();
      expect(f.store.fail).toHaveBeenCalled();
    }
  });
  it("records an ambiguous package as review instead of guessing", async () => {
    const f = workerFixture();
    f.f.observations[0].shipment.shipmentItems[0].lineItemKey = "other";
    await f.worker.run();
    expect(f.store.fail).toHaveBeenCalledWith(
      expect.anything(),
      "PACKAGE_HISTORY_FOREIGN_LINE",
      "review",
      instant,
    );
    expect(f.store.complete).not.toHaveBeenCalled();
  });
});
describe("backfill command boundary", () => {
  it("defaults to a credential-free dry run and requires an actor and channel", () => {
    expect(
      parsePackageHistoryBackfillOptions([
        "--channel-id",
        "36",
        "--actor",
        "fixture",
      ]).execute,
    ).toBe(false);
    expect(() => parsePackageHistoryBackfillOptions(["--execute"])).toThrow();
  });
  it.each([
    ["--channel-id", "0"],
    ["--batches", "0"],
    ["--run-key", "../other"],
    ["--unknown", "x"],
    ["--execute", "--execute"],
  ])("rejects invalid inputs %j", (args) => {
    expect(() =>
      parsePackageHistoryBackfillOptions([
        "--channel-id",
        "36",
        "--actor",
        "fixture",
        ...args,
      ]),
    ).toThrow();
  });
  it("accepts an explicit bounded execute without adding hidden commands", () => {
    expect(
      parsePackageHistoryBackfillOptions([
        "--channel-id",
        "36",
        "--actor",
        "fixture",
        "--mode",
        "seed",
        "--execute",
        "--batches",
        "2",
      ]),
    ).toMatchObject({ channelId: 36, execute: true, batches: 2, mode: "seed" });
  });
});
