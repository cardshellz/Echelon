import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { readShipmentProvisionalLotCounts } from "../../shipment-health-evidence.repository";

function fixture(rows: Record<string, unknown>[] = []) {
  const execute = vi.fn().mockResolvedValue({ rows });
  return { execute, tx: { execute } as unknown as Parameters<typeof readShipmentProvisionalLotCounts>[0] };
}
describe("complete provisional-lot counts", () => {
  it("counts a large complete child set without transferring its rows and scopes traced identities per shipment", async () => {
    const { tx, execute } = fixture([{ shipment_id: 2, provisional_count: "100001", untraced_count: "99999" }]);
    const scopes = [{ shipmentId: 1, tracedLotIds: [7, 7] }, { shipmentId: 2, tracedLotIds: [7, 8] }];
    const before = structuredClone(scopes);
    const result = await readShipmentProvisionalLotCounts(tx, scopes);
    expect(result.get(1)).toEqual({ provisionalLotCount: 0, untracedProvisionalLotCount: 0 });
    expect(result.get(2)).toEqual({ provisionalLotCount: 100001, untracedProvisionalLotCount: 99999 });
    expect(scopes).toEqual(before);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toHaveLength(2);
    expect(JSON.parse(query.params[0] as string)).toEqual([{ shipment_id: 1, lot_ids: [7] }, { shipment_id: 2, lot_ids: [7, 8] }]);
    expect(query.params[1]).toEqual([1, 2]);
    expect(query.sql).toContain("traced.shipment_id=lot.inbound_shipment_id");
    expect(query.sql).not.toMatch(/LIMIT|SELECT lot\.\*/i);
  });
  it.each([
    { shipment_id: 9, provisional_count: "1", untraced_count: "0" },
    { shipment_id: 1, provisional_count: "-1", untraced_count: "0" },
    { shipment_id: 1, provisional_count: "1.5", untraced_count: "0" },
    { shipment_id: 1, provisional_count: "9007199254740992", untraced_count: "0" },
    { shipment_id: 1, provisional_count: "1", untraced_count: "2" },
    { shipment_id: 1, provisional_count: null, untraced_count: "0" },
  ])("fails closed for malformed or foreign aggregate evidence %j", async row => {
    const { tx } = fixture([row]);
    await expect(readShipmentProvisionalLotCounts(tx, [{ shipmentId: 1, tracedLotIds: [] }])).rejects.toMatchObject({ code: "SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE" });
  });
  it("rejects duplicate aggregate identities", async () => {
    const row = { shipment_id: 1, provisional_count: "1", untraced_count: "0" };
    await expect(readShipmentProvisionalLotCounts(fixture([row, row]).tx, [{ shipmentId: 1, tracedLotIds: [] }])).rejects.toThrow();
  });
  it.each([[{ shipmentId: 0, tracedLotIds: [] }], [{ shipmentId: 1, tracedLotIds: [0] }],
    [{ shipmentId: 1, tracedLotIds: [] }, { shipmentId: 1, tracedLotIds: [] }]])("validates complete scope before querying", async scopes => {
    const { tx, execute } = fixture();
    await expect(readShipmentProvisionalLotCounts(tx, scopes)).rejects.toThrow(); expect(execute).not.toHaveBeenCalled();
  });
  it("does not query an empty page and propagates database failure", async () => {
    const { tx, execute } = fixture(); expect(await readShipmentProvisionalLotCounts(tx, [])).toEqual(new Map());
    expect(execute).not.toHaveBeenCalled(); execute.mockRejectedValueOnce(new Error("Database unavailable"));
    await expect(readShipmentProvisionalLotCounts(tx, [{ shipmentId: 1, tracedLotIds: [] }])).rejects.toThrow("Database unavailable");
  });
});
