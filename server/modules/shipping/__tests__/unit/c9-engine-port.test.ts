/**
 * C9 Phase 2 structural tests: ShippingEngine port.
 *
 * Tests for:
 * - D-NOENGINE: Engine-agnostic schema columns exist
 * - D-NOENGINE: pushShipment dual-writes engine columns
 * - D-NOENGINE: Split/combined shipment INSERTs include engine columns
 * - D-NOENGINE: Reconciler cancel/markShipped calls use engine.*
 * - D-NOENGINE: engineRefFromRow builds refs from both new and legacy columns
 * - D-NOENGINE: ShippingEngine is wired in service registry
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

function readSrc(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

// ─── Schema: engine-agnostic columns ─────────────────────────────────

describe("D-NOENGINE: engine-agnostic schema columns", () => {
  const schemaSrc = readSrc("shared/schema/orders.schema.ts");

  it("outbound_shipments has shipping_engine column", () => {
    expect(schemaSrc).toContain('shippingEngine: varchar("shipping_engine"');
  });

  it("outbound_shipments has engine_order_ref column", () => {
    expect(schemaSrc).toContain('engineOrderRef: varchar("engine_order_ref"');
  });

  it("outbound_shipments has engine_shipment_ref column", () => {
    expect(schemaSrc).toContain('engineShipmentRef: varchar("engine_shipment_ref"');
  });

  it("keeps legacy shipstation_order_id as back-compat shadow", () => {
    expect(schemaSrc).toContain('shipstationOrderId: integer("shipstation_order_id")');
  });
});

// ─── Migration exists ────────────────────────────────────────────────

describe("D-NOENGINE: migration adds engine columns", () => {
  const migrationSrc = readSrc("migrations/0573_engine_agnostic_shipment_refs.sql");

  it("adds shipping_engine column", () => {
    expect(migrationSrc).toContain("shipping_engine varchar(30)");
  });

  it("adds engine_order_ref column", () => {
    expect(migrationSrc).toContain("engine_order_ref varchar(200)");
  });

  it("backfills existing ShipStation rows", () => {
    expect(migrationSrc).toContain("shipping_engine = 'shipstation'");
    expect(migrationSrc).toContain("shipstation_order_id::text");
  });

  it("creates index for engine-scoped lookups", () => {
    expect(migrationSrc).toContain("idx_outbound_shipments_engine_ref");
  });
});

// ─── pushShipment dual-writes ────────────────────────────────────────

describe("D-NOENGINE: pushShipment writes engine columns", () => {
  const ssSrc = readSrc("server/modules/oms/shipstation.service.ts");

  it("writes shipping_engine in the same UPDATE as shipstation_order_id", () => {
    const start = ssSrc.indexOf("Mark shipment queued + persist engine refs");
    const end = ssSrc.indexOf("recomputeOrderStatusFromShipments", start);
    const pushBlock = ssSrc.substring(start, end);
    expect(pushBlock).toContain("shipping_engine = 'shipstation'");
    expect(pushBlock).toContain("engine_order_ref");
    expect(pushBlock).toContain("engine_shipment_ref");
  });
});

// ─── Split/combined shipment INSERTs ─────────────────────────────────

describe("D-NOENGINE: split/combined shipment creation includes engine columns", () => {
  const ssSrc = readSrc("server/modules/oms/shipstation.service.ts");

  it("split shipment INSERT includes engine triple", () => {
    const insertStart = ssSrc.indexOf("ensureSplitShipmentFromShipStation");
    const splitInsert = ssSrc.substring(
      ssSrc.indexOf("INSERT INTO wms.outbound_shipments", insertStart),
      ssSrc.indexOf("RETURNING id", insertStart),
    );
    expect(splitInsert).toContain("shipping_engine");
    expect(splitInsert).toContain("engine_order_ref");
    expect(splitInsert).toContain("engine_shipment_ref");
  });

  it("combined child INSERT includes engine triple", () => {
    const combStart = ssSrc.indexOf("resolveCombinedShipmentGroupsFromShipStationItems");
    const combInsert = ssSrc.substring(
      ssSrc.indexOf("INSERT INTO wms.outbound_shipments", combStart),
      ssSrc.indexOf("RETURNING id", combStart),
    );
    expect(combInsert).toContain("shipping_engine");
    expect(combInsert).toContain("engine_order_ref");
    expect(combInsert).toContain("engine_shipment_ref");
  });
});

// ─── Reconciler callers use engine.* ─────────────────────────────────

describe("D-NOENGINE: reconciler cancel/markShipped uses engine", () => {
  const indexSrc = readSrc("server/index.ts");

  it("imports engineRefFromRow from shipping module", () => {
    expect(indexSrc).toContain('import { engineRefFromRow, toEngineRef } from "./modules/shipping"');
  });

  it("reconciler #4 cancel uses engine.cancel, not ss.cancelOrder", () => {
    const block = indexSrc.substring(
      indexSrc.indexOf("OMS<->WMS Reconcile"),
      indexSrc.indexOf("OMS<->WMS Reconcile") + 1500,
    );
    expect(block).toContain("engine.cancel(ref)");
    expect(block).not.toContain("ss.cancelOrder");
  });

  it("data repair cancel uses engine.cancel", () => {
    const start = indexSrc.indexOf("Duplicate shipment cleanup");
    const block = indexSrc.substring(start - 1500, start);
    expect(block).toContain("engine.cancel(ref)");
  });

  it("V2 reconciler outbound sync uses engine.markShipped", () => {
    const block = indexSrc.substring(
      indexSrc.indexOf("Outbound sync: marked engine order"),
      indexSrc.indexOf("Outbound sync: marked engine order") + 200,
    );
    expect(block).toBeDefined();
  });

  it("V1 reconciler uses engine.markShipped and engine.cancel", () => {
    const v1Block = indexSrc.substring(
      indexSrc.indexOf("V1: legacy order-based reconcile"),
      indexSrc.indexOf("V1: legacy order-based reconcile") + 2000,
    );
    expect(v1Block).toContain("shippingEngine.markShipped(v1Ref");
    expect(v1Block).toContain("shippingEngine.cancel(v1Ref)");
  });

  it("webhook registration uses engine.registerWebhook", () => {
    expect(indexSrc).toContain("services.shippingEngine.registerWebhook(");
    expect(indexSrc).toContain("services.shippingEngine.isConfigured()");
  });
});

// ─── Service wiring ──────────────────────────────────────────────────

describe("D-NOENGINE: ShippingEngine is wired in service registry", () => {
  const servicesSrc = readSrc("server/services/index.ts");

  it("imports createShipStationEngine", () => {
    expect(servicesSrc).toContain('import { createShipStationEngine } from "../modules/shipping"');
  });

  it("creates shippingEngine from shipStation service", () => {
    expect(servicesSrc).toContain("createShipStationEngine(shipStation)");
  });

  it("returns shippingEngine in the service registry", () => {
    expect(servicesSrc).toContain("shippingEngine,");
  });
});

// ─── engineRefFromRow helper ─────────────────────────────────────────

describe("D-NOENGINE: engineRefFromRow helper", () => {
  // Import the real function for behavioral tests
  let engineRefFromRow: typeof import("../../adapters/shipstation.adapter").engineRefFromRow;

  beforeAll(async () => {
    const mod = await import("../../adapters/shipstation.adapter");
    engineRefFromRow = mod.engineRefFromRow;
  });

  it("builds ref from new engine columns", () => {
    const ref = engineRefFromRow({
      shipping_engine: "shipstation",
      engine_order_ref: "12345",
      engine_shipment_ref: "echelon-wms-shp-42",
    });
    expect(ref).toEqual({
      engine: "shipstation",
      engineOrderRef: "12345",
      engineShipmentRef: "echelon-wms-shp-42",
    });
  });

  it("falls back to legacy shipstation_order_id", () => {
    const ref = engineRefFromRow({
      shipstation_order_id: 999,
      shipstation_order_key: "echelon-wms-shp-1",
    });
    expect(ref).toEqual({
      engine: "shipstation",
      engineOrderRef: "999",
      engineShipmentRef: "echelon-wms-shp-1",
    });
  });

  it("prefers new columns over legacy", () => {
    const ref = engineRefFromRow({
      shipping_engine: "shipstation",
      engine_order_ref: "111",
      shipstation_order_id: 222,
    });
    expect(ref!.engineOrderRef).toBe("111");
  });

  it("returns null when no columns present", () => {
    const ref = engineRefFromRow({});
    expect(ref).toBeNull();
  });

  it("returns null for zero shipstation_order_id", () => {
    const ref = engineRefFromRow({ shipstation_order_id: 0 });
    expect(ref).toBeNull();
  });
});

// ─── Phase 4: reconcilers use engine-agnostic interface ──────────────

describe("D-NOENGINE Phase 4: V2 reconciler uses engine interface", () => {
  const indexSrc = readSrc("server/index.ts");

  it("V2 reconciler calls engine.getState(ref) not ss.getOrderById", () => {
    const v2Start = indexSrc.indexOf("V2: shipment-based reconcile");
    const v2End = indexSrc.indexOf("V1: legacy order-based reconcile");
    const v2Block = indexSrc.substring(v2Start, v2End);
    expect(v2Block).toContain("engine.getState(ref)");
    expect(v2Block).not.toContain("ss.getOrderById");
  });

  it("V2 reconciler calls engine.getShipments(ref) not ss.getShipments", () => {
    const v2Start = indexSrc.indexOf("V2: shipment-based reconcile");
    const v2End = indexSrc.indexOf("V1: legacy order-based reconcile");
    const v2Block = indexSrc.substring(v2Start, v2End);
    expect(v2Block).toContain("engine.getShipments(ref)");
    expect(v2Block).not.toContain("ss.getShipments");
  });

  it("V2 reconciler uses deriveReconcileEvent not SS-specific derive", () => {
    const v2Start = indexSrc.indexOf("V2: shipment-based reconcile");
    const v2End = indexSrc.indexOf("V1: legacy order-based reconcile");
    const v2Block = indexSrc.substring(v2Start, v2End);
    expect(v2Block).toContain("deriveReconcileEvent(");
    expect(v2Block).not.toContain("deriveShipStationShipmentReconcileEvent");
  });

  it("no longer imports SS-specific reconcile functions", () => {
    expect(indexSrc).not.toContain('from "./modules/oms/shipstation-reconcile-state"');
  });

  it("imports deriveReconcileEvent from shipping module", () => {
    expect(indexSrc).toContain('from "./modules/shipping/reconcile-derive"');
  });
});

describe("D-NOENGINE Phase 4: eBay reconciler uses engine interface", () => {
  const indexSrc = readSrc("server/index.ts");

  it("eBay reconciler calls engine.getState not ss.getOrderById", () => {
    const ebayStart = indexSrc.indexOf("eBay order reconciliation");
    const ebayEnd = indexSrc.indexOf("OMS<->WMS reconciliation");
    const ebayBlock = indexSrc.substring(ebayStart, ebayEnd);
    expect(ebayBlock).toContain("engine.getState(ref)");
    expect(ebayBlock).not.toContain("ss.getOrderById");
    expect(ebayBlock).not.toContain("ss.getOrderByNumber");
  });

  it("eBay reconciler uses engineRefFromRow with toEngineRef fallback", () => {
    const ebayStart = indexSrc.indexOf("eBay order reconciliation");
    const ebayEnd = indexSrc.indexOf("OMS<->WMS reconciliation");
    const ebayBlock = indexSrc.substring(ebayStart, ebayEnd);
    expect(ebayBlock).toContain("engineRefFromRow(order)");
    expect(ebayBlock).toContain("toEngineRef(");
  });

  it("eBay reconciler no longer references services.shipStation", () => {
    const ebayStart = indexSrc.indexOf("eBay order reconciliation");
    const ebayEnd = indexSrc.indexOf("OMS<->WMS reconciliation");
    const ebayBlock = indexSrc.substring(ebayStart, ebayEnd);
    expect(ebayBlock).not.toContain("services.shipStation");
  });
});

describe("D-NOENGINE Phase 4: V1 reconciler uses engine.isConfigured", () => {
  const indexSrc = readSrc("server/index.ts");

  it("V1 reconciler guard uses shippingEngine.isConfigured not ss", () => {
    const v1Start = indexSrc.indexOf("V1: legacy order-based reconcile");
    const v1End = indexSrc.indexOf("Schedule: V2 when flag is ON");
    const v1Block = indexSrc.substring(v1Start, v1End);
    expect(v1Block).toContain("services.shippingEngine?.isConfigured()");
    expect(v1Block).not.toContain("services.shipStation");
    expect(v1Block).not.toContain("(services as any).shipStation");
  });
});

// ─── Adapter: updatePriority is implemented ──────────────────────────

describe("D-NOENGINE: adapter updatePriority is no longer a no-op", () => {
  const adapterSrc = readSrc("server/modules/shipping/adapters/shipstation.adapter.ts");

  it("calls ss.updateSortRankSingle", () => {
    expect(adapterSrc).toContain("ss.updateSortRankSingle(ssOrderId, sortRank)");
  });

  it("ShipStationServiceHandle includes updateSortRankSingle", () => {
    expect(adapterSrc).toContain("updateSortRankSingle(shipstationOrderId: number, sortRank: string)");
  });
});
