import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PurchaseCostStatus } from "@shared/procurement/purchase-cost-status";
import type { CostEvidenceTransaction } from "../../../inventory/infrastructure/cost-evidence.repository";
import { CostEvidenceError } from "../../../inventory/infrastructure/cost-evidence-values";
import { readPurchaseCostStatus } from "../../purchase-cost-status.repository";
import { createPurchaseCostStatusSnapshotReader } from "../../purchase-cost-status-snapshot.repository";

vi.mock("../../purchase-cost-status.repository", async importOriginal => ({
  ...await importOriginal<typeof import("../../purchase-cost-status.repository")>(),
  readPurchaseCostStatus: vi.fn(),
}));

function status(ids: readonly number[], sku = "CURRENT"): PurchaseCostStatus {
  return { lines: ids.map(id => ({
    purchaseOrderId: 10,
    purchaseOrderLineId: id,
    sku,
    components: (["product", "packaging"] as const).map((component): PurchaseCostStatus["lines"][number]["components"][number] => ({
      component, status: "pending", sourceEvidence: "estimated",
      sourceCurrent: false, sourceRevisionId: null, applicationId: null, issues: [],
    })),
    invoices: [{ invoiceId: 20, invoiceNumber: "INV-20", lineId: id + 100, lineNumber: 1 }],
    receipts: [],
    lots: [{ id: id + 1000, lotNumber: `LOT-${id}`, onHandUnits: 5, shipmentId: 30, provisional: true, origin: "receipt" }],
  })) };
}
function transaction(): CostEvidenceTransaction {
  return { execute: vi.fn().mockResolvedValue({ rows: [] }) };
}
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.mocked(readPurchaseCostStatus).mockReset().mockImplementation(async (_tx, ids) => status(ids));
});

describe("one-entry supplier cost snapshot reader", () => {
  it("normalizes an exact set without mutating input and reuses only its current validated result", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx);
    const ids = [2, 1, 2];
    expect(await reader.read(tx, ids)).toEqual(status([1, 2]));
    expect(await reader.read(tx, [1, 2])).toEqual(status([1, 2]));
    expect(ids).toEqual([2, 1, 2]);
    expect(readPurchaseCostStatus).toHaveBeenCalledExactlyOnceWith(tx, [1, 2]);
  });

  it("does not reuse subsets, supersets or an older set after another set", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx);
    await reader.read(tx, [1, 2]);
    await reader.read(tx, [1]);
    await reader.read(tx, [1, 2]);
    expect(vi.mocked(readPurchaseCostStatus).mock.calls.map(call => call[1])).toEqual([[1, 2], [1], [1, 2]]);
  });

  it.each([[0], [-1], [1.5], ["1"], [Number.MAX_SAFE_INTEGER + 1], [NaN], [Infinity], null, {}].map(input => ({ input })))(
    "rejects invalid IDs before a possible hit and invalidates retained evidence: $input", async ({ input }) => {
      const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx);
      await reader.read(tx, [1]);
      await expect(reader.read(tx, input as unknown as readonly number[])).rejects.toThrow();
      expect(readPurchaseCostStatus).toHaveBeenCalledTimes(1);
      await reader.read(tx, [1]);
      expect(readPurchaseCostStatus).toHaveBeenCalledTimes(2);
    },
  );

  it("enforces the unique 500-line limit on every lookup while allowing duplicate IDs", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx);
    const ids = Array.from({ length: 500 }, (_, index) => index + 1);
    await reader.read(tx, ids);
    await reader.read(tx, [...ids].reverse());
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(1);
    await expect(reader.read(tx, [...ids, 501])).rejects.toMatchObject({ code: "COST_REVIEW_LIMIT" });
    await reader.read(tx, Array(501).fill(1));
    expect(readPurchaseCostStatus).toHaveBeenLastCalledWith(tx, [1]);
  });

  it("isolates nested caller changes and later changes to the direct owner's original object", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx), original = status([1]);
    vi.mocked(readPurchaseCostStatus).mockResolvedValue(original);
    const first = await reader.read(tx, [1]);
    first.lines[0].lots[0].onHandUnits = 0;
    first.lines[0].components[0].issues.push({ code: "CALLER_CHANGED", message: "Caller change." });
    first.lines[0].invoices[0].invoiceNumber = "CHANGED";
    original.lines[0].sku = "OWNER_CHANGED";
    expect(await reader.read(tx, [1])).toEqual(status([1]));
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(1);
  });

  it("rejects another executor and creates independent evidence for a fresh snapshot", async () => {
    const firstTx = transaction(), secondTx = transaction();
    vi.mocked(readPurchaseCostStatus).mockImplementation(async (tx, ids) => status(ids, tx === firstTx ? "FIRST" : "SECOND"));
    const first = createPurchaseCostStatusSnapshotReader(firstTx);
    expect(await first.read(firstTx, [1])).toEqual(status([1], "FIRST"));
    await expect(first.read(secondTx, [1])).rejects.toMatchObject({ code: "COST_STATUS_SNAPSHOT_MISMATCH" });
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(1);
    const second = createPurchaseCostStatusSnapshotReader(secondTx);
    expect(await second.read(secondTx, [1])).toEqual(status([1], "SECOND"));
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(2);
  });

  it("does not retain owner failures or incomplete, duplicate or invalid output", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx);
    vi.mocked(readPurchaseCostStatus).mockRejectedValueOnce(new CostEvidenceError("COST_REVIEW_LIMIT", "Lot evidence exceeds its limit."));
    await expect(reader.read(tx, [1])).rejects.toMatchObject({ code: "COST_REVIEW_LIMIT" });
    vi.mocked(readPurchaseCostStatus).mockResolvedValueOnce(status([]));
    await expect(reader.read(tx, [1])).rejects.toMatchObject({ code: "COST_STATUS_SCOPE_MISMATCH" });
    vi.mocked(readPurchaseCostStatus).mockResolvedValueOnce(status([1, 1]));
    await expect(reader.read(tx, [1])).rejects.toMatchObject({ code: "COST_STATUS_SCOPE_MISMATCH" });
    const invalid = status([1]); invalid.lines[0].lots[0].onHandUnits = -1;
    vi.mocked(readPurchaseCostStatus).mockResolvedValueOnce(invalid);
    await expect(reader.read(tx, [1])).rejects.toThrow();
    expect(await reader.read(tx, [1])).toEqual(status([1]));
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(5);
  });

  it("coalesces identical concurrent reads and gives each caller an independent DTO", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx), result = deferred<PurchaseCostStatus>();
    vi.mocked(readPurchaseCostStatus).mockReturnValue(result.promise);
    const first = reader.read(tx, [2, 1]), second = reader.read(tx, [1, 2, 1]);
    await Promise.resolve();
    expect(readPurchaseCostStatus).toHaveBeenCalledExactlyOnceWith(tx, [1, 2]);
    result.resolve(status([1, 2]));
    const [one, two] = await Promise.all([first, second]);
    one.lines[0].lots[0].onHandUnits = 0;
    expect(two).toEqual(status([1, 2]));
    expect(await reader.read(tx, [1, 2])).toEqual(status([1, 2]));
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(1);
  });

  it("never lets a slower earlier set replace the latest retained set", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx);
    const earlier = deferred<PurchaseCostStatus>(), latest = deferred<PurchaseCostStatus>();
    vi.mocked(readPurchaseCostStatus).mockImplementation(async (_tx, ids) => ids[0] === 1 ? earlier.promise : latest.promise);
    const first = reader.read(tx, [1]), second = reader.read(tx, [2]);
    latest.resolve(status([2]));
    expect(await second).toEqual(status([2]));
    earlier.resolve(status([1]));
    expect(await first).toEqual(status([1]));
    expect(await reader.read(tx, [2])).toEqual(status([2]));
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(2);
    await reader.read(tx, [1]);
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(3);
  });

  it("does not let an earlier rejected read clear a newer successful result", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx);
    const earlier = deferred<PurchaseCostStatus>(), latest = deferred<PurchaseCostStatus>();
    vi.mocked(readPurchaseCostStatus).mockImplementation(async (_tx, ids) => ids[0] === 1 ? earlier.promise : latest.promise);
    const first = reader.read(tx, [1]);
    const rejected = expect(first).rejects.toThrow("Earlier failure");
    const second = reader.read(tx, [2]);
    latest.resolve(status([2])); await second;
    earlier.reject(new Error("Earlier failure")); await rejected;
    expect(await reader.read(tx, [2])).toEqual(status([2]));
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(2);
  });

  it("does not promote an in-flight result after a boundary failure invalidates it", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx), result = deferred<PurchaseCostStatus>();
    vi.mocked(readPurchaseCostStatus).mockReturnValueOnce(result.promise);
    const first = reader.read(tx, [1]);
    await expect(reader.read(tx, ["1"] as unknown as number[])).rejects.toThrow();
    result.resolve(status([1])); await first;
    expect(await reader.read(tx, [1])).toEqual(status([1]));
    expect(readPurchaseCostStatus).toHaveBeenCalledTimes(2);
  });

  it("copies the requested IDs before starting an asynchronous owner read", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx), ids = [1];
    const result = reader.read(tx, ids);
    ids[0] = 2;
    expect(await result).toEqual(status([1]));
    expect(readPurchaseCostStatus).toHaveBeenCalledExactlyOnceWith(tx, [1]);
  });

  it("retains an empty validated result without inventing purchase evidence", async () => {
    const tx = transaction(), reader = createPurchaseCostStatusSnapshotReader(tx);
    expect(await reader.read(tx, [])).toEqual({ lines: [] });
    expect(await reader.read(tx, [])).toEqual({ lines: [] });
    expect(readPurchaseCostStatus).toHaveBeenCalledExactlyOnceWith(tx, []);
  });
});