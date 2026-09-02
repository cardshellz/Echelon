import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";
import {
  InventoryAvailabilityClaimRepositoryError,
  PostgresInventoryAvailabilityClaimRepository,
} from "../../infrastructure/inventory-availability-claim.repository";

const FIXED_TIME = new Date("2026-09-02T02:00:00.000Z");

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function createPool(handler: (text: string, values: unknown[]) => Promise<any>) {
  const query = vi.fn(async (text: string, values: unknown[] = []) => handler(text, values));
  const release = vi.fn();
  return {
    pool: { connect: vi.fn(async () => ({ query, release })) } as any,
    query,
    release,
  };
}

function createInventoryWriter() {
  return {
    reserveResource: vi.fn(async () => []),
    releaseResources: vi.fn(async () => undefined),
  };
}

describe("PostgresInventoryAvailabilityClaimRepository", () => {
  it("fails closed before reading or mutating order inventory when canonical authority is inactive", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "legacy", activation_run_id: null, revision: "1" }] };
      }
      if (text === "ROLLBACK") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder({
      orderId: 41,
      idempotencyKey: "claim:41",
      actor: "test-user",
      reason: "unit test",
    })).rejects.toEqual(expect.objectContaining<Partial<InventoryAvailabilityClaimRepositoryError>>({
      code: "CANONICAL_AUTHORITY_NOT_ACTIVE",
    }));

    expect(fake.query.mock.calls.some(([text]) => String(text).includes("FROM wms.orders"))).toBe(false);
    expect(fake.query.mock.calls.some(([text]) => /^\s*(INSERT|UPDATE)\s+inventory\.inventory_/i.test(String(text)))).toBe(false);
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it("returns the persisted command result without replanning or writing on exact idempotent replay", async () => {
    const command = {
      orderId: 42,
      idempotencyKey: "claim:42",
      actor: "test-user",
      reason: "unit test",
    };
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return {
          rows: [{
            request_hash: hash(command),
            result_payload: { outcome: "no_claim_required", orderId: 42, idempotentReplay: false },
          }],
        };
      }
      if (text === "COMMIT") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder(command)).resolves.toEqual({
      outcome: "no_claim_required",
      orderId: 42,
      idempotentReplay: true,
    });
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("runtime_authority"))).toBe(false);
  });

  it("retries an idempotency-key race and returns the concurrently committed receipt", async () => {
    const command = {
      orderId: 420,
      idempotencyKey: "claim:420",
      actor: "test-user",
      reason: "concurrent retry test",
    };
    let attempt = 0;
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) {
        attempt += 1;
        return { rows: [] };
      }
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return attempt === 1
          ? { rows: [] }
          : {
              rows: [{
                request_hash: hash(command),
                result_payload: { outcome: "no_claim_required", orderId: 420, idempotentReplay: false },
              }],
            };
      }
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 420, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) return { rows: [] };
      if (text.includes("INSERT INTO inventory.availability_claim_commands")) {
        throw Object.assign(new Error("duplicate idempotency key"), {
          code: "23505",
          constraint: "availability_claim_commands_idempotency_uq",
        });
      }
      if (text === "ROLLBACK" || text === "COMMIT") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder(command)).resolves.toEqual({
      outcome: "no_claim_required",
      orderId: 420,
      idempotentReplay: true,
    });
    expect(attempt).toBe(2);
  });

  it("records an inert no-op command for a physical order with no claimable lines", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 43, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) return { rows: [] };
      if (text.includes("INSERT INTO inventory.availability_claim_commands")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder({
      orderId: 43,
      idempotencyKey: "claim:43",
      actor: "test-user",
      reason: "digital-only order",
    })).resolves.toEqual({
      outcome: "no_claim_required",
      orderId: 43,
      idempotentReplay: false,
    });
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("inventory.inventory_levels"))).toBe(false);
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("inventory.inventory_lots"))).toBe(false);
  });

  it("excludes a digital order line before requiring any catalog inventory identity", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN") || text === "COMMIT") return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 45, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) {
        return {
          rows: [{
            order_item_id: 451,
            sku: "DIGITAL-MEMBERSHIP",
            stored_product_id: null,
            order_item_requires_shipping: 0,
            target_variant_id: null,
            requested_qty: 1,
            root_product_id: null,
            is_active: null,
            requires_shipping: null,
            track_inventory: null,
            sales_eligibility: null,
          }],
        };
      }
      if (text.includes("INSERT INTO inventory.availability_claim_commands")) return { rows: [], rowCount: 1 };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder({
      orderId: 45,
      idempotencyKey: "claim:45",
      actor: "test-user",
      reason: "digital-only order",
    })).resolves.toEqual({
      outcome: "no_claim_required",
      orderId: 45,
      idempotentReplay: false,
    });
    expect(fake.query.mock.calls.some(([text]) => String(text).includes("WITH RECURSIVE graph"))).toBe(false);
  });

  it("fails closed when a stored order-item identity conflicts with its active SKU mapping", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) return { rows: [] };
      if (text.includes("FROM inventory.availability_runtime_authority")) {
        return { rows: [{ authority: "canonical", activation_run_id: "9", revision: "2" }] };
      }
      if (text.includes("FROM wms.orders")) {
        return { rows: [{ order_id: 46, warehouse_id: 1, warehouse_status: "ready" }] };
      }
      if (text.includes("FROM wms.order_items")) {
        return {
          rows: [{
            order_item_id: 461,
            sku: "P5",
            stored_product_id: 999,
            order_item_requires_shipping: 1,
            target_variant_id: 101,
            requested_qty: 1,
            root_product_id: 10,
            is_active: true,
            requires_shipping: true,
            track_inventory: true,
            sales_eligibility: "sellable",
          }],
        };
      }
      if (text === "ROLLBACK") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.claimOrder({
      orderId: 46,
      idempotencyKey: "claim:46",
      actor: "test-user",
      reason: "identity conflict test",
    })).rejects.toEqual(expect.objectContaining({ code: "ORDER_ITEM_VARIANT_IDENTITY_CONFLICT" }));
  });

  it("rejects an idempotency key reused with a different semantic request", async () => {
    const fake = createPool(async (text) => {
      if (text.startsWith("BEGIN")) return { rows: [] };
      if (text.includes("FROM inventory.availability_claim_commands")) {
        return {
          rows: [{
            request_hash: "a".repeat(64),
            result_payload: { outcome: "no_claim_required", orderId: 44, idempotentReplay: false },
          }],
        };
      }
      if (text === "ROLLBACK") return { rows: [] };
      throw new Error(`Unexpected query: ${text}`);
    });
    const repository = new PostgresInventoryAvailabilityClaimRepository(
      createInventoryWriter(),
      fake.pool,
      () => FIXED_TIME,
    );

    await expect(repository.releaseOrderClaim({
      orderId: 44,
      disposition: "cancel",
      idempotencyKey: "reused-key",
      actor: "test-user",
      reason: "unit test",
    })).rejects.toEqual(expect.objectContaining({ code: "IDEMPOTENCY_KEY_REUSED" }));
  });
});
