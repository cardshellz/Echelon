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

function packagePlan(
  providerShipmentId = 442730042,
  sourceShipmentItemIds: readonly number[] = [9001],
): HistoricalSplitRepairPackagePlan {
  return {
    providerPackage: {
      providerShipmentId,
      providerOrderId: 755802673,
      providerOrderKey: "echelon-wms-shp-4842",
      orderNumber: "#59564",
      trackingNumber: "9400150106151288520521",
      carrierCode: "stamps_com",
      serviceCode: "usps_ground_advantage",
      shippedAt: new Date("2026-06-28T14:10:00.000Z"),
      items: sourceShipmentItemIds.map((sourceShipmentItemId) => ({
        sourceShipmentItemId,
        quantity: 1,
      })),
    },
    retryIds: [115755],
  };
}

function partialResumePlans(): readonly HistoricalSplitRepairPackagePlan[] {
  const plan = (
    providerShipmentId: number,
    trackingNumber: string,
    sourceShipmentItemId: number,
  ): HistoricalSplitRepairPackagePlan => {
    const base = packagePlan(providerShipmentId, [sourceShipmentItemId]);
    return {
      ...base,
      providerPackage: {
        ...base.providerPackage,
        trackingNumber,
      },
    };
  };
  return Object.freeze([
    plan(442730042, "TRACK-A", 9001),
    plan(442730043, "TRACK-B", 9002),
    plan(442730044, "TRACK-C", 9002),
  ]);
}
function sourceRow(overrides: Record<string, unknown> = {}) {
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
    canonical_physical_shipment_item_id: 6101,
    canonical_quantity_shipped: 1,
    ...overrides,
  };
}
describe("historical ShipStation split repair repository guards", () => {
  it("selects retry failures and open reconciliation exceptions for the proven historical cohort", () => {
    expect(source).toContain("retry.provider = 'shipstation'");
    expect(source).toContain("retry.topic = 'SHIP_NOTIFY'");
    expect(source).toContain("retry.status = 'dead'");
    expect(source).toContain("uq_outbound_shipments_active_");
    expect(source).toContain("exception_matches AS");
    expect(source).toContain("shipstation_unmapped_physical_shipment");
    expect(source).toContain("exception.status IN ('open', 'acknowledged')");
  });

  it("supports an explicit provider shipment resume cursor", () => {
    expect(source).toContain("flags.afterProviderShipmentId !== null");
    expect(source).toContain("grouped.provider_shipment_id >");
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
      expect.stringMatching(/grouped\.provider_shipment_id > \$1[\s\S]*LIMIT \$2/),
      [440000000, 25],
    );
  });

  it("expands one failed package into its proven active sibling split cohort", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toContain("source_aggregates AS");
      expect(sql).toContain("sibling_candidates AS");
      expect(sql).toContain("aggregate_shipment.status = 'shipped'");
      expect(sql).toContain("COALESCE(aggregate_shipment.source, '') <> 'shipstation_split'");
      expect(sql).toContain("sibling_label.label_direction = 'outbound'");
      expect(sql).toContain("sibling_label.label_status IN ('active', 'unknown')");
      expect(sql).toContain("sibling_label.voided_at IS NULL");
      expect(sql).toContain("exception_matches AS");
      expect(sql).not.toContain("sibling_target.source = 'shipstation_split'");
      return {
        rows: [
          { provider_shipment_id: "443963753", retry_ids: [115757] },
          { provider_shipment_id: "443964641", retry_ids: [] },
          { provider_shipment_id: "443965277", retry_ids: [] },
        ],
      };
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    const flags: HistoricalSplitRepairFlags = {
      mode: "dry-run",
      limit: null,
      providerShipmentId: 443963753,
      afterProviderShipmentId: null,
      confirmCount: null,
      operator: null,
      reason: null,
      idempotencyKey: null,
      concurrency: 1,
      delayMs: 0,
      progressEvery: 1,
      json: true,
    };

    await expect(repository.loadRetryCandidates(flags)).resolves.toEqual([
      { providerShipmentId: 443963753, retryIds: [115757] },
      { providerShipmentId: 443964641, retryIds: [] },
      { providerShipmentId: 443965277, retryIds: [] },
    ]);
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

  it("uses append-only quantity corrections for over-attributed canonical packages", () => {
    expect(source).toContain(
      "INSERT INTO wms.physical_shipment_item_quantity_adjustments",
    );
    expect(source).toContain("historical_provider_package_repartition");
    expect(source).toContain("CANONICAL_CORRECTION_MEMBERSHIP_MISMATCH");
    expect(source).toContain("FROM wms.effective_physical_shipment_items");
    expect(source).not.toMatch(
      /(?:UPDATE|DELETE FROM) wms\.physical_shipment_items/i,
    );
  });

  it("accepts an interrupted rerun only when its persisted target is an exact match", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical")) return { rows: [] };
      if (sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")) {
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

  it("recognizes a fully reshaped noncanonical target as resumable", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical")) return { rows: [] };
      if (sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")) {
        return { rows: [sourceRow({ canonical_physical_shipment_id: null })] };
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

  it.each([
    { status: "voided", trackingNumber: "old-tracking" },
    { status: "cancelled", trackingNumber: null },
    { status: "queued", trackingNumber: null },
  ])(
    "recognizes an exact $status provider package with stale local state as repairable",
    async ({ status, trackingNumber }) => {
      const query = vi.fn(
        async (sql: string) => {
          if (sql.includes("FROM wms.physical_shipments AS physical"))
            return { rows: [] };
          if (
            sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")
          ) {
            return {
              rows: [sourceRow({ canonical_physical_shipment_id: null })],
            };
          }
          if (sql.includes("WHERE external_fulfillment_id = $1")) {
            return {
              rows: [{
                id: 7101,
                order_id: 8001,
                status,
                external_fulfillment_id: "shipstation_shipment:442730042",
                tracking_number: trackingNumber,
              }],
            };
          }
          if (
            sql.includes("SELECT order_item_id, replacement_for_order_item_id")
          ) {
            return {
              rows: [{
                order_item_id: 3001,
                replacement_for_order_item_id: null,
                shipment_item_purpose: "customer_fulfillment",
                product_variant_id: 4001,
                qty: 1,
              }],
            };
          }
          if (sql.includes("AS has_canonical_evidence")) {
            return { rows: [{ has_canonical_evidence: false }] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      );
      const repository = createHistoricalShipStationSplitRepairRepository({
        query,
      } as any);
      const result = await repository.inspectPackages([packagePlan()]);
      expect(result.unsafe).toEqual([]);
      expect(result.repairableComponents).toHaveLength(1);
    },
  );

  it("blocks provider-state recovery when residual source quantity lacks current package membership proof", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical"))
        return { rows: [] };
      if (sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")) {
        return {
          rows: [sourceRow({
            qty: 2,
            canonical_physical_shipment_id: null,
          })],
        };
      }
      if (sql.includes("WHERE external_fulfillment_id = $1")) {
        return { rows: [{
          id: 7101,
          order_id: 8001,
          status: "voided",
          external_fulfillment_id: "shipstation_shipment:442730042",
          tracking_number: "stale-tracking",
        }] };
      }
      if (sql.includes("SELECT order_item_id, replacement_for_order_item_id")) {
        return { rows: [{
          order_item_id: 3001,
          replacement_for_order_item_id: null,
          shipment_item_purpose: "customer_fulfillment",
          product_variant_id: 4001,
          qty: 1,
        }] };
      }
      if (sql.includes("AS has_canonical_evidence")) {
        return { rows: [{ has_canonical_evidence: false }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    const result = await repository.inspectPackages([packagePlan()]);
    expect(result.repairableComponents).toEqual([]);
    expect(result.unsafe).toContainEqual(
      expect.objectContaining({
        code: "COMPONENT_QUANTITY_PROOF_FAILED",
        message: expect.stringContaining(
          "without current provider membership proof",
        ),
      }),
    );
  });

  it("rejects stale provider state when its package items already have canonical evidence", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical"))
        return { rows: [] };
      if (sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")) {
        return { rows: [sourceRow({ canonical_physical_shipment_id: null })] };
      }
      if (sql.includes("WHERE external_fulfillment_id = $1")) {
        return { rows: [{
          id: 7101,
          order_id: 8001,
          status: "cancelled",
          external_fulfillment_id: "shipstation_shipment:442730042",
          tracking_number: null,
        }] };
      }
      if (sql.includes("SELECT order_item_id, replacement_for_order_item_id")) {
        return { rows: [{
          order_item_id: 3001,
          replacement_for_order_item_id: null,
          shipment_item_purpose: "customer_fulfillment",
          product_variant_id: 4001,
          qty: 1,
        }] };
      }
      if (sql.includes("AS has_canonical_evidence")) {
        return { rows: [{ has_canonical_evidence: true }] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    const result = await repository.inspectPackages([packagePlan()]);
    expect(result.repairableComponents).toEqual([]);
    expect(result.unsafe).toContainEqual(
      expect.objectContaining({ code: "TARGET_PROVIDER_STATE_CANONICAL_EVIDENCE" }),
    );
  });

  it("groups sibling source rows from one aggregate shipment into one component", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical")) return { rows: [] };
      if (sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")) {
        return { rows: [
          sourceRow({ id: 9001, shipment_id: 7001, order_item_id: 3001, canonical_physical_shipment_id: null }),
          sourceRow({ id: 9002, shipment_id: 7001, order_item_id: 3002, canonical_physical_shipment_id: null }),
        ] };
      }
      if (sql.includes("WHERE external_fulfillment_id = $1")) return { rows: [] };
      if (sql.includes("WHERE order_id = $1 AND status = 'shipped'")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    const result = await repository.inspectPackages([
      packagePlan(442730042, [9001]),
      packagePlan(442730043, [9002]),
    ]);
    expect(result.unsafe).toEqual([]);
    expect(result.repairableComponents).toHaveLength(1);
    expect(result.repairableComponents[0].packages.map((plan) =>
      plan.providerPackage.providerShipmentId
    )).toEqual([442730042, 442730043]);
  });

  it("reports fallback target ambiguity during dry-run", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical")) return { rows: [] };
      if (sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")) {
        return { rows: [sourceRow({ canonical_physical_shipment_id: null })] };
      }
      if (sql.includes("WHERE external_fulfillment_id = $1")) return { rows: [] };
      if (sql.includes("WHERE order_id = $1 AND status = 'shipped'")) {
        return { rows: [
          { id: 7101, order_id: 8001, status: "shipped", external_fulfillment_id: null, tracking_number: "9400150106151288520521" },
          { id: 7102, order_id: 8001, status: "shipped", external_fulfillment_id: null, tracking_number: "9400150106151288520521" },
        ] };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    const result = await repository.inspectPackages([packagePlan()]);
    expect(result.repairableComponents).toEqual([]);
    expect(result.unsafe).toEqual([
      expect.objectContaining({ code: "TARGET_PACKAGE_IDENTITY_AMBIGUOUS" }),
    ]);
  });

  it("reports duplicate order-item source rows during dry-run", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical")) return { rows: [] };
      if (sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")) {
        return { rows: [
          sourceRow({ id: 9001, order_item_id: 3001, canonical_physical_shipment_id: null }),
          sourceRow({ id: 9002, order_item_id: 3001, canonical_physical_shipment_id: null }),
        ] };
      }
      if (sql.includes("WHERE external_fulfillment_id = $1")) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);
    const result = await repository.inspectPackages([packagePlan(442730042, [9001, 9002])]);
    expect(result.repairableComponents).toEqual([]);
    expect(result.unsafe).toEqual([
      expect.objectContaining({ code: "TARGET_ORDER_ITEM_IDENTITY_COLLISION" }),
    ]);
  });

  it("accepts a partially resumed component only when a retired exact duplicate can surrender identity safely", async () => {
    const query = vi.fn(
      async (sql: string, params: readonly unknown[] = []) => {
        if (sql.includes("FROM wms.physical_shipments AS physical"))
          return { rows: [] };
        if (
          sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")
        ) {
          return {
            rows: [
              sourceRow({
                id: 9001,
                shipment_id: 7001,
                order_item_id: 3001,
                qty: 1,
                tracking_number: "TRACK-A",
                external_fulfillment_id: null,
                canonical_physical_shipment_id: null,
              }),
              sourceRow({
                id: 9002,
                shipment_id: 7001,
                order_item_id: 3002,
                qty: 2,
                tracking_number: "TRACK-A",
                external_fulfillment_id: null,
                canonical_physical_shipment_id: null,
              }),
            ],
          };
        }
        if (sql.includes("WHERE external_fulfillment_id = $1")) {
          const identity = String(params[0]);
          if (identity.endsWith("442730042")) {
            return {
              rows: [
                {
                  id: 7101,
                  order_id: 8001,
                  status: "voided",
                  external_fulfillment_id: identity,
                  tracking_number: "TRACK-A",
                },
              ],
            };
          }
          if (identity.endsWith("442730043")) {
            return {
              rows: [
                {
                  id: 7102,
                  order_id: 8001,
                  status: "shipped",
                  external_fulfillment_id: identity,
                  tracking_number: "TRACK-B",
                },
              ],
            };
          }
          return {
            rows: [
              {
                id: 7103,
                order_id: 8001,
                status: "shipped",
                external_fulfillment_id: identity,
                tracking_number: "TRACK-C",
              },
            ],
          };
        }
        if (sql.includes("AS has_canonical_evidence")) {
          return { rows: [{ has_canonical_evidence: false }] };
        }
        if (
          sql.includes("WHERE id = $1 AND order_id = $2 AND status = 'shipped'")
        ) {
          return {
            rows: [
              {
                id: 7001,
                order_id: 8001,
                status: "shipped",
                external_fulfillment_id: null,
                tracking_number: "TRACK-A",
              },
            ],
          };
        }
        if (sql.includes("WHERE shipment_id = $1")) {
          const shipmentId = Number(params[0]);
          if (shipmentId === 7001) {
            return {
              rows: [
                {
                  order_item_id: 3001,
                  replacement_for_order_item_id: null,
                  shipment_item_purpose: "customer_fulfillment",
                  product_variant_id: 4001,
                  qty: 1,
                },
                {
                  order_item_id: 3002,
                  replacement_for_order_item_id: null,
                  shipment_item_purpose: "customer_fulfillment",
                  product_variant_id: 4001,
                  qty: 2,
                },
              ],
            };
          }
          return {
            rows: [
              {
                order_item_id: shipmentId === 7101 ? 3001 : 3002,
                replacement_for_order_item_id: null,
                shipment_item_purpose: "customer_fulfillment",
                product_variant_id: 4001,
                qty: 1,
              },
            ],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    );
    const repository = createHistoricalShipStationSplitRepairRepository({
      query,
    } as any);
    const result = await repository.inspectPackages(partialResumePlans());
    expect(result.unsafe).toEqual([]);
    expect(result.repairableComponents).toHaveLength(1);
    expect(result.repairableComponents[0].packages).toHaveLength(3);
  });

  it("uses exact canonical siblings to prove complete aggregate allocation", async () => {
    const plans = partialResumePlans();
    const query = vi.fn(
      async (sql: string, params: readonly unknown[] = []) => {
        if (sql.includes("FROM wms.physical_shipments AS physical")) {
          return {
            rows: [
              {
                provider_physical_shipment_id: "442730043",
                physical_shipment_id: 6002,
                tracking_number: "TRACK-B",
                legacy_wms_shipment_ids: [7102],
                wms_order_ids: [8001],
                channel_command_count: 1,
              },
              {
                provider_physical_shipment_id: "442730044",
                physical_shipment_id: 6003,
                tracking_number: "TRACK-C",
                legacy_wms_shipment_ids: [7103],
                wms_order_ids: [8001],
                channel_command_count: 1,
              },
            ],
          };
        }
        if (
          sql.includes("FROM wms.effective_physical_shipment_items AS item")
          && sql.includes("physical_shipment_id = ANY")
        ) {
          return {
            rows: [
              {
                id: 6102,
                physical_shipment_id: 6002,
                legacy_wms_shipment_item_id: 9002,
                quantity_shipped: 1,
              },
              {
                id: 6103,
                physical_shipment_id: 6003,
                legacy_wms_shipment_item_id: 9002,
                quantity_shipped: 1,
              },
            ],
          };
        }
        if (
          sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")
        ) {
          return {
            rows: [
              sourceRow({
                id: 9001,
                shipment_id: 7001,
                order_item_id: 3001,
                qty: 1,
                external_fulfillment_id: null,
                tracking_number: "TRACK-A",
                canonical_physical_shipment_id: null,
              }),
              sourceRow({
                id: 9002,
                shipment_id: 7001,
                order_item_id: 3002,
                qty: 2,
                external_fulfillment_id: null,
                tracking_number: "TRACK-A",
                canonical_physical_shipment_id: null,
              }),
            ],
          };
        }
        if (sql.includes("WHERE external_fulfillment_id = $1")) {
          const identity = String(params[0]);
          const providerShipmentId = Number(identity.split(":").at(-1));
          const targetId = providerShipmentId === 442730042
            ? 7101
            : providerShipmentId === 442730043
              ? 7102
              : 7103;
          return {
            rows: [{
              id: targetId,
              order_id: 8001,
              status: providerShipmentId === 442730042
                ? "cancelled"
                : "shipped",
              external_fulfillment_id: identity,
              tracking_number: providerShipmentId === 442730042
                ? "STALE-TRACKING"
                : providerShipmentId === 442730043
                  ? "TRACK-B"
                  : "TRACK-C",
            }],
          };
        }
        if (
          sql.includes("SELECT order_item_id, replacement_for_order_item_id")
        ) {
          const targetId = Number(params[0]);
          return {
            rows: [{
              order_item_id: targetId === 7101 ? 3001 : 3002,
              replacement_for_order_item_id: null,
              shipment_item_purpose: "customer_fulfillment",
              product_variant_id: 4001,
              qty: 1,
            }],
          };
        }
        if (sql.includes("AS has_canonical_evidence")) {
          return { rows: [{ has_canonical_evidence: false }] };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    );
    const repository = createHistoricalShipStationSplitRepairRepository({
      query,
    } as any);

    const result = await repository.inspectPackages(plans);

    expect(result.unsafe).toEqual([]);
    expect(result.alreadyCanonical.map((entry) =>
      entry.packagePlan.providerPackage.providerShipmentId
    )).toEqual([442730043, 442730044]);
    expect(result.repairableComponents).toHaveLength(1);
    expect(result.repairableComponents[0].packages.map((plan) =>
      plan.providerPackage.providerShipmentId
    )).toEqual([442730042]);
    expect(result.repairableComponents[0].canonicalSupports?.map((support) =>
      support.packagePlan.providerPackage.providerShipmentId
    )).toEqual([442730043, 442730044]);
  });

  it("classifies a fully proven over-attributed canonical package as one atomic correction cohort", async () => {
    const first = packagePlan(442730042, [9001]);
    const secondBase = packagePlan(442730043, [9002]);
    const plans = [
      {
        ...first,
        providerPackage: {
          ...first.providerPackage,
          trackingNumber: "TRACK-A",
        },
      },
      {
        ...secondBase,
        providerPackage: {
          ...secondBase.providerPackage,
          trackingNumber: "TRACK-B",
        },
      },
    ];
    const query = vi.fn(async (sql: string, params: readonly unknown[] = []) => {
      if (sql.includes("FROM wms.physical_shipments AS physical")) {
        return { rows: [{
          provider_physical_shipment_id: "442730042",
          physical_shipment_id: 6001,
          tracking_number: "TRACK-A",
          legacy_wms_shipment_ids: [7001],
          wms_order_ids: [8001],
          channel_command_count: 1,
        }] };
      }
      if (
        sql.includes("FROM wms.effective_physical_shipment_items AS item")
        && sql.includes("physical_shipment_id = ANY")
      ) {
        return { rows: [
          {
            id: 6101,
            physical_shipment_id: 6001,
            legacy_wms_shipment_item_id: 9001,
            quantity_shipped: 1,
          },
          {
            id: 6102,
            physical_shipment_id: 6001,
            legacy_wms_shipment_item_id: 9002,
            quantity_shipped: 1,
          },
        ] };
      }
      if (
        sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")
      ) {
        return { rows: [
          sourceRow({
            id: 9001,
            shipment_id: 7001,
            order_item_id: 3001,
            tracking_number: "TRACK-A",
            external_fulfillment_id: "shipstation_shipment:442730042",
            canonical_physical_shipment_id: 6001,
            canonical_physical_shipment_item_id: 6101,
            canonical_quantity_shipped: 1,
          }),
          sourceRow({
            id: 9002,
            shipment_id: 7001,
            order_item_id: 3002,
            tracking_number: "TRACK-A",
            external_fulfillment_id: "shipstation_shipment:442730042",
            canonical_physical_shipment_id: 6001,
            canonical_physical_shipment_item_id: 6102,
            canonical_quantity_shipped: 1,
          }),
        ] };
      }
      if (sql.includes("WHERE external_fulfillment_id = $1")) {
        return String(params[0]).endsWith("442730042")
          ? { rows: [{
              id: 7001,
              order_id: 8001,
              status: "shipped",
              external_fulfillment_id: "shipstation_shipment:442730042",
              tracking_number: "TRACK-A",
            }] }
          : { rows: [] };
      }
      if (sql.includes("WHERE shipment_id = $1")) {
        return { rows: [
          {
            order_item_id: 3001,
            replacement_for_order_item_id: null,
            shipment_item_purpose: "customer_fulfillment",
            product_variant_id: 4001,
            qty: 1,
          },
          {
            order_item_id: 3002,
            replacement_for_order_item_id: null,
            shipment_item_purpose: "customer_fulfillment",
            product_variant_id: 4001,
            qty: 1,
          },
        ] };
      }
      if (
        sql.includes("WHERE order_id = $1")
        && sql.includes("status = 'shipped'")
        && sql.includes("tracking_number = $2")
      ) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = createHistoricalShipStationSplitRepairRepository({
      query,
    } as any);

    const result = await repository.inspectPackages(plans);

    expect(result.unsafe).toEqual([]);
    expect(result.repairableComponents).toHaveLength(1);
    expect(result.repairableComponents[0].packages.map((plan) =>
      plan.providerPackage.providerShipmentId
    )).toEqual([442730042, 442730043]);
    expect(result.repairableComponents[0].canonicalCorrections).toEqual([{
      providerShipmentId: 442730042,
      physicalShipmentId: 6001,
    }]);
  });

  it("classifies an exact active package as superseding one voided canonical label", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("JOIN wms.shipping_provider_label_links AS link")) {
        return { rows: [{ provider_physical_shipment_id: "444133783" }] };
      }
      if (sql.includes("FROM wms.physical_shipments AS physical")) {
        return { rows: [] };
      }
      if (
        sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")
      ) {
        return { rows: [sourceRow({
          id: 10290,
          shipment_id: 6521,
          order_id: 204876,
          order_item_id: 312115,
          qty: 1,
          tracking_number: "9434650106151101977558",
          external_fulfillment_id: "shipstation_shipment:444133783",
          canonical_physical_shipment_id: 876,
          canonical_physical_shipment_item_id: 9901,
          canonical_quantity_shipped: 1,
        })] };
      }
      if (sql.includes("WHERE external_fulfillment_id = $1")) return { rows: [] };
      if (
        sql.includes("WHERE order_id = $1")
        && sql.includes("status = 'shipped'")
        && sql.includes("tracking_number = $2")
      ) return { rows: [] };
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const replacement = packagePlan(446092075, [10290]);
    const repository = createHistoricalShipStationSplitRepairRepository({ query } as any);

    const result = await repository.inspectPackages([replacement]);

    expect(result.unsafe).toEqual([]);
    expect(result.repairableComponents).toHaveLength(1);
    expect(result.repairableComponents[0].canonicalCorrections).toEqual([{
      providerShipmentId: 446092075,
      physicalShipmentId: 876,
      correctionKind: "voided_label_supersession",
      supersededProviderShipmentId: 444133783,
    }]);
  });
  it("rejects a retired duplicate that already has canonical fulfillment evidence", async () => {
    const query = vi.fn(
      async (sql: string, params: readonly unknown[] = []) => {
        if (sql.includes("FROM wms.physical_shipments AS physical"))
          return { rows: [] };
        if (
          sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")
        ) {
          return {
            rows: [
              sourceRow({
                id: 9001,
                shipment_id: 7001,
                order_item_id: 3001,
                qty: 1,
                tracking_number: "TRACK-A",
                external_fulfillment_id: null,
                canonical_physical_shipment_id: null,
              }),
              sourceRow({
                id: 9002,
                shipment_id: 7001,
                order_item_id: 3002,
                qty: 2,
                tracking_number: "TRACK-A",
                external_fulfillment_id: null,
                canonical_physical_shipment_id: null,
              }),
            ],
          };
        }
        if (sql.includes("WHERE external_fulfillment_id = $1")) {
          const identity = String(params[0]);
          const suffix = Number(identity.split(":").at(-1));
          return {
            rows: [
              {
                id:
                  suffix === 442730042
                    ? 7101
                    : suffix === 442730043
                      ? 7102
                      : 7103,
                order_id: 8001,
                status: suffix === 442730042 ? "voided" : "shipped",
                external_fulfillment_id: identity,
                tracking_number:
                  suffix === 442730042
                    ? "TRACK-A"
                    : suffix === 442730043
                      ? "TRACK-B"
                      : "TRACK-C",
              },
            ],
          };
        }
        if (sql.includes("AS has_canonical_evidence")) {
          return { rows: [{ has_canonical_evidence: true }] };
        }
        if (sql.includes("WHERE shipment_id = $1")) {
          const shipmentId = Number(params[0]);
          return {
            rows: [
              {
                order_item_id: shipmentId === 7101 ? 3001 : 3002,
                replacement_for_order_item_id: null,
                shipment_item_purpose: "customer_fulfillment",
                product_variant_id: 4001,
                qty: 1,
              },
            ],
          };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    );
    const repository = createHistoricalShipStationSplitRepairRepository({
      query,
    } as any);
    const result = await repository.inspectPackages(partialResumePlans());
    expect(result.repairableComponents).toEqual([]);
    expect(result.unsafe).toContainEqual(
      expect.objectContaining({
        code: "TARGET_RETIRED_DUPLICATE_CANONICAL_EVIDENCE",
      }),
    );
  });
  it("prefers an exact package identity over a stale order-and-tracking fallback", async () => {
    let fallbackQueried = false;
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
        if (sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")) {
          return { rows: [sourceRow({ canonical_physical_shipment_id: null })] };
        }
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("WHERE external_fulfillment_id = $1")) {
          return { rows: [{
            id: 7101,
            order_id: 8001,
            status: "shipped",
            external_fulfillment_id: "shipstation_shipment:442730042",
            tracking_number: "9400150106151288520521",
          }] };
        }
        if (sql.includes("WHERE order_id = $1 AND status = 'shipped'")) {
          fallbackQueried = true;
          return { rows: [] };
        }
        if (sql.includes("SET external_fulfillment_id = COALESCE")) return { rows: [] };
        if (sql.includes("WHERE shipment_id = $1")) {
          return { rows: [{
            order_item_id: 3001,
            replacement_for_order_item_id: null,
            shipment_item_purpose: "customer_fulfillment",
            product_variant_id: 4001,
            qty: 1,
          }] };
        }
        if (sql.includes("SET status = 'cancelled'")) return { rows: [] };
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    const repository = createHistoricalShipStationSplitRepairRepository({
      connect: vi.fn(async () => client),
    } as any);
    const result = await repository.applyComponent({
      componentKey: "442730042",
      packages: [packagePlan()],
    }, {
      runId: "run-1",
      operator: "owner@cardshellz.com",
      reason: "resume production repair",
      idempotencyKey: "resume-1",
      occurredAt: new Date("2026-07-31T12:00:00.000Z"),
    });
    expect(result).toEqual([{
      providerShipmentId: 442730042,
      legacyWmsShipmentIds: [7101],
      wmsOrderIds: [8001],
    }]);
    expect(fallbackQueried).toBe(false);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("atomically corrects an over-attributed canonical package and moves the sibling line", async () => {
    const firstBase = packagePlan(442730042, [9001]);
    const secondBase = packagePlan(442730043, [9002]);
    const plans = [
      {
        ...firstBase,
        providerPackage: {
          ...firstBase.providerPackage,
          trackingNumber: "TRACK-A",
        },
      },
      {
        ...secondBase,
        providerPackage: {
          ...secondBase.providerPackage,
          trackingNumber: "TRACK-B",
        },
      },
    ];
    const items = new Map([
      [9001, { shipmentId: 7001, orderItemId: 3001, trackingId: null }],
      [9002, { shipmentId: 7001, orderItemId: 3002, trackingId: null }],
    ]);
    let correctionInserted = false;
    const membershipRows = (shipmentId: number) =>
      [...items.entries()]
        .filter(([, item]) => item.shipmentId === shipmentId)
        .map(([, item]) => ({
          order_item_id: item.orderItemId,
          replacement_for_order_item_id: null,
          shipment_item_purpose: "customer_fulfillment",
          product_variant_id: 4001,
          qty: 1,
        }));
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (
          sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")
          && sql.includes("FOR UPDATE OF item, shipment")
        ) {
          return { rows: [
            sourceRow({
              id: 9001,
              shipment_id: items.get(9001)!.shipmentId,
              order_item_id: 3001,
              tracking_number: "TRACK-A",
              external_fulfillment_id: "shipstation_shipment:442730042",
              canonical_physical_shipment_id: 6001,
              canonical_physical_shipment_item_id: 6101,
              canonical_quantity_shipped: 1,
            }),
            sourceRow({
              id: 9002,
              shipment_id: items.get(9002)!.shipmentId,
              order_item_id: 3002,
              tracking_number: "TRACK-A",
              external_fulfillment_id: "shipstation_shipment:442730042",
              canonical_physical_shipment_id: 6001,
              canonical_physical_shipment_item_id: 6102,
              canonical_quantity_shipped: 1,
            }),
          ] };
        }
        if (sql.includes("WHERE external_fulfillment_id = $1")) {
          return String(params[0]).endsWith("442730042")
            ? { rows: [{
                id: 7001,
                order_id: 8001,
                status: "shipped",
                external_fulfillment_id: "shipstation_shipment:442730042",
                tracking_number: "TRACK-A",
              }] }
            : { rows: [] };
        }
        if (
          sql.includes("WHERE order_id = $1 AND status = 'shipped'")
          && sql.includes("tracking_number = $2")
        ) return { rows: [] };
        if (sql.includes("INSERT INTO wms.outbound_shipments")) {
          return { rows: [{ id: 7102 }] };
        }
        if (sql.includes("SET external_fulfillment_id = COALESCE")) {
          return { rows: [] };
        }
        if (
          sql.includes("SELECT order_item_id, replacement_for_order_item_id")
          && sql.includes("WHERE shipment_id = $1")
        ) return { rows: membershipRows(Number(params[0])) };
        if (
          sql.includes("FROM wms.physical_shipment_items AS item")
          && sql.includes("LEFT JOIN wms.physical_shipment_item_quantity_adjustments")
        ) {
          const physicalItemId = Number(params[0]);
          return { rows: [{
            id: physicalItemId,
            physical_shipment_id: 6001,
            legacy_wms_shipment_item_id: physicalItemId === 6101 ? 9001 : 9002,
            quantity_shipped: 1,
            quantity_delta: null,
          }] };
        }
        if (sql.includes("INSERT INTO wms.physical_shipment_item_quantity_adjustments")) {
          expect(params[0]).toBe(6102);
          expect(params[1]).toBe(-1);
          correctionInserted = true;
          return { rows: [{ id: 1 }] };
        }
        if (sql.includes("SET qty = $2, tracking_id = $3")) {
          items.get(Number(params[0]))!.trackingId = String(params[2]);
          return { rows: [] };
        }
        if (
          sql.includes("SET shipment_id = $2, qty = $3, tracking_id = $4")
        ) {
          const item = items.get(Number(params[0]))!;
          item.shipmentId = Number(params[1]);
          item.trackingId = String(params[3]);
          return { rows: [{ id: Number(params[0]) }] };
        }
        if (
          sql.includes("FROM wms.effective_physical_shipment_items AS item")
          && sql.includes("physical_shipment_id = ANY")
        ) {
          return { rows: [{
            id: 6101,
            physical_shipment_id: 6001,
            legacy_wms_shipment_item_id: 9001,
            quantity_shipped: 1,
          }] };
        }
        if (
          sql.includes("SET status = 'cancelled'")
          && sql.includes("historical_aggregate_repartitioned")
        ) return { rows: [] };
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    const repository = createHistoricalShipStationSplitRepairRepository({
      connect: vi.fn(async () => client),
    } as any);

    const result = await repository.applyComponent({
      componentKey: "aggregate-correction",
      packages: plans,
      canonicalCorrections: [{
        providerShipmentId: 442730042,
        physicalShipmentId: 6001,
      }],
    }, {
      runId: "00000000-0000-4000-8000-000000000001",
      operator: "owner@cardshellz.com",
      reason: "repair over-attributed historical package",
      idempotencyKey: "aggregate-correction-1",
      occurredAt: new Date("2026-08-03T12:00:00.000Z"),
    });

    expect(correctionInserted).toBe(true);
    expect(items.get(9001)).toMatchObject({
      shipmentId: 7001,
      trackingId: "442730042",
    });
    expect(items.get(9002)).toMatchObject({
      shipmentId: 7102,
      trackingId: "442730043",
    });
    expect(result).toEqual([
      {
        providerShipmentId: 442730042,
        legacyWmsShipmentIds: [7001],
        wmsOrderIds: [8001],
      },
      {
        providerShipmentId: 442730043,
        legacyWmsShipmentIds: [7102],
        wmsOrderIds: [8001],
      },
    ]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      name: "reuses a retired archive while moving original lineage into exact split targets",
      preexistingArchive: true,
      recoverProviderState: false,
      canonicalSiblingSupports: false,
    },
    {
      name: "creates a deterministic audit archive when exact split copies have no retired archive",
      preexistingArchive: false,
      recoverProviderState: false,
      canonicalSiblingSupports: false,
    },
    {
      name: "reactivates an exact stale provider target and replaces historical copies with original lineage",
      preexistingArchive: true,
      recoverProviderState: true,
      canonicalSiblingSupports: false,
    },
    {
      name: "preserves canonical sibling items while reactivating only the failed split package",
      preexistingArchive: true,
      recoverProviderState: true,
      canonicalSiblingSupports: true,
    },
  ])("$name", async ({
    preexistingArchive, recoverProviderState, canonicalSiblingSupports,
  }) => {
    interface ShipmentState {
      id: number;
      orderId: number;
      status: string;
      externalId: string | null;
      tracking: string;
    }
    interface ItemState {
      id: number;
      shipmentId: number;
      orderItemId: number;
      quantity: number;
      trackingId: string | null;
    }
    const shipments = new Map<number, ShipmentState>([
      [
        7001,
        {
          id: 7001,
          orderId: 8001,
          status: "shipped",
          externalId: null,
          tracking: "TRACK-A",
        },
      ],
      [
        7101,
        {
          id: 7101,
          orderId: 8001,
          status: recoverProviderState ? "cancelled" : "voided",
          externalId: "shipstation_shipment:442730042",
          tracking: recoverProviderState ? "STALE-TRACKING" : "TRACK-A",
        },
      ],
      [
        7102,
        {
          id: 7102,
          orderId: 8001,
          status: "shipped",
          externalId: "shipstation_shipment:442730043",
          tracking: "TRACK-B",
        },
      ],
      [
        7103,
        {
          id: 7103,
          orderId: 8001,
          status: "shipped",
          externalId: "shipstation_shipment:442730044",
          tracking: "TRACK-C",
        },
      ],
    ]);
    if (!preexistingArchive) {
      shipments.delete(7101);
      shipments.get(7001)!.externalId = "shipstation_shipment:442730042";
    }
    const items = new Map<number, ItemState>([
      [
        9001,
        {
          id: 9001,
          shipmentId: 7001,
          orderItemId: 3001,
          quantity: 1,
          trackingId: null,
        },
      ],
      [
        9002,
        {
          id: 9002,
          shipmentId: 7001,
          orderItemId: 3002,
          quantity: 2,
          trackingId: null,
        },
      ],
      [
        9101,
        {
          id: 9101,
          shipmentId: 7101,
          orderItemId: 3001,
          quantity: 1,
          trackingId: "442730042",
        },
      ],
      [
        9201,
        {
          id: 9201,
          shipmentId: 7102,
          orderItemId: 3002,
          quantity: 1,
          trackingId: "442730043",
        },
      ],
      [
        9301,
        {
          id: 9301,
          shipmentId: 7103,
          orderItemId: 3002,
          quantity: 1,
          trackingId: "442730044",
        },
      ],
    ]);
    if (!preexistingArchive) items.delete(9101);
    const membershipRows = (shipmentId: number) =>
      [...items.values()]
        .filter((item) => item.shipmentId === shipmentId)
        .sort((left, right) => left.id - right.id)
        .map((item) => ({
          order_item_id: item.orderItemId,
          replacement_for_order_item_id: null,
          shipment_item_purpose: "customer_fulfillment",
          product_variant_id: 4001,
          qty: item.quantity,
        }));
    const client = {
      query: vi.fn(async (sql: string, params: readonly unknown[] = []) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK")
          return { rows: [] };
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (
          canonicalSiblingSupports
          && sql.includes("FROM wms.physical_shipments AS physical")
        ) {
          const providerShipmentId = Number((params[0] as string[])[0]);
          const targetShipmentId = providerShipmentId === 442730043
            ? 7102
            : 7103;
          return {
            rows: [{
              provider_physical_shipment_id: String(providerShipmentId),
              physical_shipment_id: providerShipmentId === 442730043
                ? 6002
                : 6003,
              tracking_number: providerShipmentId === 442730043
                ? "TRACK-B"
                : "TRACK-C",
              legacy_wms_shipment_ids: [targetShipmentId],
              wms_order_ids: [8001],
              channel_command_count: 1,
            }],
          };
        }
        if (
          sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")
        ) {
          return {
            rows: (params[0] as number[]).map((id) => {
              const item = items.get(id)!;
              const shipment = shipments.get(item.shipmentId)!;
              return sourceRow({
                id: item.id,
                shipment_id: item.shipmentId,
                order_id: shipment.orderId,
                shipment_status: shipment.status,
                shipment_source: "echelon_sync",
                external_fulfillment_id: shipment.externalId,
                tracking_number: shipment.tracking,
                order_item_id: item.orderItemId,
                qty: item.quantity,
                tracking_id: item.trackingId,
                canonical_physical_shipment_id: null,
              });
            }),
          };
        }
        if (
          sql.includes("WHERE order_id = $1 AND external_fulfillment_id = $2")
        ) {
          const archive = [...shipments.values()].find(
            (shipment) =>
              shipment.orderId === Number(params[0]) &&
              shipment.externalId === String(params[1]),
          );
          return {
            rows: archive
              ? [{
                  id: archive.id,
                  status: archive.status,
                  source: "historical_ss_split_repair",
                  tracking_number: archive.tracking,
                  shipment_purpose: "customer_fulfillment",
                  review_reason: "historical_split_duplicate_archive",
                }]
              : [],
          };
        }
        if (
          sql.includes("INSERT INTO wms.outbound_shipments") &&
          sql.includes("'cancelled'")
        ) {
          shipments.set(7200, {
            id: 7200, orderId: Number(params[0]), status: "cancelled",
            externalId: String(params[2]), tracking: "",
          });
          return { rows: [{ id: 7200 }] };
        }
        if (sql.includes("WHERE external_fulfillment_id = $1")) {
          return {
            rows: [...shipments.values()]
              .filter((shipment) => shipment.externalId === String(params[0]))
              .map((shipment) => ({
                id: shipment.id,
                order_id: shipment.orderId,
                status: shipment.status,
                external_fulfillment_id: shipment.externalId,
                tracking_number: shipment.tracking,
              })),
          };
        }
        if (
          sql.includes("AS has_canonical_evidence") &&
          sql.includes("SELECT item.id") &&
          sql.includes("item.shipment_id = $1")
        ) {
          const targetShipmentId = Number(params[0]);
          const sourceItemId = Number(params[1]);
          const orderItemId = Number(params[2]);
          const quantity = Number(params[6]);
          return {
            rows: [...items.values()]
              .filter(
                (item) =>
                  item.shipmentId === targetShipmentId &&
                  item.id !== sourceItemId &&
                  item.orderItemId === orderItemId &&
                  item.quantity === quantity,
              )
              .map((item) => ({
                id: item.id,
                has_canonical_evidence:
                  canonicalSiblingSupports
                  && [7102, 7103].includes(targetShipmentId),
              })),
          };
        }
        if (
          canonicalSiblingSupports
          && sql.includes("WHERE item.id = $1 AND item.shipment_id = $2")
        ) {
          const item = items.get(Number(params[0]));
          return {
            rows: item && item.shipmentId === Number(params[1])
              ? [{ id: item.id, has_canonical_evidence: false }]
              : [],
          };
        }
        if (sql.includes("AS has_canonical_evidence")) {
          return { rows: [{ has_canonical_evidence: false }] };
        }
        if (
          sql.includes("FROM wms.outbound_shipments AS shipment") &&
          sql.includes("shipment.tracking_number = $2") &&
          sql.includes("shipment.id <> $3")
        ) {
          return {
            rows: [...shipments.values()]
              .filter(
                (shipment) =>
                  shipment.orderId === Number(params[0]) &&
                  shipment.status === "shipped" &&
                  shipment.tracking === String(params[1]) &&
                  shipment.id !== Number(params[2]),
              )
              .map((shipment) => ({ id: shipment.id })),
          };
        }
        if (
          sql.includes("UPDATE wms.outbound_shipments AS shipment") &&
          sql.includes("SET status = 'shipped'")
        ) {
          const shipment = shipments.get(Number(params[0]));
          const expectedTracking = params[13] == null ? null : String(params[13]);
          const trackingCollision = [...shipments.values()].some(
            (candidate) =>
              candidate.id !== shipment?.id &&
              candidate.orderId === shipment?.orderId &&
              candidate.status === "shipped" &&
              candidate.tracking === String(params[3]),
          );
          if (
            !shipment ||
            trackingCollision ||
            shipment.orderId !== Number(params[10]) ||
            shipment.externalId !== String(params[11]) ||
            shipment.status !== String(params[12]) ||
            shipment.tracking !== expectedTracking
          ) {
            return { rows: [] };
          }
          shipment.status = "shipped";
          shipment.tracking = String(params[3]);
          return {
            rows: [{
              id: shipment.id,
              order_id: shipment.orderId,
              status: shipment.status,
              external_fulfillment_id: shipment.externalId,
              tracking_number: shipment.tracking,
            }],
          };
        }
        if (
          sql.includes("WHERE id = $1 AND order_id = $2 AND status = 'shipped'")
        ) {
          const shipment = shipments.get(Number(params[0]));
          if (
            !shipment ||
            shipment.status !== "shipped" ||
            shipment.orderId !== Number(params[1]) ||
            shipment.tracking !== String(params[2])
          )
            return { rows: [] };
          return {
            rows: [
              {
                id: shipment.id,
                order_id: shipment.orderId,
                status: shipment.status,
                external_fulfillment_id: shipment.externalId,
                tracking_number: shipment.tracking,
              },
            ],
          };
        }
        if (
          sql.includes("SELECT order_item_id, replacement_for_order_item_id")
        ) {
          return { rows: membershipRows(Number(params[0])) };
        }
        if (sql.includes("SET external_fulfillment_id = $2,")) {
          const shipment = shipments.get(Number(params[0]))!;
          if (
            shipment.externalId !== String(params[2]) ||
            !["voided", "cancelled"].includes(shipment.status)
          )
            return { rows: [] };
          shipment.externalId = String(params[1]);
          return { rows: [{ id: shipment.id }] };
        }
        if (sql.includes("SET external_fulfillment_id = COALESCE")) {
          const shipment = shipments.get(Number(params[0]))!;
          shipment.externalId ??= String(params[1]);
          return { rows: [] };
        }
        if (
          sql.includes("LIMIT 1") &&
          sql.includes("FROM wms.outbound_shipment_items")
        ) {
          const archiveShipmentId = Number(params[0]);
          const orderItemId = Number(params[1]);
          const collision = [...items.values()].find(
            (item) =>
              item.shipmentId === archiveShipmentId &&
              item.orderItemId === orderItemId,
          );
          return { rows: collision ? [{ id: collision.id }] : [] };
        }
        if (sql.includes("SET shipment_id = $2, qty = $3")) {
          const item = items.get(Number(params[0]))!;
          if (
            item.shipmentId !== Number(params[4]) ||
            item.quantity !== Number(params[5])
          ) {
            return { rows: [] };
          }
          item.shipmentId = Number(params[1]);
          item.quantity = Number(params[2]);
          item.trackingId = String(params[3]);
          return { rows: [{ id: item.id }] };
        }
        if (
          sql.includes("SET shipment_id = $2") &&
          sql.includes("WHERE id = $1 AND shipment_id = $3")
        ) {
          const item = items.get(Number(params[0]))!;
          if (item.shipmentId !== Number(params[2])) return { rows: [] };
          item.shipmentId = Number(params[1]);
          return { rows: [{ id: item.id }] };
        }
        if (sql.includes("SET qty = $2, tracking_id = $3")) {
          const item = items.get(Number(params[0]))!;
          item.quantity = Number(params[1]);
          item.trackingId = String(params[2]);
          return { rows: [] };
        }
        if (
          sql.includes("SET status = 'cancelled'") &&
          sql.includes("historical_aggregate_repartitioned")
        ) {
          const sourceShipmentIds = params[0] as number[];
          const targetShipmentIds = new Set(params[1] as number[]);
          for (const shipmentId of sourceShipmentIds) {
            const shipment = shipments.get(shipmentId);
            if (
              shipment &&
              !targetShipmentIds.has(shipmentId) &&
              shipment.status === "shipped" &&
              ![...items.values()].some((item) => item.shipmentId === shipmentId)
            ) {
              shipment.status = "cancelled";
            }
          }
          return { rows: [] };
        }
        if (sql.includes("INSERT INTO wms.outbound_shipment_items")) {
          throw new Error("Exact persisted targets must not be copied again");
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      }),
      release: vi.fn(),
    };
    const repository = createHistoricalShipStationSplitRepairRepository({
      connect: vi.fn(async () => client),
    } as any);
    const plans = partialResumePlans();
    const canonicalSupports = canonicalSiblingSupports
      ? plans.slice(1).map((plan, index) => Object.freeze({
          packagePlan: plan,
          applied: Object.freeze({
            providerShipmentId:
              plan.providerPackage.providerShipmentId,
            legacyWmsShipmentIds: Object.freeze([7102 + index]),
            wmsOrderIds: Object.freeze([8001]),
          }),
          materialized: Object.freeze({
            physicalShipmentId: 6002 + index,
            channelCommandCount: 1,
          }),
        }))
      : Object.freeze([]);
    const result = await repository.applyComponent(
      {
        componentKey: "partial-resume",
        packages: canonicalSiblingSupports ? [plans[0]] : plans,
        canonicalSupports,
      },
      {
        runId: "run-1",
        operator: "owner@cardshellz.com",
        reason: "repair exact historical split targets",
        idempotencyKey: "partial-resume-1",
        occurredAt: new Date("2026-07-31T12:00:00.000Z"),
      },
    );

    const expectedApplied = [
      {
        providerShipmentId: 442730042,
        legacyWmsShipmentIds: [recoverProviderState ? 7101 : 7001],
        wmsOrderIds: [8001],
      },
    ];
    if (!canonicalSiblingSupports) expectedApplied.push(
      {
        providerShipmentId: 442730043,
        legacyWmsShipmentIds: [7102],
        wmsOrderIds: [8001],
      },
      {
        providerShipmentId: 442730044,
        legacyWmsShipmentIds: [7103],
        wmsOrderIds: [8001],
      },
    );
    expect(result).toEqual(expectedApplied);
    if (recoverProviderState) {
      expect(shipments.get(7001)?.externalId).toBeNull();
      expect(shipments.get(7101)).toMatchObject({
        status: "shipped",
        externalId: "shipstation_shipment:442730042",
        tracking: "TRACK-A",
      });
      expect(shipments.get(7200)).toMatchObject({
        orderId: 8001,
        status: "cancelled",
        externalId: "historical_split_duplicate_archive:order:8001",
        tracking: "",
      });
    } else if (preexistingArchive) {
      expect(shipments.get(7001)?.externalId).toBe(
        "shipstation_shipment:442730042",
      );
      expect(shipments.get(7101)?.externalId).toBe(
        "historical_retired:shipstation:442730042:shipment:7101",
      );
    } else {
      expect(shipments.get(7001)?.externalId).toBe(
        "shipstation_shipment:442730042",
      );
      expect(shipments.get(7200)).toMatchObject({
        orderId: 8001,
        status: "cancelled",
        externalId: "historical_split_duplicate_archive:order:8001",
        tracking: "",
      });
    }
    expect(items.get(9001)).toMatchObject({
      shipmentId: recoverProviderState ? 7101 : 7001,
      quantity: 1,
      trackingId: "442730042",
    });
    if (canonicalSiblingSupports) {
      expect(items.get(9002)).toMatchObject({
        shipmentId: 7200,
        quantity: 2,
      });
      expect(items.get(9201)).toMatchObject({
        shipmentId: 7102,
        quantity: 1,
      });
      expect(items.get(9301)).toMatchObject({
        shipmentId: 7103,
        quantity: 1,
      });
      expect(shipments.get(7001)?.status).toBe("cancelled");
    } else {
      expect(items.get(9002)).toMatchObject({
        shipmentId: 7102,
        quantity: 1,
        trackingId: "442730043",
      });
      expect(items.get(9201)).toMatchObject({
        shipmentId: preexistingArchive && !recoverProviderState ? 7101 : 7200,
        quantity: 1,
      });
      expect(items.get(9301)).toMatchObject({
        shipmentId: 7103,
        quantity: 1,
        trackingId: "442730044",
      });
    }
    if (recoverProviderState) {
      expect(items.get(9101)).toMatchObject({
        shipmentId: 7200,
        quantity: 1,
      });
    }
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  it("types every audit parameter before finalizing mapped packages", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("UPDATE oms.webhook_retry_queue")) return { rows: [{ id: 115755 }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const repository = createHistoricalShipStationSplitRepairRepository({
      connect: vi.fn(async () => client),
    } as any);
    await repository.finalizeMappedPackage({
      providerShipmentId: 442730042,
      legacyWmsShipmentIds: [7101],
      wmsOrderIds: [8001],
    }, packagePlan(), {
      providerLabelLinkCount: 1,
      dispatchEvidence: "not_confirmed",
      dispatchCommandCreated: false,
      trackingHydrationError: null,
    }, {
      runId: "run-1",
      operator: "owner@cardshellz.com",
      reason: "resume production repair",
      idempotencyKey: "resume-1",
      occurredAt: new Date("2026-07-31T12:00:00.000Z"),
    });
    const sql = client.query.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("next_retry_at = $3::timestamptz");
    expect(sql).toContain("'providerShipmentId', $2::bigint");
    expect(sql).toContain("'runId', $2::text, 'providerShipmentId', $1::bigint");
    expect(sql).toContain("'physicalShipmentId', $3::bigint");
    expect(sql).toContain("'runId', $2::text, 'providerShipmentId', $3::bigint");
    expect(sql).toContain("'physicalShipmentId', $4::bigint");
    expect(sql).toContain("'idempotencyKey', $8::text");
    expect(sql).toContain("$9::timestamptz");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
  it("blocks a rerun when canonical source lineage has no exact persisted target", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM wms.physical_shipments AS physical")) return { rows: [] };
      if (sql.includes("LEFT JOIN wms.effective_physical_shipment_items AS physical_item")) {
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
  it("resumes persisted targets only through exact membership and audited partial allocation", () => {
    expect(source).toContain("loadExactExistingTargets");
    expect(source).toContain("exactTargetMembership");
    expect(source).toContain("applySourceAllocationsWithPersistedTargets");
    expect(source).toContain("TARGET_RETIRED_DUPLICATE_CANONICAL_EVIDENCE");
    expect(source).toContain("PERSISTED_TARGETS_CONSUME_SOURCE_QUANTITY");
    expect(source).not.toContain("PARTIAL_COMPONENT_RESUME_AMBIGUOUS");
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
