import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  DropshipCategoryMarksJobService,
  type CategoryMarksJobSource,
  type CategoryMarksStore,
} from "../../application/dropship-category-marks-job-service";
import type { ListingSettingSystemTransaction, ListingSettingWriteRepository } from "../../application/dropship-listing-setting-writes";
import { DropshipError } from "../../domain/errors";

const NOW = new Date("2026-10-13T09:15:00.000Z");
const JOB_KEY = "category-marks:2026-10-13T09";

type LogMock = Mock<(action: string, fields: Record<string, unknown>) => void>;

/** The job's reads, with each vendor's chosen products or failure chosen per case; frozen, so a mutation would throw. */
class FakeSource implements CategoryMarksJobSource {
  readonly calls: Array<{ vendorId: number; now: Date }> = [];
  stores: readonly CategoryMarksStore[] = [];
  selected = new Map<number, readonly number[] | Error>();
  storesFailure: Error | null = null;
  async listMarkableStores(): Promise<CategoryMarksStore[]> {
    if (this.storesFailure) throw this.storesFailure;
    return this.stores as CategoryMarksStore[];
  }
  async listSelectedProductIds(vendorId: number, now: Date): Promise<number[]> {
    this.calls.push({ vendorId, now });
    const selected = this.selected.get(vendorId) ?? Object.freeze([]);
    if (selected instanceof Error) throw selected;
    return selected as number[];
  }
}

/** The system transaction: each store's inserted marks or failure chosen per case. */
class FakeRepository implements Pick<ListingSettingWriteRepository, "executeForSystem"> {
  readonly executions: Array<{ storeConnectionId: number; jobKey: string; insert: { productIds: readonly number[]; jobKey: string; now: Date } | null }> = [];
  inserted = new Map<number, number[] | Error>();
  async executeForSystem<T>(input: { storeConnectionId: number; jobKey: string },
    operation: (tx: ListingSettingSystemTransaction) => Promise<T>): Promise<T> {
    const execution: (typeof this.executions)[number] = { ...input, insert: null };
    this.executions.push(execution);
    const outcome = this.inserted.get(input.storeConnectionId) ?? [];
    if (outcome instanceof Error) throw outcome;
    const tx = {
      vendorId: 0,
      storeConnectionId: input.storeConnectionId,
      insertFirstCategoryMarks: async (insert: { productIds: readonly number[]; jobKey: string; now: Date }) => {
        execution.insert = insert;
        return { insertedProductIds: outcome };
      },
    } as unknown as ListingSettingSystemTransaction;
    return operation(tx);
  }
}

const busy = () => new DropshipError("DROPSHIP_LISTING_SETTINGS_BUSY", "Listing settings are being changed by another request. Try again.",
  { sqlState: "40P01", retryable: true, classification: "transient" });
const storeGone = () => new DropshipError("DROPSHIP_STORE_CONNECTION_REQUIRED", "Store connection was not found.",
  { storeConnectionId: 25, retryable: false, classification: "permanent" });
const invariant = () => new DropshipError("DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", "A first category mark run breaks the writer contract.",
  { invalid: ["jobKey"], retryable: false, classification: "fatal" });

let source: FakeSource;
let repository: FakeRepository;
let log: { debug: LogMock; info: LogMock; warn: LogMock; error: LogMock };
let clock: { now: Mock<() => Date> };
let timer: Mock<() => number>;
let service: DropshipCategoryMarksJobService;

beforeEach(() => {
  source = new FakeSource();
  repository = new FakeRepository();
  log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  clock = { now: vi.fn(() => NOW) };
  let tick = 1_000;
  timer = vi.fn(() => { const value = tick; tick += 250; return value; });
  service = new DropshipCategoryMarksJobService({ source, repository, clock, timer, log });
});

const stores = (...pairs: Array<[vendorId: number, storeConnectionId: number]>) =>
  Object.freeze(pairs.map(([vendorId, storeConnectionId]) => Object.freeze({ vendorId, storeConnectionId })));

describe("DropshipCategoryMarksJobService.runOnce (plan PR 9, 10.5)", () => {
  it("scans each vendor once and marks each of its stores with one job key and one clock reading", async () => {
    source.stores = stores([10, 22], [10, 24], [11, 23]);
    source.selected.set(10, Object.freeze([7, 8])).set(11, Object.freeze([9]));
    repository.inserted.set(22, [7, 8]).set(24, [8]).set(23, []);

    const result = await service.runOnce();

    expect(source.calls).toEqual([{ vendorId: 10, now: NOW }, { vendorId: 11, now: NOW }]);
    expect(source.calls.every((call) => call.now === NOW)).toBe(true);
    expect(repository.executions).toEqual([
      { storeConnectionId: 22, jobKey: JOB_KEY, insert: { productIds: [7, 8], jobKey: JOB_KEY, now: NOW } },
      { storeConnectionId: 24, jobKey: JOB_KEY, insert: { productIds: [7, 8], jobKey: JOB_KEY, now: NOW } },
      { storeConnectionId: 23, jobKey: JOB_KEY, insert: { productIds: [9], jobKey: JOB_KEY, now: NOW } },
    ]);
    expect(clock.now).toHaveBeenCalledOnce();
    expect(result).toEqual({ jobKey: JOB_KEY, storesScanned: 3, vendorsScanned: 2, vendorsFailed: 0, storesFailed: 0,
      insertedCount: 3, elapsedMs: 250 });
  });

  it("logs one INFO line per store that gained marks and one INFO tick line, with ids capped at 100", async () => {
    const many = Array.from({ length: 150 }, (_, index) => 1_000 + index);
    source.stores = stores([10, 22], [10, 24]);
    source.selected.set(10, Object.freeze(many));
    repository.inserted.set(22, many).set(24, []);

    await service.runOnce();

    expect(log.info.mock.calls).toEqual([
      ["dropship.listing_settings.category_marks_seeded", { outcome: "seeded", job_key: JOB_KEY, vendor_id: 10, store_connection_id: 22,
        inserted_count: 150, inserted_product_ids: many.slice(0, 100) }],
      ["dropship.listing_settings.category_marks_tick", { outcome: "completed", job_key: JOB_KEY, stores_scanned: 2, vendors_scanned: 1,
        vendors_failed: 0, stores_failed: 0, inserted_count: 150, elapsed_ms: 250 }],
    ]);
    expect(log.debug).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs a quiet tick (nothing inserted, nothing failed) at DEBUG only", async () => {
    source.stores = stores([10, 22]);
    source.selected.set(10, Object.freeze([7]));

    await service.runOnce();

    expect(log.info).not.toHaveBeenCalled();
    expect(log.debug).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_tick", expect.objectContaining({
      outcome: "completed", inserted_count: 0, stores_scanned: 1 }));
  });

  it("scans nothing when no store is eligible", async () => {
    const result = await service.runOnce();
    expect(source.calls).toEqual([]);
    expect(repository.executions).toEqual([]);
    expect(result).toMatchObject({ storesScanned: 0, vendorsScanned: 0, insertedCount: 0 });
  });

  it("opens no transaction for a vendor with nothing chosen: no store lock is taken for nothing", async () => {
    source.stores = stores([10, 22], [11, 23]);
    source.selected.set(10, Object.freeze([])).set(11, Object.freeze([9]));

    await service.runOnce();

    expect(repository.executions.map((execution) => execution.storeConnectionId)).toEqual([23]);
  });

  it("skips only the vendor whose scan failed: its stores get no transaction, the others are marked", async () => {
    source.stores = stores([10, 22], [10, 24], [11, 23]);
    source.selected.set(10, new Error("Pricing catalog cursor did not advance.")).set(11, Object.freeze([9]));
    repository.inserted.set(23, [9]);

    const result = await service.runOnce();

    expect(repository.executions.map((execution) => execution.storeConnectionId)).toEqual([23]);
    expect(result).toMatchObject({ vendorsScanned: 2, vendorsFailed: 1, storesFailed: 0, insertedCount: 1 });
    expect(log.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_vendor_failed", {
      job_key: JOB_KEY, vendor_id: 10, store_connection_ids: [22, 24], outcome: "failed",
      error_code: "DROPSHIP_CATEGORY_MARKS_VENDOR_FAILED", error_class: "fatal", error_message: "Pricing catalog cursor did not advance." });
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_marks_tick", expect.objectContaining({
      outcome: "partial", vendors_failed: 1 }));
  });

  it("logs a scan the database could not serve at WARN: retryable, retried next hour", async () => {
    source.stores = stores([10, 22]);
    source.selected.set(10, busy());

    await service.runOnce();

    expect(log.warn).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_vendor_failed", expect.objectContaining({
      vendor_id: 10, outcome: "deferred", error_code: "DROPSHIP_LISTING_SETTINGS_BUSY", error_class: "transient" }));
    expect(log.error).not.toHaveBeenCalled();
    // A failure alone, with nothing inserted, still makes the tick line INFO.
    expect(log.info).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_tick", expect.objectContaining({
      outcome: "partial", inserted_count: 0, vendors_failed: 1, stores_failed: 0 }));
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("classifies each failed store: BUSY at WARN, a store deleted since the list at DEBUG, a broken contract at ERROR; the tick goes on", async () => {
    source.stores = stores([10, 22], [10, 24], [10, 25], [10, 26]);
    source.selected.set(10, Object.freeze([7]));
    repository.inserted.set(22, busy()).set(24, storeGone()).set(25, invariant()).set(26, [7]);

    const result = await service.runOnce();

    expect(repository.executions.map((execution) => execution.storeConnectionId)).toEqual([22, 24, 25, 26]);
    expect(result).toMatchObject({ storesScanned: 4, storesFailed: 3, vendorsFailed: 0, insertedCount: 1 });
    expect(log.warn).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_store_failed", {
      job_key: JOB_KEY, vendor_id: 10, store_connection_id: 22, outcome: "deferred",
      error_code: "DROPSHIP_LISTING_SETTINGS_BUSY", error_class: "transient" });
    expect(log.debug).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_store_failed", {
      job_key: JOB_KEY, vendor_id: 10, store_connection_id: 24, outcome: "skipped",
      error_code: "DROPSHIP_STORE_CONNECTION_REQUIRED", error_class: "permanent" });
    expect(log.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_store_failed", {
      job_key: JOB_KEY, vendor_id: 10, store_connection_id: 25, outcome: "failed",
      error_code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED", error_class: "fatal",
      error_message: "A first category mark run breaks the writer contract.",
      error_context: { invalid: ["jobKey"], retryable: false, classification: "fatal" } });
    expect(log.info).toHaveBeenCalledWith("dropship.listing_settings.category_marks_tick", expect.objectContaining({
      outcome: "partial", stores_failed: 3, inserted_count: 1 }));
  });

  it("logs a plain error from a store at ERROR, under the line's own code", async () => {
    source.stores = stores([10, 22]);
    source.selected.set(10, Object.freeze([7]));
    repository.inserted.set(22, new TypeError("boom"));

    await service.runOnce();

    expect(log.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_store_failed", {
      job_key: JOB_KEY, vendor_id: 10, store_connection_id: 22, outcome: "failed", error_code: "DROPSHIP_CATEGORY_MARKS_STORE_FAILED",
      error_class: "fatal", error_message: "boom" });
  });

  it("keeps an unmapped server error's SQLSTATE beside the line's code", async () => {
    source.stores = stores([10, 22]);
    source.selected.set(10, Object.freeze([7]));
    // The wrapper rethrows a server error it does not map as it is (plan 3.9).
    repository.inserted.set(22, Object.assign(new Error("relation does not exist"), { code: "42P01" }));

    await service.runOnce();

    expect(log.error).toHaveBeenCalledExactlyOnceWith("dropship.listing_settings.category_marks_store_failed", expect.objectContaining({
      store_connection_id: 22, error_code: "DROPSHIP_CATEGORY_MARKS_STORE_FAILED", error_class: "fatal", cause_code: "42P01",
      error_message: "relation does not exist" }));
  });

  it("fails the tick when the store list cannot be read: the runner logs it, the next tick runs in an hour", async () => {
    source.storesFailure = busy();
    await expect(service.runOnce()).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_BUSY" });
    expect(repository.executions).toEqual([]);
  });

  it("refuses a clock reading it cannot name an hour by, before any read", async () => {
    clock.now.mockReturnValue(new Date(Number.NaN));
    source.stores = stores([10, 22]);
    await expect(service.runOnce()).rejects.toMatchObject({ code: "DROPSHIP_LISTING_SETTINGS_INVARIANT_FAILED" });
    expect(source.calls).toEqual([]);
  });

  it("never changes what the source returned", async () => {
    const listed = stores([10, 24], [10, 22]);
    const chosen = Object.freeze([8, 7]);
    source.stores = listed;
    source.selected.set(10, chosen);

    await service.runOnce();

    expect(listed.map((store) => store.storeConnectionId)).toEqual([24, 22]);
    expect(chosen).toEqual([8, 7]);
    // The stores run in the order listed (the source orders them); the ids pass to the writer as the scan gave them.
    expect(repository.executions.map((execution) => [execution.storeConnectionId, execution.insert?.productIds])).toEqual([
      [24, [8, 7]], [22, [8, 7]]]);
  });
});
