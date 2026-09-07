import { describe, expect, it, vi } from "vitest";
import { normalizeShipStationLabelObservation } from "../../../shipping/carrier-tracking.domain";
import type { LockedPackageAllocationAuthorityEvidence } from "../../../shipping/package-allocation-ledger.repository";
import { buildAssemblyPackageReview } from "../../work/domain/assembly-package-review";
import { readObservedPackagesForSources } from "../../../shipping/package-allocation-ledger.repository";
import { readOrderPackingSources } from "../../../wms/packing-source-reader";
import type { PoolClient } from "pg";

const time = "2026-09-06T20:00:00.000Z";
function observed(items: { lineItemKey: string; quantity: number }[] = [{ lineItemKey: "wms-item-101", quantity: 2 }], isReturnLabel = false): LockedPackageAllocationAuthorityEvidence {
  const observation = normalizeShipStationLabelObservation({ shipmentId: 44001, trackingNumber: "TRACK1234", isReturnLabel, shipmentItems: items }, new Date(time));
  return { evidenceKey: "shipping-provider-label:601", persistedEvidence: {
    shippingProviderLabelId: 601, provider: observation.provider, providerPhysicalShipmentId: observation.providerLabelId,
    currentTrackingNumber: observation.trackingNumber, currentLabelStatus: observation.labelStatus,
    firstObservedAt: time, lastObservedAt: time, labelDirection: observation.labelDirection,
    labelEvents: [{ id: 1, shippingProviderLabelId: 601, eventHash: observation.eventHash,
      eventType: observation.eventType, labelStatus: observation.labelStatus, trackingNumber: observation.trackingNumber,
      providerOccurredAt: observation.providerOccurredAt, receivedAt: time, sanitizedPayload: observation.sanitizedPayload }],
    confirmedCarrierEvents: [],
  } };
}
function input() {
  return { taskId: "1", orderId: 70, warehouseId: 1,
    sources: [{ id: 101, orderItemId: 71, sku: "P5", quantity: 2, shipmentStatus: "queued" }],
    packages: [observed()] };
}
describe("assembly bench package evidence", () => {
  it("projects actual normalized provider evidence and does not claim close or complete discovery", () => {
    const result = buildAssemblyPackageReview(input());
    expect(result).toMatchObject({ readOnly: true, closesPackage: false, discoveryComplete: false,
      packages: [{ status: "observed_contents", items: [{ sourceShipmentItemId: 101, orderItemId: 71, sku: "P5", quantity: 2 }] }] });
    expect(result.packages[0].evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each(["foreign-source", "empty", "overage", "cancelled", "return", "unknown", "voided", "malformed"])("requires review for %s without partial contents", (kind) => {
    const data = input();
    if (kind === "foreign-source") data.packages = [observed([{ lineItemKey: "wms-item-101", quantity: 1 }, { lineItemKey: "wms-item-999", quantity: 1 }])];
    if (kind === "empty") data.packages = [observed([])];
    if (kind === "overage") data.sources[0].quantity = 1;
    if (kind === "cancelled") data.sources[0].shipmentStatus = "cancelled";
    if (kind === "return") data.packages = [observed(undefined, true)];
    if (kind === "unknown" || kind === "voided") data.packages = [{ ...data.packages[0], persistedEvidence: { ...data.packages[0].persistedEvidence, currentLabelStatus: kind } }];
    if (kind === "malformed") data.packages = [{ ...data.packages[0], persistedEvidence: { ...data.packages[0].persistedEvidence, labelEvents: [] } }];
    expect(buildAssemblyPackageReview(data).packages[0]).toMatchObject({ status: "review_required", items: [] });
  });
  it("preserves input and changes fingerprint when the persisted evidence changes", () => {
    const data = input(); const original = structuredClone(data);
    const first = buildAssemblyPackageReview(data);
    expect(data).toEqual(original);
    data.packages = [observed([{ lineItemKey: "wms-item-101", quantity: 1 }])];
    expect(buildAssemblyPackageReview(data).packages[0].evidenceHash).not.toBe(first.packages[0].evidenceHash);
  });
  it("returns no fabricated package when label data is absent", () => {
    expect(buildAssemblyPackageReview({ ...input(), packages: [] }).packages).toEqual([]);
  });
  it("rejects duplicate source identity", () => {
    const data = input(); data.sources.push({ ...data.sources[0] });
    expect(() => buildAssemblyPackageReview(data)).toThrow("Duplicate packing source");
  });
  it("does not query package discovery with no source selection or malformed IDs", async () => {
    const query = vi.fn();
    expect(await readObservedPackagesForSources({ query }, [])).toEqual([]);
    await expect(readObservedPackagesForSources({ query }, [0])).rejects.toThrow("Invalid packing source");
    await expect(readObservedPackagesForSources({ query }, Array(501).fill(1))).rejects.toThrow("Invalid packing source");
    expect(query).not.toHaveBeenCalled();
  });
  it("reads only exact order/warehouse sources, with a bounded parameterized SELECT", async () => {
    const query = vi.fn(async () => ({ rows: input().sources }));
    const client = { query } as unknown as PoolClient;
    expect(await readOrderPackingSources(client, 70, 1)).toEqual(input().sources);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("parent.warehouse_id=$2"), [70, 1]);
    expect(query.mock.calls[0][0]).not.toMatch(/FOR UPDATE|INSERT|DELETE/);
  });
});
