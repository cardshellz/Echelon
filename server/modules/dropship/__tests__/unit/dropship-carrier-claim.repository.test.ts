import type { Pool, PoolClient, QueryResult } from "pg";
import { describe, expect, it } from "vitest";
import { PgDropshipCarrierClaimRepository } from "../../infrastructure/dropship-carrier-claim.repository";

const now = new Date("2026-07-11T12:00:00.000Z");

describe("PgDropshipCarrierClaimRepository", () => {
  it("creates allocation and claim snapshots atomically from authoritative rows", async () => {
    const client = new HappyClaimClient();
    const repository = new PgDropshipCarrierClaimRepository(poolFor(client));

    const result = await repository.createClaim({
      wmsShipmentId: 501,
      eventType: "loss",
      occurredAt: now,
      rmaId: null,
      externalClaimId: "UPS-CLAIM-1",
      notes: "Package confirmed lost.",
      idempotencyKey: "carrier-claim-repo-001",
      requestHash: "a".repeat(64),
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    });

    expect(result.idempotentReplay).toBe(false);
    expect(result.record).toMatchObject({
      claimId: 9,
      wmsShipmentId: 501,
      currency: "USD",
      wholesaleCostSnapshotCents: 400,
      shippingChargeSnapshotCents: 1200,
      calculatedCreditCents: 1600,
    });
    expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_shipment_shipping_allocations"))).toBe(true);
    expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_carrier_claims"))).toBe(true);
    expect(client.queries.find((query) => query.includes("WHERE os.order_id = $1"))).not.toContain("EXISTS");
    expect(client.queries.at(-1)).toBe("COMMIT");
    expect(client.released).toBe(true);
  });

  it("rolls back when persisted allocation amounts do not match the deterministic plan", async () => {
    const client = new HappyClaimClient({ allocated_shipping_charge_cents: 1199 });
    const repository = new PgDropshipCarrierClaimRepository(poolFor(client));

    await expect(repository.createClaim({
      wmsShipmentId: 501,
      eventType: "loss",
      occurredAt: now,
      rmaId: null,
      externalClaimId: "UPS-CLAIM-2",
      notes: null,
      idempotencyKey: "carrier-claim-repo-002",
      requestHash: "b".repeat(64),
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    })).rejects.toMatchObject({ code: "DROPSHIP_CARRIER_CLAIM_ALLOCATION_STALE" });

    expect(client.queries.at(-1)).toBe("ROLLBACK");
    expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_carrier_claims"))).toBe(false);
  });

  it("rolls back the claim when its immutable audit event is not written", async () => {
    const client = new HappyClaimClient({}, 0);
    const repository = new PgDropshipCarrierClaimRepository(poolFor(client));

    await expect(repository.createClaim({
      wmsShipmentId: 501,
      eventType: "loss",
      occurredAt: now,
      rmaId: null,
      externalClaimId: "UPS-CLAIM-3",
      notes: null,
      idempotencyKey: "carrier-claim-repo-003",
      requestHash: "c".repeat(64),
      actor: { actorType: "admin", actorId: "admin-1" },
      now,
    })).rejects.toMatchObject({ code: "DROPSHIP_CARRIER_CLAIM_WRITE_INCOMPLETE" });

    expect(client.queries.some((query) => query.includes("INSERT INTO dropship.dropship_carrier_claims"))).toBe(true);
    expect(client.queries.at(-1)).toBe("ROLLBACK");
  });
});

class HappyClaimClient {
  readonly queries: string[] = [];
  released = false;
  private allocationReads = 0;
  private allocationGroupHash = "";

  constructor(
    private readonly allocationOverrides: Record<string, unknown> = {},
    private readonly auditRowCount = 1,
  ) {}

  async query<T>(sql: string, values?: unknown[]): Promise<QueryResult<T>> {
    const normalized = sql.trim();
    this.queries.push(normalized);

    if (normalized.includes("INSERT INTO dropship.dropship_admin_config_commands")) return result([{ id: 50 } as T]);
    if (normalized.includes("WHERE os.id = $1")) return result([shipmentRow() as T]);
    if (normalized.includes("FROM dropship.dropship_order_intake i")) return result([economicsRow() as T]);
    if (normalized.includes("FROM wms.outbound_shipment_items osi") && normalized.includes("GROUP BY osi.product_variant_id")) {
      return result([{ product_variant_id: 101, quantity: 1 } as T]);
    }
    if (normalized.includes("WHERE a.is_active = true")) return result([assignmentRow() as T]);
    if (normalized.includes("FROM dropship.dropship_carrier_protection_policies WHERE id")) return result([policyRow() as T]);
    if (normalized.includes("WHERE os.order_id = $1")) return result([shipmentRow() as T]);
    if (normalized.includes("INSERT INTO dropship.dropship_shipment_shipping_allocations")) {
      this.allocationGroupHash = String(values?.[11] ?? "");
      return writeResult(1);
    }
    if (normalized.includes("SELECT * FROM dropship.dropship_shipment_shipping_allocations")) {
      this.allocationReads += 1;
      return this.allocationReads === 1
        ? result([])
        : result([allocationRow(this.allocationGroupHash, this.allocationOverrides) as T]);
    }
    if (normalized.includes("INSERT INTO dropship.dropship_carrier_claims")) return result([claimRow() as T]);
    if (normalized.includes("UPDATE dropship.dropship_admin_config_commands")) return writeResult(1);
    if (normalized.includes("INSERT INTO dropship.dropship_audit_events")) return writeResult(this.auditRowCount);
    return result([]);
  }

  release(): void { this.released = true; }
}

function shipmentRow(): Record<string, unknown> {
  return {
    id: 501,
    order_id: 42,
    status: "shipped",
    carrier: "UPS",
    service_code: "ups_ground",
    tracking_number: "1ZTEST",
    shipped_at: new Date("2026-07-01T12:00:00.000Z"),
    carrier_cost_cents: 599,
    carrier_cost_source: "shipstation_ship_notify",
    carrier_cost_recorded_at: new Date("2026-07-01T12:01:00.000Z"),
    warehouse_status: "shipped",
    oms_fulfillment_order_id: "7001",
  };
}

function economicsRow(): Record<string, unknown> {
  return {
    intake_id: 21,
    vendor_id: 31,
    store_connection_id: 41,
    channel_id: 103,
    oms_order_id: 7001,
    economics_snapshot_id: 61,
    warehouse_id: 1,
    currency: "USD",
    shipping_cents: 1200,
    pricing_snapshot: {
      wholesale: { lines: [{ productVariantId: 101, quantity: 1, wholesaleUnitCostCents: 400 }] },
    },
    quote_payload: { destination: { country: "US", region: "PA" } },
  };
}

function assignmentRow(): Record<string, unknown> {
  return {
    id: 71,
    policy_id: 81,
    policy_name: "Standard",
    policy_version: 1,
    name: "Default",
    priority: 0,
    channel_id: null,
    channel_name: null,
    warehouse_id: null,
    warehouse_name: null,
    carrier: null,
    service: null,
    destination_country: null,
    destination_region: null,
    min_shipment_value_cents: null,
    max_shipment_value_cents: null,
    is_default: true,
    is_active: true,
    created_by: "admin-1",
    created_at: now,
    deactivated_at: null,
  };
}

function policyRow(): Record<string, unknown> {
  return {
    id: 81,
    policy_key: "STANDARD",
    version: 1,
    supersedes_policy_id: null,
    name: "Standard",
    status: "active",
    covered_loss: true,
    covered_misdelivery: true,
    covered_damage: true,
    merchandise_reimbursement_bps: 10000,
    shipping_reimbursement_bps: 10000,
    deductible_cents: 0,
    max_credit_cents: null,
    loss_wait_days: 7,
    misdelivery_wait_days: 2,
    damage_inspection_required: true,
    payout_trigger: "internal_approval",
    carrier_claim_required: true,
    approval_mode: "manual",
    automatic_approval_limit_cents: null,
    effective_from: new Date("2026-01-01T00:00:00.000Z"),
    effective_to: null,
    created_by: "admin-1",
    created_at: now,
    retired_at: null,
  };
}

function allocationRow(
  allocationGroupHash: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 91,
    intake_id: 21,
    economics_snapshot_id: 61,
    oms_order_id: 7001,
    wms_order_id: 42,
    wms_shipment_id: 501,
    currency: "USD",
    order_shipping_charge_cents: 1200,
    shipment_carrier_cost_cents: 599,
    total_carrier_cost_cents: 599,
    allocated_shipping_charge_cents: 1200,
    allocation_method: "single_shipment_full_charge_v1",
    allocation_group_hash: allocationGroupHash,
    source_snapshot: {},
    ...overrides,
  };
}

function claimRow(): Record<string, unknown> {
  return {
    id: 9,
    intake_id: 21,
    wms_shipment_id: 501,
    event_type: "loss",
    status: "pending_approval",
    policy_id: 81,
    carrier_protection_assignment_id: 71,
    shipping_allocation_id: 91,
    currency: "USD",
    carrier: "UPS",
    tracking_number: "1ZTEST",
    external_claim_id: "UPS-CLAIM-1",
    wholesale_cost_snapshot_cents: 400,
    shipping_charge_snapshot_cents: 1200,
    calculated_credit_cents: 1600,
    approved_credit_cents: null,
    occurred_at: now,
    eligible_at: new Date("2026-07-08T12:00:00.000Z"),
    created_at: now,
  };
}

function poolFor(client: HappyClaimClient): Pool {
  return { connect: async () => client as unknown as PoolClient } as unknown as Pool;
}

function result<T>(rows: T[]): QueryResult<T> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

function writeResult<T>(rowCount: number): QueryResult<T> {
  return { command: "INSERT", rowCount, oid: 0, fields: [], rows: [] };
}
