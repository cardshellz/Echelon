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

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");

function readSrc(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

function readShipStationSrc(): string {
  const subDir = resolve(ROOT, "server/modules/oms/shipstation");
  const subFiles = existsSync(subDir)
    ? readdirSync(subDir)
        .filter((f) => f.endsWith(".ts"))
        .sort()
        .map((f) => readFileSync(resolve(subDir, f), "utf8"))
    : [];
  return [readSrc("server/modules/oms/shipstation.service.ts"), ...subFiles].join("\n");
}

function sourceBetween(source: string, startMarker: string, endMarker: string): string {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0);
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start);
  return source.slice(start, end);
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
  const ssSrc = readShipStationSrc();
  const wmsShipmentsRepoSrc = readSrc("server/modules/wms/outbound-shipments-mutations.repository.ts");

  it("writes shipping_engine in the same UPDATE as shipstation_order_id", () => {
    const start = ssSrc.indexOf("Mark shipment queued + persist engine refs");
    const end = ssSrc.indexOf("recomputeOrderStatusFromShipments", start);
    const pushBlock = ssSrc.substring(start, end);
    expect(pushBlock).toContain("markOutboundShipmentQueuedAfterShipStationPushInWms(");

    const repoFn = sourceBetween(
      wmsShipmentsRepoSrc,
      "export async function markOutboundShipmentQueuedAfterShipStationPushInWms(",
      "WHERE id = ${input.shipmentId}",
    );
    expect(repoFn).toContain("shipping_engine = 'shipstation'");
    expect(repoFn).toContain("engine_order_ref");
    expect(repoFn).toContain("engine_shipment_ref");
  });
});

// ─── Split/combined shipment INSERTs ─────────────────────────────────

describe("D-NOENGINE: split/combined shipment creation includes engine columns", () => {
  const ssSrc = readShipStationSrc();
  const wmsShipmentsRepoSrc = readSrc("server/modules/wms/outbound-shipments-mutations.repository.ts");

  it("split shipment INSERT includes engine triple", () => {
    const insertStart = ssSrc.indexOf("ensureSplitShipmentFromShipStation");
    const splitBlock = ssSrc.substring(
      insertStart,
      ssSrc.indexOf("Failed to create WMS split shipment", insertStart),
    );
    expect(splitBlock).toContain("insertShipStationChildOutboundShipmentInWms(");

    const repoInsert = sourceBetween(
      wmsShipmentsRepoSrc,
      "export async function insertShipStationChildOutboundShipmentInWms(",
      "RETURNING id, order_id, status, shipstation_order_id",
    );
    expect(repoInsert).toContain("shipping_engine");
    expect(repoInsert).toContain("engine_order_ref");
    expect(repoInsert).toContain("engine_shipment_ref");
  });

  it("combined child INSERT includes engine triple", () => {
    const combStart = ssSrc.indexOf("resolveCombinedShipmentGroupsFromShipStationItems");
    const combBlock = ssSrc.substring(
      combStart,
      ssSrc.indexOf("applying shared tracking to each order shipment", combStart),
    );
    expect(combBlock).toContain("insertShipStationChildOutboundShipmentInWms(");
  });
});

// ─── Reconciler callers use engine.* ─────────────────────────────────

describe("D-NOENGINE: reconciler cancel/markShipped uses engine", () => {
  const indexSrc = readSrc("server/index.ts");
  const omsWmsReconcileSrc = readSrc("server/modules/orders/oms-wms-cancel-reconcile.scheduler.ts");
  const oneShotRepairsSrc = readSrc("server/modules/orders/one-shot-repairs.ts");
  const wmsShipStationReconcileSrc = readSrc("server/modules/shipping/wms-shipstation-reconcile.scheduler.ts");

  it("imports engineRefFromRow from shipping module in extracted reconcilers", () => {
    expect(omsWmsReconcileSrc).toContain("engineRefFromRow");
    expect(omsWmsReconcileSrc).toContain('from "../shipping/engine-and-reconcile.api"');
    expect(wmsShipStationReconcileSrc).toContain('import { engineRefFromRow } from "./adapters/shipstation.adapter"');
  });

  it("reconciler #4 cancel uses engine.cancel, not ss.cancelOrder", () => {
    expect(omsWmsReconcileSrc).toContain("engine.cancel(ref)");
    expect(omsWmsReconcileSrc).not.toContain("ss.cancelOrder");
  });

  it("data repair cancel uses engine.cancel", () => {
    expect(oneShotRepairsSrc).toContain("engine.cancel(ref)");
  });

  it("V2 reconciler outbound sync uses engine.markShipped", () => {
    const block = wmsShipStationReconcileSrc.substring(
      wmsShipStationReconcileSrc.indexOf("Outbound sync: marked engine order"),
      wmsShipStationReconcileSrc.indexOf("Outbound sync: marked engine order") + 200,
    );
    expect(block).toBeDefined();
    expect(wmsShipStationReconcileSrc).toContain("await engine.markShipped(ref, {");
  });

  it("retires the legacy order-level reconciliation fallback", () => {
    expect(indexSrc).toContain("startWmsShipStationReconcileScheduler(");
    expect(indexSrc).not.toContain("runShipStationReconcileV1");
    expect(indexSrc).not.toContain("process.env.RECONCILE_V2");
    expect(wmsShipStationReconcileSrc).not.toContain("runShipStationReconcileV1");
    expect(wmsShipStationReconcileSrc).not.toContain("process.env.RECONCILE_V2");
    expect(wmsShipStationReconcileSrc).toContain("await runShipStationReconcileV2()");
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
  const wmsReconcileSrc = readSrc("server/modules/shipping/wms-shipstation-reconcile.scheduler.ts");
  const v2Block = sourceBetween(
    wmsReconcileSrc,
    "const runShipStationReconcileV2 = async () => {",
    "const runShipStationReconcile = async () => {",
  );

  it("V2 reconciler calls engine.getState(ref) not ss.getOrderById", () => {
    expect(v2Block).toContain("engine.getState(ref)");
    expect(v2Block).not.toContain("ss.getOrderById");
  });

  it("V2 reconciler calls engine.getShipments with stable order identity, not ss.getShipments", () => {
    const shipmentsPos = v2Block.indexOf("engine.getShipments(");
    const missingOrderPos = v2Block.indexOf("if (!engineState)");

    expect(v2Block).toContain("engine.getShipments(");
    expect(v2Block).toContain("orderNumber ? { orderNumber }");
    expect(v2Block).not.toContain("ss.getShipments");
    expect(shipmentsPos).toBeLessThan(missingOrderPos);
  });

  it("V2 reconciler uses deriveReconcileEvent not SS-specific derive", () => {
    expect(v2Block).toContain("deriveReconcileEvent(");
    expect(v2Block).not.toContain("deriveShipStationShipmentReconcileEvent");
  });

  it("V2 reconciler routes inbound package facts through engine authority before direct dispatch", () => {
    const authorityPos = v2Block.indexOf(
      "engine.applyInboundShipmentAuthority",
    );
    const dispatchPos = v2Block.indexOf("dispatchShipmentEvent(");

    expect(authorityPos).toBeGreaterThan(-1);
    expect(dispatchPos).toBeGreaterThan(authorityPos);
    expect(v2Block).toContain(
      'event.kind === "shipped" || event.kind === "voided"',
    );
    expect(v2Block).toContain("String(row.order_number");
  });

  it("V2 reconciler never auto-applies shipments already flagged for review", () => {
    expect(v2Block).toContain(
      "COALESCE(os.requires_review, false) = false",
    );
  });

  it("V2 reconciler gates engine-cancel on order intent and flags live orders for review", () => {
    // Cancel is WMS-owned: the reconciler tells deriveReconcileEvent whether the
    // ORDER itself is cancelled (ENGINE-CANCEL-DIVERGENCE-DESIGN.md).
    expect(v2Block).toContain("orderIsCancelled");
    // An engine-side cancel of a LIVE order is flagged for review, never applied.
    expect(v2Block).toContain('event.kind === "review"');
    expect(v2Block).toContain("flagOutboundShipmentReconcileReviewIfUnsetInWms(");
    const wmsShipmentsRepoSrc = readSrc("server/modules/wms/outbound-shipments-mutations.repository.ts");
    expect(wmsShipmentsRepoSrc).toContain("requires_review = true");
    expect(v2Block).toContain("engine_cancel_flagged_for_review");
  });

  it("no longer imports SS-specific reconcile functions", () => {
    expect(indexSrc).not.toContain('from "./modules/oms/shipstation-reconcile-state"');
    expect(wmsReconcileSrc).not.toContain("shipstation-reconcile-state");
  });

  it("imports deriveReconcileEvent inside shipping module reconciler", () => {
    expect(wmsReconcileSrc).toContain('import { deriveReconcileEvent } from "./reconcile-derive"');
    expect(indexSrc).toContain('from "./modules/shipping/engine-and-reconcile.api"');
  });
});

describe("D-NOENGINE Phase 4: eBay reconciler uses engine interface", () => {
  const ebayBlock = readSrc(
    "server/modules/oms/reconcilers/ebay-fulfillment-stuck-order.scheduler.ts",
  );

  it("eBay reconciler calls engine.getState not ss.getOrderById", () => {
    expect(ebayBlock).toContain("engine.getState(ref)");
    expect(ebayBlock).not.toContain("ss.getOrderById");
    expect(ebayBlock).not.toContain("ss.getOrderByNumber");
  });

  it("eBay reconciler uses engineRefFromRow with toEngineRef fallback", () => {
    expect(ebayBlock).toContain("engineRefFromRow(order)");
    expect(ebayBlock).toContain("toEngineRef(");
  });

  it("eBay reconciler no longer references services.shipStation", () => {
    expect(ebayBlock).not.toContain("services.shipStation");
  });
});

describe("D-NOENGINE Phase 4: legacy V1 reconciler is retired", () => {
  const indexSrc = readSrc("server/index.ts");
  const wmsReconcileSrc = readSrc("server/modules/shipping/wms-shipstation-reconcile.scheduler.ts");

  it("always invokes the canonical V2 reconciler without a feature flag fallback", () => {
    const schedulerBlock = wmsReconcileSrc.slice(
      wmsReconcileSrc.indexOf("const runShipStationReconcile = async () => {"),
    );
    expect(schedulerBlock).toContain("await runShipStationReconcileV2()");
    expect(schedulerBlock).toContain('name: "shipping.wms_reconcile"');
    expect(schedulerBlock).toContain("registerScheduledJob({");
    expect(schedulerBlock).not.toContain("runShipStationReconcileV1");
    expect(wmsReconcileSrc).not.toContain("RECONCILE_V2");
    expect(indexSrc).not.toContain("RECONCILE_V2");
    expect(indexSrc).not.toContain("V1: legacy order-based reconcile");
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
