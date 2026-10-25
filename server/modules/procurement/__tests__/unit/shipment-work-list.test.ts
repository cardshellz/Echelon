import { beforeEach, describe, expect, it, vi } from "vitest";
import { shipmentWorkListQuerySchema, shipmentWorkListPageSchema, matchesShipmentCostFilter, type ShipmentWorkListItem } from "@shared/procurement/shipment-work-list";
import { createShipmentTrackingService } from "../../shipment-tracking.service";
import { readShipmentCostReviewInTransaction } from "../../shipment-cost-review.repository";
import { readShipmentHealthEvidence } from "../../shipment-health-evidence.repository";
vi.mock("../../shipment-health-evidence.repository", () => ({ readShipmentHealthEvidence: vi.fn() }));
vi.mock("../../shipment-cost-review.repository", () => ({ readShipmentCostReview: vi.fn(), readShipmentCostReviewInTransaction: vi.fn() }));

const item = (id: number, status = "draft"): ShipmentWorkListItem => ({ id, shipmentNumber: `SHP-${id}`, status,
  mode: "sea_fcl", carrierName: null, forwarderName: null, containerNumber: null, originPort: null,
  destinationPort: null, originCountry: null, destinationCountry: null, warehouseId: null, eta: null,
  estimatedTotalCostCents: null, actualTotalCostCents: null, notes: null, createdAt: "2026-10-18T00:00:00Z", purchaseOrders: [] });
function fixture(rows = Array.from({ length: 102 }, (_, index) => item(102 - index, "closed"))) {
  const tx = {};
  const db = { transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)) };
  const storage = {
    getInboundShipments: vi.fn(async (filters: { offset?: number; limit?: number }) => rows.slice(filters.offset ?? 0, (filters.offset ?? 0) + (filters.limit ?? rows.length))),
    getInboundShipmentsCount: vi.fn(async () => rows.length),
    getInboundShipmentPurchaseOrders: vi.fn(async () => new Map()),
    getInboundShipmentById: vi.fn(async (id: number) => rows.find(row => row.id === id)),
    getInboundShipmentLines: vi.fn(async (id: number) => [{ id: id * 10, qtyShipped: 1 }]),
    getInboundFreightCosts: vi.fn(async () => []), getProvisionalLotsByShipment: vi.fn(async () => []),
    getLandedCostSnapshots: vi.fn(async () => []),
  };
  return { service: createShipmentTrackingService(db as never, storage as never), db, tx, storage };
}
beforeEach(() => {
  vi.mocked(readShipmentHealthEvidence).mockReset().mockImplementation(async (_tx, ids) => new Map(ids.map(id => [id, {
    lines: [{ id: id * 10, qtyShipped: 1 }] as never, costs: [], provisionalLots: [],
    allocationsByCostId: new Map(), snapshotsByLineId: new Map(), purchaseLinesById: new Map(), purchaseOrdersById: new Map(),
  }])));
  vi.mocked(readShipmentCostReviewInTransaction).mockReset().mockImplementation(async (_tx, id) => ({ shipmentId: id,
    lines: [{ lineId: id * 10, sku: null, sourceIssue: id <= 2 ? { code: "COST_SOURCE_CHANGED", message: "Changed source." } : null,
      application: { id, recordedAt: "2026-10-18T00:00:00Z", status: "applied", lotsUpdated: 1, cogsRowsUpdated: 0, issues: [] } }] }));
});
describe("shipment work-list input and output contracts", () => {
  it("normalizes valid query strings and preserves the existing not-cancelled active meaning", () => {
    expect(shipmentWorkListQuerySchema.parse({status:"active",limit:"50",offset:"100",search:" carrier "})).toEqual({
      status:"active",limit:50,offset:100,search:"carrier",costFilter:"all" });
    expect(shipmentWorkListQuerySchema.parse({status:"closed,costing"}).status).toEqual(["closed","costing"]);
  });
  it.each([{limit:"0"},{limit:"251"},{offset:"-1"},{offset:"1.2"},{limit:""},{limit:true},{status:"unknown"},{mode:["air"]},{costFilter:"posted"},{search:["x"]},{warehouseId:"0"}])("rejects invalid filters %j", query => {
    expect(shipmentWorkListQuerySchema.safeParse(query).success).toBe(false);
  });
  it.each([{total:2,hasMore:false},{total:0,hasMore:false},{shipments:[item(1),item(1)]},{costHealthItems:[{id:"x",type:"posting_review_required",severity:"critical",shipmentId:2,shipmentNumber:"SHP-2",shipmentStatus:"closed",detail:"Review",action:"review_cost_evidence"}]}])("rejects contradictory page evidence %j", change => {
    expect(shipmentWorkListPageSchema.safeParse({shipments:[item(1)],total:1,limit:50,offset:0,hasMore:false,costHealthItems:[],...change}).success).toBe(false);
  });
  it("does not interpret an unresolved posting issue as healthy", () => {
    const issue = {id:"x",type:"posting_review_required",severity:"critical" as const,shipmentId:1,shipmentNumber:"SHP-1",shipmentStatus:"closed",detail:"Review",action:"review_cost_evidence"};
    expect(matchesShipmentCostFilter([issue],"any")).toBe(true);
    expect(matchesShipmentCostFilter([issue],"critical")).toBe(true);
    expect(matchesShipmentCostFilter([issue],"ready_to_push")).toBe(false);
  });
});
describe("shipment complete work-list projection", () => {
  it("uses the same snapshot for count, selected rows, relationships and current cost evidence", async () => {
    const {service,storage,db,tx} = fixture(Array.from({length:102},(_,index)=>item(index+1)));
    const page = await service.getShipmentPage({search:"carrier",status:"active",limit:50,offset:100});
    expect(page).toMatchObject({total:102,limit:50,offset:100,hasMore:false});
    expect(page.shipments.map(row=>row.id)).toEqual([101,102]);
    expect(storage.getInboundShipmentsCount).toHaveBeenCalledWith({search:"carrier",status:"active",limit:50,offset:100},tx);
    expect(storage.getInboundShipments).toHaveBeenCalledWith({search:"carrier",status:"active",limit:50,offset:100},tx);
    expect(storage.getInboundShipmentPurchaseOrders).toHaveBeenCalledWith([101,102],tx);
    expect(db.transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:"repeatable read",accessMode:"read only"});
  });
  it("finds unresolved costs beyond the first 100 before paging and keeps exact continuation", async () => {
    const {service,storage} = fixture();
    const first = await service.getShipmentPage({costFilter:"critical",limit:1});
    expect(first).toMatchObject({total:2,hasMore:true,offset:0});
    expect(first.shipments.map(row=>row.id)).toEqual([2]);
    expect(first.costHealthItems.map(row=>row.shipmentId)).toEqual([2]);
    const second = await service.getShipmentPage({costFilter:"critical",limit:1,offset:1});
    expect(second).toMatchObject({total:2,hasMore:false,offset:1});
    expect(second.shipments.map(row=>row.id)).toEqual([1]);
    expect(storage.getInboundShipments.mock.calls.every(([query])=>query.limit===100)).toBe(true);
    expect(storage.getInboundShipmentsCount).not.toHaveBeenCalled();
  });
  it("scans every health candidate while limiting only displayed issues", async () => {
    const {service} = fixture();
    const health = await service.getLandedCostHealth({limit:1});
    expect(health).toMatchObject({scannedShipments:102,critical:2,status:"critical",counts:{postingReviewRequired:2}});
    expect(health.items.map(row=>row.shipmentId)).toEqual([2]);
  });
  it("fails instead of returning an incomplete healthy cost-filter page", async () => {
    const {service} = fixture();
    vi.mocked(readShipmentCostReviewInTransaction).mockImplementation(async (_tx,id)=>{
      if(id===1) throw new Error("unavailable evidence after first page");
      return {shipmentId:id,lines:[{lineId:id*10,sku:null,sourceIssue:null,application:null}]};
    });
    await expect(service.getShipmentPage({costFilter:"critical"})).rejects.toThrow("unavailable evidence after first page");
    await expect(service.getLandedCostHealth()).rejects.toThrow("unavailable evidence after first page");
  });
  it("validates before opening a read transaction", async () => {
    const {service,db} = fixture();
    await expect(service.getShipmentPage({offset:"NaN"})).rejects.toThrow();
    expect(db.transaction).not.toHaveBeenCalled();
  });
  it("bounds raw evidence to 100 headers even when the requested page contains 250 shipments", async () => {
    const { service, tx } = fixture(Array.from({ length: 250 }, (_, index) => item(index + 1, "closed")));
    const page = await service.getShipmentPage({ limit: 250 });
    expect(page.shipments).toHaveLength(250);
    expect(vi.mocked(readShipmentHealthEvidence).mock.calls.map(call => call[1].length)).toEqual([100, 100, 50]);
    expect(vi.mocked(readShipmentHealthEvidence).mock.calls.every(call => call[0] === tx)).toBe(true);
  });
  it("fails closed when the batch reader omits a selected shipment", async () => {
    const { service } = fixture();
    vi.mocked(readShipmentHealthEvidence).mockResolvedValue(new Map());
    await expect(service.getShipmentPage({ limit: 50 })).rejects.toMatchObject({ statusCode: 503,
      details: { code: "SHIPMENT_COST_HEALTH_EVIDENCE_INCOMPLETE" } });
  });
});
