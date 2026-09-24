import { afterEach, describe, expect, it, vi } from "vitest";
import { projectCustomerReturnOriginalBoxCandidates, readCustomerReturnOriginalBoxes } from "../../application/customer-return-live-packaging";
import { CustomerReturnPackageDimensionsError } from "../../application/customer-return-package-dimensions.ports";
import { addLiveOriginalBox, liveLocalFixture } from "../support/live-inspection-fixtures";

const dimensions = { lengthMm: 300, widthMm: 200, heightMm: 100 };
function fixture() { const local = liveLocalFixture(); addLiveOriginalBox(local); return local; }
afterEach(() => { vi.useRealTimers(); });

describe("exact original return box projection", () => {
  it("reads one original package once and retains separate same-SKU purchased quantities without leaking provider IDs", async () => {
    const local = fixture(), before = JSON.stringify(local);
    const read = vi.fn(async () => dimensions);
    const boxes = await readCustomerReturnOriginalBoxes(local, { read }, vi.fn());
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]).toEqual([{ providerPhysicalShipmentId: "601", trackingNumber: "TRACK601" }, expect.any(AbortSignal)]);
    expect(boxes).toEqual([{ id: expect.stringMatching(/^box-[a-f0-9]{64}$/), dimensions,
      items: expect.arrayContaining([{ lineId: expect.stringMatching(/^line-/), quantity: 2 }, { lineId: expect.stringMatching(/^line-/), quantity: 1 }]) }]);
    expect(new Set(boxes[0].items.map(item => item.lineId)).size).toBe(2);
    expect(JSON.stringify(boxes)).not.toMatch(/TRACK601|provider|physicalShipment|sku/);
    expect(JSON.stringify(local)).toBe(before);
  });

  it.each(["void", "return_label", "replacement", "correction", "unattributable", "other_order", "other_line", "no_label", "unknown_provider_id", "zero", "overfull"])(
    "does not offer a partial or unsafe %s package", async kind => {
      const local = fixture();
      if (kind === "void") local.packageItems[0].status = "voided";
      if (kind === "return_label") local.packageLabels[0].direction = "return";
      if (kind === "replacement") local.packageItems[0].replacementForOrderItemId = 301;
      if (kind === "correction") local.packageItems[0].correctionForPhysicalShipmentItemId = 999;
      if (kind === "unattributable") local.packageItems[1].wmsOrderItemId = null;
      if (kind === "other_order") local.wmsItems[0].externalOrderId = "999";
      if (kind === "other_line") local.packageItems[0].omsOrderLineId = 102;
      if (kind === "no_label") local.packageLabels = [];
      if (kind === "unknown_provider_id") local.packageItems[0].providerPhysicalShipmentId = "ambiguous";
      if (kind === "zero") local.packageItems[0].effectiveQuantity = 0;
      if (kind === "overfull") local.packageItems[0].effectiveQuantity = 4;
      const read = vi.fn(async () => dimensions);
      expect(await readCustomerReturnOriginalBoxes(local, { read }, vi.fn())).toEqual([]);
      expect(read).not.toHaveBeenCalled();
    });

  it("does not invent exact provenance from malformed WMS identifiers", () => {
    const local = fixture(); local.wmsItems[0].externalOrderId = "not-an-order-id";
    expect(projectCustomerReturnOriginalBoxCandidates(local)).toEqual([]);
  });

  it.each([null, { lengthMm: 0, widthMm: 200, heightMm: 100 }, { ...dimensions, providerSecret: "private" }])(
    "omits missing or invalid provider measurements with a safe diagnostic %#", async result => {
      const report = vi.fn();
      expect(await readCustomerReturnOriginalBoxes(fixture(), { read: vi.fn(async () => result as never) }, report)).toEqual([]);
      expect(report).toHaveBeenCalledWith({ operation: "original_box_dimensions", code: result === null ? "RETURN_BOX_DIMENSIONS_MISSING" : "RETURN_BOX_DIMENSIONS_INVALID" });
    });

  it("classifies provider configuration and unexpected failures without throwing or exposing secrets", async () => {
    for (const error of [new CustomerReturnPackageDimensionsError("RETURN_PACKAGE_NOT_CONFIGURED", "configuration"), new Error("secret token")]) {
      const report = vi.fn();
      expect(await readCustomerReturnOriginalBoxes(fixture(), { read: vi.fn(async () => { throw error; }) }, report)).toEqual([]);
      expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
    }
  });

  it("bounds the complete optional provider phase even when an adapter ignores cancellation", async () => {
    vi.useFakeTimers();
    const report = vi.fn(); let signal: AbortSignal | undefined;
    const read = vi.fn((_input, parent?: AbortSignal) => { signal = parent; return new Promise<null>(() => {}); });
    const work = readCustomerReturnOriginalBoxes(fixture(), { read }, report);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await work).toEqual([]);
    expect(signal?.aborted).toBe(true);
    expect(report).toHaveBeenCalledWith({ operation: "original_box_dimensions", code: "RETURN_BOX_DIMENSIONS_BUDGET_EXCEEDED" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs at most two unique physical shipment reads at once", async () => {
    const local = fixture();
    local.packageItems = Array.from({ length: 3 }, (_, index) => ({ ...local.packageItems[0], physicalShipmentId: 1000 + index,
      physicalShipmentItemId: 2000 + index, providerPhysicalShipmentId: String(3000 + index), originalQuantity: 1, effectiveQuantity: 1 }));
    local.packageLabels = local.packageItems.map((item, index) => ({ ...local.packageLabels[0], linkId: 4000 + index,
      labelId: 5000 + index, physicalShipmentId: item.physicalShipmentId }));
    const finish: Array<() => void> = []; let active = 0, maximumActive = 0;
    const read = vi.fn(async () => {
      active++; maximumActive = Math.max(maximumActive, active);
      await new Promise<void>(resolve => finish.push(resolve)); active--;
      return dimensions;
    });
    const work = readCustomerReturnOriginalBoxes(local, { read }, vi.fn());
    expect(read).toHaveBeenCalledTimes(2);
    finish[0]();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(3));
    finish[1](); finish[2]();
    expect(await work).toHaveLength(3);
    expect(maximumActive).toBe(2);
  });

  it("does not hide excess package cardinality by returning arbitrary truncated presets", async () => {
    const local = fixture(); local.lines[0].quantity = 101; local.wmsItems[0].quantity = 101;
    local.packageItems = Array.from({ length: 101 }, (_, index) => ({ ...local.packageItems[0], physicalShipmentId: 1000 + index,
      physicalShipmentItemId: 2000 + index, providerPhysicalShipmentId: String(3000 + index), originalQuantity: 1, effectiveQuantity: 1 }));
    local.packageLabels = local.packageItems.map((item, index) => ({ ...local.packageLabels[0], linkId: 4000 + index,
      labelId: 5000 + index, physicalShipmentId: item.physicalShipmentId }));
    const read = vi.fn(async () => dimensions), report = vi.fn();
    expect(await readCustomerReturnOriginalBoxes(local, { read }, report)).toEqual([]);
    expect(read).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({ operation: "original_box_dimensions", code: "RETURN_BOX_DIMENSIONS_LIMIT" });
  });
});
