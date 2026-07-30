import fs from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createHistoricalShipStationSplitRepairRepository } from "../../historical-shipstation-split-repair.repository";
import type {
  HistoricalSplitRepairFlags,
  HistoricalSplitRepairPackagePlan,
} from "../../historical-shipstation-split-repair.service";

const source = fs.readFileSync(
  path.resolve(process.cwd(), "server/modules/oms/historical-shipstation-split-repair.repository.ts"),
  "utf8",
);

function packagePlan(): HistoricalSplitRepairPackagePlan {
  return {
    providerPackage: {
      providerShipmentId: 442730042,
      providerOrderId: 755802673,
      providerOrderKey: "echelon-wms-shp-4842",
      orderNumber: "#59564",
      trackingNumber: "9400150106151288520521",
      carrierCode: "stamps_com",
      serviceCode: "usps_ground_advantage",
      shippedAt: new Date("2026-06-28T14:10:00.000Z"),
      items: [{ sourceShipmentItemId: 9001, quantity: 1 }],
    },
    retryIds: [115755],
  };
}

function sourceRow() {
  return {
    id: 9001,
    shipment_id: 7001,
    order_id: 8001,
    channel_id: 36,
    shipment_status: "shipped",
    shipment_source: "shipstation_split",
    external_fulfillment_id: "shipstation_shipment:111",
    tracking_number: "old-tracking",
    carrier: "stamps_com",
    order_item_id: 3001,
    replacement_for_order_item_id: null,
    shipment_item_purpose: "customer_fulfillment",
    product_variant_id: 4001,
    qty: 1,
    from_location_id: 5001,
    box_id: null,
    weight_oz: null,
    provider_membership_state: "authoritative",
    canonical_physical_shipment_id: 6001,
  };
}

describe("historical ShipStation split repair repository guards", () => {
  it("selects only the proven historical uniqueness-failure cohort", () => {
    expect(source).toContain("retry.provider = 'shipstation'");
    expect(source).toContain("retry.topic = 'SHIP_NOTIFY'");
    expect(source).toContain("retry.status = 'dead'");
    expect(source).toContain("uq_outbound_shipments_active_");
  });

  it("supports an explicit provider shipment resume cursor", () => {
    expect(source).toContain("flags.afterProviderShipmentId !== null");
    expect(source).toContain("matched.provider_shipment_id >");
  });

  it("binds the resume cursor and limit as PostgreSQL parameters", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    const flags: HistoricalSplitRepairFlags = {
      mode: "dry-run",
      limit: 25,
      providerShipmentId: null,
      afterProviderShipmentId: 440000000,
      confirmCount: null,
      operator: null,
      reason: null,
      idempotencyKey: null,
      concurrency: 2,
      delayMs: 250,
      progressEvery: 10,
      json: true,
    };
    await repository.loadRetryCandidates(flags);
    expect(query).toHaveBeenCalledWith(
      expect.stringMatching(/matched\.provider_shipment_id > \$1[\s\S]*LIMIT \$2/),
      [440000000, 25],
    );
  });

  it("serializes each affected WMS order and locks source rows", () => {
    expect(source).toContain("pg_advisory_xact_lock(918406, $1)");
    expect(source).toContain("FOR UPDATE OF item, shipment");
    expect(source).toMatch(/await client\.query\("BEGIN"\)[\s\S]*await client\.query\("COMMIT"\)/);
    expect(source).toContain('await client.query("ROLLBACK")');
  });

  it("never writes inventory balances or inventory transactions", () => {
    expect(source).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?wms\.inventory_/i);
    expect(source).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+)?inventory\./i);
  });

  it("does not bypass canonical physical shipment authority", () => {
    expect(source).not.toContain("INSERT INTO wms.physical_shipments");
    expect(source).not.toContain("INSERT INTO oms.channel_fulfillment_pushes");
  });

  it("accepts an interrupted rerun only when its persisted target is an exact match", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical")) return { rows: [] };
      if (sql.includes("LEFT JOIN wms.physical_shipment_items AS physical_item")) {
        return { rows: [sourceRow()] };
      }
      if (sql.includes("WHERE external_fulfillment_id = $1")) {
        return { rows: [{ id: 7101, order_id: 8001, status: "shipped", tracking_number: "9400150106151288520521" }] };
      }
      if (sql.includes("WHERE shipment_id = $1")) {
        return { rows: [{
          order_item_id: 3001,
          replacement_for_order_item_id: null,
          shipment_item_purpose: "customer_fulfillment",
          product_variant_id: 4001,
          qty: 1,
        }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    const result = await repository.inspectPackages([packagePlan()]);
    expect(result.unsafe).toEqual([]);
    expect(result.repairableComponents).toHaveLength(1);
  });

  it("blocks a rerun when canonical source lineage has no exact persisted target", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical")) return { rows: [] };
      if (sql.includes("LEFT JOIN wms.physical_shipment_items AS physical_item")) {
        return { rows: [sourceRow()] };
      }
      if (sql.includes("WHERE external_fulfillment_id = $1")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    const result = await repository.inspectPackages([packagePlan()]);
    expect(result.repairableComponents).toEqual([]);
    expect(result.unsafe).toEqual([
      expect.objectContaining({ code: "SOURCE_PACKAGE_LINEAGE_UNSAFE" }),
    ]);
  });
  it("supports interrupted reruns only when every persisted target exactly matches provider membership", () => {
    expect(source).toContain("loadExactExistingTargets");
    expect(source).toContain("PARTIAL_COMPONENT_RESUME_AMBIGUOUS");
    expect(source).toContain("exactTargetMembership");
  });

  it("keeps carrier movement as the only fulfillment authority", () => {
    expect(source).toContain("provider_label_mapped_awaiting_dispatch");
    expect(source).not.toContain("INSERT INTO oms.channel_fulfillment_pushes");
  });
  it("clears control-tower evidence only after exact package proof", () => {
    expect(source).toContain("CANONICAL_PHYSICAL_SHIPMENT_REQUIRED");
    expect(source).toContain("external_shipment_ref = $1::text");
    expect(source).toContain("status IN ('open', 'acknowledged')");
    expect(source).toContain("id = ANY($1::int[])");
    expect(source).toContain("last_error ~ $9");
  });
  it("anchors one row of every provider package to its exact physical identity", () => {
    expect(source).toContain("orderId === primaryOrderId");
    expect(source).toContain("`shipstation_shipment:${providerShipmentId}`");
    expect(source).toContain("`shipstation_combined:${providerShipmentId}:order:${orderId}`");
  });

  it("proves every repaired WMS package has immutable provider-label linkage", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.shipping_provider_labels AS label")) {
        return { rows: [{ linked_ids: [7101, 7102] }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    await expect(repository.proveProviderPackageLinks({
      providerShipmentId: 442730042,
      legacyWmsShipmentIds: [7101, 7102],
      wmsOrderIds: [8001, 8002],
    })).resolves.toBe(2);
  });

  it("rejects incomplete provider-label linkage before waterfall evidence can clear", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.shipping_provider_labels AS label")) {
        return { rows: [{ linked_ids: [7101] }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    await expect(repository.proveProviderPackageLinks({
      providerShipmentId: 442730042,
      legacyWmsShipmentIds: [7101, 7102],
      wmsOrderIds: [8001, 8002],
    })).rejects.toMatchObject({ code: "PROVIDER_LABEL_TARGET_LINKAGE_INCOMPLETE" });
  });
});