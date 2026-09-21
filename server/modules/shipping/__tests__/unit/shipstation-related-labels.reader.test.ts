import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createShipStationRelatedLabelReader } from "../../shipstation-related-labels.reader";

const selection = { providerLabelId: "102", providerOrderId: "201", sourceWmsShipmentItemIds: [301] };
const identity = { providerLabelId: "101", providerOrderId: "201", trackingNumber: "TRACK101" };
function fixture() {
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ shipping_provider_label_id: "7" }] })
    .mockResolvedValueOnce({ rows: [identity] });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });
  const reader = createShipStationRelatedLabelReader({ connect } as unknown as Pick<Pool, "connect">);
  return { reader, query, release, connect };
}

describe("shipping-owned related label reader", () => {
  it("uses exact identities and releases its connection before returning candidates", async () => {
    const f = fixture();
    await expect(f.reader.findRelatedActiveLabels(selection)).resolves.toEqual([identity]);
    expect(f.query.mock.calls[0][1]).toEqual([[301], 201]);
    expect(f.query.mock.calls[1][1]).toEqual(["102", ["7"], "201", 51]);
    expect(f.release).toHaveBeenCalledOnce();
  });
  it("rejects invalid source IDs before acquiring a connection", async () => {
    const f = fixture();
    await expect(f.reader.findRelatedActiveLabels({ ...selection, sourceWmsShipmentItemIds: [1.5] })).rejects.toThrow();
    expect(f.connect).not.toHaveBeenCalled();
  });
  it("does not query when no provider-order or source relationship can be selected", async () => {
    const f = fixture();
    await expect(f.reader.findRelatedActiveLabels({ ...selection, providerOrderId: null, sourceWmsShipmentItemIds: [] })).resolves.toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
  });
  it.each(["database", "invalid_identity", "discovery_limit", "candidate_limit"])("releases connections and propagates %s failures", async mode => {
    const f = fixture(); f.query.mockReset();
    if (mode === "database") f.query.mockRejectedValue(new Error("Database unavailable"));
    else if (mode === "discovery_limit") f.query.mockResolvedValue({ rows: Array.from({ length: 201 }, (_, id) => ({ shipping_provider_label_id: String(id + 1) })) });
    else {
      f.query.mockResolvedValueOnce({ rows: [{ shipping_provider_label_id: "7" }] })
        .mockResolvedValueOnce({ rows: mode === "candidate_limit" ? Array.from({ length: 51 }, () => identity) : [{ ...identity, providerLabelId: "invalid" }] });
    }
    await expect(f.reader.findRelatedActiveLabels(selection)).rejects.toThrow();
    expect(f.release).toHaveBeenCalledOnce();
  });
});
