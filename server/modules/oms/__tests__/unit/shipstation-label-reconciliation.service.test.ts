import { describe, expect, it, vi } from "vitest";
import { createShipStationLabelReconciliationService, planLabelScanWindow,
  type LabelScanCheckpoint, type LabelScanRepository, type LabelScanSource, type ShipStationLabelSnapshot } from "../../shipstation-label-reconciliation.service";
import type { ShipStationShipment } from "../../shipstation.service";

const now = new Date("2026-09-21T20:00:00Z");
function shipment(id: number, voided = false, orderId = 790960007): ShipStationShipment {
  return { shipmentId: id, orderId, orderKey: "echelon-wms-shp-17763", orderNumber: "63261 / 63300",
    carrierCode: "fedex", serviceCode: "fedex_ground", trackingNumber: `TRACK${id}`, shipmentCost: 0,
    isReturnLabel: false, shipDate: "2026-09-21", voidDate: voided ? "2026-09-21T10:23:21.9930000" : null,
    shipmentItems: [{ lineItemKey: "wms-item-23321", sku: "SAME", quantity: 12 },
      { lineItemKey: "wms-item-23217", sku: "SAME", quantity: 5 }] };
}
function fixture() {
  const checkpoint: LabelScanCheckpoint = { version: 0, completedThrough: new Date("2026-09-20T20:00:00Z"), window: null, lastSuccessAt: null };
  const repository = {
    readOrCreate: vi.fn(async () => checkpoint),
    claim: vi.fn<LabelScanRepository["claim"]>(async (state, window) => ({ ...state, window, version: state.version + 1 })),
    renew: vi.fn(async () => undefined), completePage: vi.fn(async () => undefined), fail: vi.fn(async () => undefined),
  } satisfies LabelScanRepository;
  const original = shipment(460595426, true);
  const replacement = shipment(460686839);
  const source = {
    isConfigured: vi.fn(() => true),
    listVoids: vi.fn<LabelScanSource["listVoids"]>(async () => ({ shipments: [original], page: 1, pages: 1, total: 1 })),
    // Deliberately reversed provider order. Processing must still put voids first.
    listOrderLabels: vi.fn<LabelScanSource["listOrderLabels"]>(async (_orderId, _page) => ({ shipments: [replacement, original], page: 1, pages: 1, total: 2 })),
  } satisfies LabelScanSource;
  const processLabels = vi.fn(async (labels: ShipStationLabelSnapshot[]) => labels.length);
  const service = createShipStationLabelReconciliationService({ repository, source, processLabels, clock: { now: () => now } });
  return { service, repository, source, processLabels, checkpoint, original, replacement };
}

describe("durable ShipStation void discovery", () => {
  it.each(["ordinary", "combined"])("recovers a missed %s void before admitting its replacement", async shape => {
    const f = fixture();
    if (shape === "ordinary") f.original.shipmentItems = f.replacement.shipmentItems = f.original.shipmentItems!.slice(0, 1);
    expect(await f.service.runOnce()).toEqual({ outcome: "processed", voids: 1, orders: 1 });
    expect(f.processLabels.mock.calls.map(([labels]) => labels.map(label => label.shipmentId)))
      .toEqual([[460595426], [460595426, 460686839]]);
    expect(f.source.listOrderLabels).toHaveBeenCalledWith(790960007, 1);
    expect(f.repository.completePage).toHaveBeenCalledWith(expect.objectContaining({ version: 1 }), false, now);
  });
  it("discovers a void without requiring a replacement notification", async () => {
    const f = fixture(); f.source.listOrderLabels.mockResolvedValue({ shipments: [f.original], page: 1, pages: 1, total: 1 });
    await f.service.runOnce();
    expect(f.processLabels.mock.calls.flatMap(([labels]) => labels)).toEqual([f.original, f.original]);
  });
  it("observes a standalone void without inventing an order ID", async () => {
    const f = fixture();
    f.source.listVoids.mockResolvedValue({ shipments: [{ ...f.original, orderId: null }], page: 1, pages: 1, total: 1 });
    expect(await f.service.runOnce()).toEqual({ outcome: "processed", voids: 1, orders: 0 });
    expect(f.source.listOrderLabels).not.toHaveBeenCalled(); expect(f.processLabels).toHaveBeenCalledTimes(1);
  });
  it("reads each affected order once per page, including multiple voids", async () => {
    const f = fixture(); const other = shipment(460595427, true);
    f.source.listVoids.mockResolvedValue({ shipments: [f.original, other], page: 1, pages: 1, total: 2 });
    f.source.listOrderLabels.mockResolvedValue({ shipments: [f.original, other, f.replacement], page: 1, pages: 1, total: 3 });
    expect(await f.service.runOnce()).toMatchObject({ voids: 2, orders: 1 });
    expect(f.source.listOrderLabels).toHaveBeenCalledTimes(1);
  });
  it("persists only one void page per run, then resumes the exact next page", async () => {
    const f = fixture(); f.source.listVoids.mockResolvedValue({ shipments: [f.original], page: 2, pages: 3, total: 21 });
    f.checkpoint.window = { start: new Date("2026-09-20"), end: new Date("2026-09-21"), page: 2 };
    await f.service.runOnce();
    expect(f.source.listVoids).toHaveBeenCalledTimes(1);
    expect(f.source.listVoids).toHaveBeenCalledWith(f.checkpoint.window);
    expect(f.repository.completePage).toHaveBeenCalledWith(expect.objectContaining({ window: f.checkpoint.window }), true, now);
  });
  it("paginates related labels before processing any active replacement", async () => {
    const f = fixture(); f.source.listOrderLabels.mockResolvedValueOnce({ shipments: [f.original], page: 1, pages: 2, total: 2 })
      .mockResolvedValueOnce({ shipments: [f.replacement], page: 2, pages: 2, total: 2 });
    await f.service.runOnce(); expect(f.source.listOrderLabels.mock.calls).toEqual([[790960007, 1], [790960007, 2]]);
    expect(f.processLabels.mock.calls[1][0]).toEqual([f.original, f.replacement]);
  });
  it.each(["provider", "observation", "checkpoint"])("does not advance on a %s failure", async failure => {
    const f = fixture();
    if (failure === "provider") f.source.listOrderLabels.mockRejectedValue(new Error("private provider response"));
    if (failure === "observation") f.processLabels.mockRejectedValue(new Error("intake failed"));
    if (failure === "checkpoint") f.repository.completePage.mockRejectedValue(new Error("database unavailable"));
    await expect(f.service.runOnce()).rejects.toThrow();
    expect(f.repository.fail).toHaveBeenCalledWith(expect.anything(), "SHIPSTATION_LABEL_SCAN_FAILED", now);
    if (failure !== "checkpoint") expect(f.repository.completePage).not.toHaveBeenCalled();
  });
  it("does not turn an incomplete/stale order read into proof the void disappeared", async () => {
    const f = fixture(); f.source.listOrderLabels.mockResolvedValue({ shipments: [f.replacement], page: 1, pages: 1, total: 1 });
    await expect(f.service.runOnce()).rejects.toMatchObject({ code: "SHIPSTATION_VOID_SNAPSHOT_CONFLICT" });
    expect(f.processLabels).toHaveBeenCalledTimes(1); expect(f.repository.completePage).not.toHaveBeenCalled();
  });
  it("bounds order-label pagination and does not process an incomplete order", async () => {
    const f = fixture(); f.source.listOrderLabels.mockImplementation(async (_id, page) => ({ shipments: [], page, pages: 9, total: 900 }));
    await expect(f.service.runOnce()).rejects.toMatchObject({ code: "SHIPSTATION_ORDER_LABEL_LIMIT" });
    expect(f.source.listOrderLabels).toHaveBeenCalledTimes(5); expect(f.processLabels).toHaveBeenCalledTimes(1);
  });
  it("does not call the provider if another process owns the lease", async () => {
    const f = fixture(); f.repository.claim.mockResolvedValue(null);
    expect(await f.service.runOnce()).toMatchObject({ outcome: "busy" }); expect(f.source.listVoids).not.toHaveBeenCalled();
  });
  it("does no work without configured credentials", async () => {
    const f = fixture(); f.source.isConfigured.mockReturnValue(false);
    expect(await f.service.runOnce()).toMatchObject({ outcome: "disabled" }); expect(f.repository.readOrCreate).not.toHaveBeenCalled();
  });
  it("does not invent progress when the clock moves backwards", () => {
    const f = fixture(); expect(planLabelScanWindow(f.checkpoint, new Date("2026-09-19"))).toBeNull();
  });
  it("uses a bounded overlap and advances an outage backlog one day at a time", () => {
    const f = fixture(); f.checkpoint.completedThrough = new Date("2026-09-01T20:00:00Z"); f.checkpoint.lastSuccessAt = new Date("2026-09-01T20:00:00Z");
    expect(planLabelScanWindow(f.checkpoint, now)).toEqual({ start: new Date("2026-08-31T20:00:00Z"), end: new Date("2026-09-02T20:00:00Z"), page: 1 });
  });
});
