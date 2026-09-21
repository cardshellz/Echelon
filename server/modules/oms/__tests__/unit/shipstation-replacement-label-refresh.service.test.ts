import { afterEach, describe, expect, it, vi } from "vitest";
import { createShipStationReplacementLabelRefresh, type ShipStationLabelRefreshSource } from "../../shipstation-replacement-label-refresh.service";
import type { ShipStationRelatedLabelReader } from "../../../shipping/shipstation-related-labels.reader";
import type { ShipStationLabelSnapshot } from "../../shipstation-label-reconciliation.service";
import { createShipStationService } from "../../shipstation.service";

const original: ShipStationLabelSnapshot = { shipmentId: 101, orderId: 201, trackingNumber: "TRACK101",
  isReturnLabel: false, voidDate: "2026-09-21T17:00:00Z", voided: true,
  shipmentItems: [{ lineItemKey: "wms-item-301", quantity: 1 }] };
const replacement: ShipStationLabelSnapshot = { ...original, shipmentId: 102, trackingNumber: "TRACK102", voidDate: null, voided: false };
function fixture() {
  const reader = { findRelatedActiveLabels: vi.fn<ShipStationRelatedLabelReader["findRelatedActiveLabels"]>(async () => [
    { providerLabelId: "101", providerOrderId: "201", trackingNumber: "TRACK101" },
  ]) };
  const source = {
    listOrderLabels: vi.fn<ShipStationLabelRefreshSource["listOrderLabels"]>(async () => ({ shipments: [replacement, original], page: 1, pages: 1, total: 2 })),
    listTrackingLabels: vi.fn<ShipStationLabelRefreshSource["listTrackingLabels"]>(async () => ({ shipments: [original], page: 1, pages: 1, total: 1 })),
  };
  const observeVoids = vi.fn(async (_labels: ShipStationLabelSnapshot[]) => undefined);
  return { reader, source, observeVoids, refresh: createShipStationReplacementLabelRefresh({ reader, source, observeVoids }) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("new-label-triggered predecessor refresh", () => {
  it("queries by exact source identities and observes a proven void", async () => {
    const f = fixture(); await f.refresh.beforeActiveLabel(replacement);
    expect(f.reader.findRelatedActiveLabels).toHaveBeenCalledWith({ providerLabelId: "102", providerOrderId: "201", sourceWmsShipmentItemIds: [301] });
    expect(f.source.listOrderLabels).toHaveBeenCalledWith(201, 1);
    expect(f.observeVoids).toHaveBeenCalledWith([original]);
  });
  it("refreshes the old provider order even when a combined/recreated package has a new order ID", async () => {
    const f = fixture(); await f.refresh.beforeActiveLabel({ ...replacement, orderId: 999 });
    expect(f.source.listOrderLabels).toHaveBeenCalledWith(201, 1);
    expect(f.observeVoids).toHaveBeenCalledWith([original]);
  });
  it("never treats a legitimate active split label as void", async () => {
    const f = fixture(); f.source.listOrderLabels.mockResolvedValue({ shipments: [{ ...original, voided: false, voidDate: null }], page: 1, pages: 1, total: 1 });
    await f.refresh.beforeActiveLabel(replacement); expect(f.observeVoids).not.toHaveBeenCalled();
  });
  it("makes no provider reads for a first label", async () => {
    const f = fixture(); f.reader.findRelatedActiveLabels.mockResolvedValue([]);
    await f.refresh.beforeActiveLabel(replacement); expect(f.source.listOrderLabels).not.toHaveBeenCalled();
  });
  it.each([{ isReturnLabel: true }, { voidDate: original.voidDate }])("does not recursively refresh voids or returns: %j", async change => {
    const f = fixture(); await f.refresh.beforeActiveLabel({ ...replacement, ...change });
    expect(f.reader.findRelatedActiveLabels).not.toHaveBeenCalled();
  });
  it("never promotes SKU into line identity when exact contents are absent", async () => {
    const f = fixture(); f.reader.findRelatedActiveLabels.mockResolvedValue([]);
    await f.refresh.beforeActiveLabel({ ...replacement, shipmentItems: [{ sku: "SAME", quantity: 1 }] });
    expect(f.reader.findRelatedActiveLabels).toHaveBeenCalledWith(expect.objectContaining({ sourceWmsShipmentItemIds: [] }));
  });
  it("supports a standalone prior label but requires its exact provider label ID, not tracking alone", async () => {
    const f = fixture(); f.reader.findRelatedActiveLabels.mockResolvedValue([{ providerLabelId: "101", providerOrderId: null, trackingNumber: "TRACK101" }]);
    await f.refresh.beforeActiveLabel(replacement);
    expect(f.source.listTrackingLabels).toHaveBeenCalledWith("TRACK101", 1);
    expect(f.observeVoids).toHaveBeenCalledWith([original]);
  });
  it.each([
    ["SHIPSTATION_RELATED_LABEL_NOT_FOUND", { ...original, shipmentId: 999 }],
    ["SHIPSTATION_RELATED_LABEL_IDENTITY_CONFLICT", { ...original, trackingNumber: "WRONG" }],
    ["SHIPSTATION_RELATED_LABEL_IDENTITY_CONFLICT", { ...original, orderId: 999 }],
    ["SHIPSTATION_RELATED_LABEL_IDENTITY_CONFLICT", { ...original, isReturnLabel: true }],
    ["SHIPSTATION_VOID_EVIDENCE_MISSING", { ...original, voidDate: null }],
    ["SHIPSTATION_VOID_EVIDENCE_MISSING", { ...original, voided: false }],
  ] as const)("rejects ambiguous provider evidence: %s", async (code, snapshot) => {
    const f = fixture(); f.source.listOrderLabels.mockResolvedValue({ shipments: [snapshot], page: 1, pages: 1, total: 1 });
    await expect(f.refresh.beforeActiveLabel(replacement)).rejects.toMatchObject({ code });
    expect(f.observeVoids).not.toHaveBeenCalled();
  });
  it("reads all bounded pages and rejects a moving page total", async () => {
    const f = fixture(); f.source.listOrderLabels.mockResolvedValueOnce({ shipments: [replacement], page: 1, pages: 2, total: 2 })
      .mockResolvedValueOnce({ shipments: [original], page: 2, pages: 2, total: 3 });
    await expect(f.refresh.beforeActiveLabel(replacement)).rejects.toMatchObject({ code: "SHIPSTATION_RELATED_LABEL_PAGE_CHANGED" });
    expect(f.observeVoids).not.toHaveBeenCalled();
  });
  it("finds the exact predecessor beyond the first page", async () => {
    const f = fixture(); f.source.listOrderLabels.mockResolvedValueOnce({ shipments: [replacement], page: 1, pages: 2, total: 2 })
      .mockResolvedValueOnce({ shipments: [original], page: 2, pages: 2, total: 2 });
    await f.refresh.beforeActiveLabel(replacement);
    expect(f.source.listOrderLabels).toHaveBeenNthCalledWith(2, 201, 2);
    expect(f.observeVoids).toHaveBeenCalledWith([original]);
  });
  it("rejects overlapping pages without guessing which snapshot is current", async () => {
    const f = fixture(); f.source.listOrderLabels.mockResolvedValueOnce({ shipments: [original], page: 1, pages: 2, total: 2 })
      .mockResolvedValueOnce({ shipments: [original], page: 2, pages: 2, total: 2 });
    await expect(f.refresh.beforeActiveLabel(replacement)).rejects.toMatchObject({ code: "SHIPSTATION_ORDER_LABEL_PAGE_OVERLAP" });
    expect(f.observeVoids).not.toHaveBeenCalled();
  });
  it("does not run an unbounded provider history scan", async () => {
    const f = fixture(); f.source.listOrderLabels.mockImplementation(async (_id, page) => ({
      shipments: [{ ...replacement, shipmentId: 1000 + page }], page, pages: 6, total: 6,
    }));
    await expect(f.refresh.beforeActiveLabel(replacement)).rejects.toMatchObject({ code: "SHIPSTATION_ORDER_LABEL_LIMIT" });
    expect(f.source.listOrderLabels).toHaveBeenCalledTimes(5); expect(f.observeVoids).not.toHaveBeenCalled();
  });
  it("reuses a provider-order read only within one webhook delivery", async () => {
    const f = fixture(); await f.refresh.beforeActiveLabel(replacement); await f.refresh.beforeActiveLabel(replacement);
    expect(f.source.listOrderLabels).toHaveBeenCalledTimes(1);
    await createShipStationReplacementLabelRefresh(f).beforeActiveLabel(replacement);
    expect(f.source.listOrderLabels).toHaveBeenCalledTimes(2);
  });
  it.each(["success", "provider_failure", "void_write_failure"])("runs before new label observation/fulfillment through actual webhook intake: %s", async mode => {
    const f = fixture(); const operations: string[] = [];
    vi.stubEnv("SHIPSTATION_API_KEY", "test-key"); vi.stubEnv("SHIPSTATION_API_SECRET", "test-secret");
    vi.stubGlobal("fetch", vi.fn(async (rawUrl: string) => {
      const url = new URL(rawUrl);
      if (url.searchParams.has("orderId")) {
        operations.push("refresh");
        if (mode === "provider_failure") throw new Error("Provider unavailable");
        return new Response(JSON.stringify({ shipments: [original, replacement], page: 1, pages: 1, total: 2 }));
      }
      return new Response(JSON.stringify({ shipments: [replacement] }));
    }));
    const service = createShipStationService({}, undefined, {
      relatedLabelReader: f.reader,
      providerLabelObserver: { async observeShipStationLabel(raw) {
        const label = raw as ShipStationLabelSnapshot; operations.push(`observe:${label.shipmentId}`);
        if (mode === "void_write_failure" && label.shipmentId === 101) throw new Error("Void outbox unavailable");
        return { shippingProviderLabelId: label.shipmentId, labelInserted: false, eventInserted: true };
      } },
      labelCommercialFulfillment: { async process(label) {
        operations.push(`commercial:${label.shipmentId}`); return { outcome: "skipped", reason: "test" };
      } },
    });
    if (mode === "success") {
      await expect(service.processShipNotify("/shipments?batchId=test")).resolves.toBe(1);
      expect(operations).toEqual(["refresh", "observe:101", "commercial:101", "observe:102", "commercial:102"]);
    } else {
      await expect(service.processShipNotify("/shipments?batchId=test")).rejects.toThrow();
      expect(operations).not.toContain("observe:102"); expect(operations).not.toContain("commercial:102");
    }
  });
});
