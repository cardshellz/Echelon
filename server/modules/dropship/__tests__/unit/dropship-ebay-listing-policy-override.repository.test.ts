import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ReplaceDropshipEbayListingPoliciesRepositoryInput, ReplaceDropshipEbayListingPolicyOverrideRepositoryInput } from "../../application/dropship-ebay-listing-policy-override-service";
import { PgDropshipEbayListingPolicyOverrideRepository } from "../../infrastructure/dropship-ebay-listing-policy-override.repository";

const NOW = new Date("2026-09-01T15:00:00.000Z");

describe("PgDropshipEbayListingPolicyOverrideRepository", () => {
  it("uses one transaction and whole-operation identity for every bulk row", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayListingPolicyOverrideRepository(poolFor(client));
    const result = await repository.replaceAssignments(bulkInput());

    expect(result.results.map((row) => row.productVariantId)).toEqual([501, 502]);
    expect(client.sql.filter((query) => query === "BEGIN")).toHaveLength(1);
    expect(client.sql.filter((query) => query === "COMMIT")).toHaveLength(1);
    expect(client.revisionInserts).toHaveLength(2);
    expect(client.revisionInserts[0].slice(0, 5)).toEqual([10, 44, 501, "bulk-repository-001", "whole-operation-hash"]);
    expect(client.revisionInserts[1][3]).toMatch(/^ebay-policy-bulk:[a-f0-9]{64}:502$/);
    expect(client.revisionInserts[1][4]).toBe("whole-operation-hash");
    expect(client.sql.filter((query) => query.includes("INSERT INTO dropship.dropship_audit_events"))).toHaveLength(2);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it("rolls back every bulk write when a later listing is stale", async () => {
    const client = new ScriptedClient();
    client.currentByVariant.set(502, { product_variant_id: 502, revision_id: 99,
      fulfillment_policy_id: "newer", return_policy_id: null, payment_policy_id: null, updated_at: NOW });
    const repository = new PgDropshipEbayListingPolicyOverrideRepository(poolFor(client));

    await expect(repository.replaceAssignments(bulkInput())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT",
      context: { productVariantId: 502, actualRevisionId: 99 },
    });
    expect(client.revisionInserts).toHaveLength(1);
    expect(client.sql.at(-1)).toBe("ROLLBACK");
    expect(client.sql).not.toContain("COMMIT");
  });

  it("rejects reuse of the bulk key with a different request", async () => {
    const client = new ScriptedClient();
    client.existingRevision = { id: 90, request_hash: "different-request" };
    const repository = new PgDropshipEbayListingPolicyOverrideRepository(poolFor(client));
    await expect(repository.replaceAssignments(bulkInput())).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_CONFLICT" });
    expect(client.revisionInserts).toHaveLength(0);
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("fails closed if only part of a bulk operation has replay evidence", async () => {
    const client = new ScriptedClient();
    client.revisionByKey.set("bulk-repository-001", {
      id: 90, request_hash: "whole-operation-hash", product_variant_id: 501,
      fulfillment_policy_id: "fulfillment-compatible", return_policy_id: null, payment_policy_id: null, created_at: NOW,
    });
    const repository = new PgDropshipEbayListingPolicyOverrideRepository(poolFor(client));
    await expect(repository.replaceAssignments(bulkInput())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_REPLAY_INCOMPLETE",
    });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("locks the connected eBay store and commits a revision, assignment, and audit event", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayListingPolicyOverrideRepository(poolFor(client));

    const result = await repository.replaceAssignment(input());

    expect(result).toEqual({
      assignment: {
        productVariantId: 501,
        revisionId: 91,
        fulfillmentPolicyId: "fulfillment-compatible",
        returnPolicyId: null,
        paymentPolicyId: null,
        updatedAt: NOW,
      },
      revisionId: 91,
      idempotentReplay: false,
    });
    expect(client.sql.some((query) => query.includes("FOR SHARE"))).toBe(true);
    expect(client.sql.some((query) => query.includes("dropship_audit_events"))).toBe(true);
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("deletes the current assignment but retains a clearing revision", async () => {
    const client = new ScriptedClient();
    const repository = new PgDropshipEbayListingPolicyOverrideRepository(poolFor(client));

    const result = await repository.replaceAssignment(input({
      fulfillmentPolicyId: null,
      returnPolicyId: null,
      paymentPolicyId: null,
    }));

    expect(result.assignment).toBeNull();
    expect(client.sql.some((query) => query.includes(
      "DELETE FROM dropship.dropship_ebay_listing_policy_overrides",
    ))).toBe(true);
    expect(client.sql.some((query) => query.includes(
      "INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions",
    ))).toBe(true);
  });

  it("returns the immutable revision snapshot for an idempotent replay", async () => {
    const client = new ScriptedClient();
    client.existingRevision = {
      id: 90,
      request_hash: "request-hash",
      product_variant_id: 501,
      fulfillment_policy_id: "fulfillment-compatible",
      return_policy_id: null,
      payment_policy_id: null,
      created_at: NOW,
    };
    const repository = new PgDropshipEbayListingPolicyOverrideRepository(poolFor(client));

    await expect(repository.replaceAssignment(input())).resolves.toMatchObject({
      revisionId: 90,
      idempotentReplay: true,
      assignment: { fulfillmentPolicyId: "fulfillment-compatible" },
    });
    expect(client.sql.at(-1)).toBe("COMMIT");
  });

  it("rolls back instead of overwriting a newer assignment revision", async () => {
    const client = new ScriptedClient();
    client.currentAssignment = {
      product_variant_id: 501,
      revision_id: 92,
      fulfillment_policy_id: "newer-policy",
      return_policy_id: null,
      payment_policy_id: null,
      updated_at: NOW,
    };
    const repository = new PgDropshipEbayListingPolicyOverrideRepository(poolFor(client));

    await expect(repository.replaceAssignment(input({
      expectedRevisionId: 90,
    }))).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_LISTING_POLICY_OVERRIDE_VERSION_CONFLICT",
      context: { expectedRevisionId: 90, actualRevisionId: 92 },
    });
    expect(client.sql.some((query) => query.includes(
      "INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions",
    ))).toBe(false);
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });

  it("rolls back if the store disconnects before persistence", async () => {
    const client = new ScriptedClient();
    client.storeStatus = "needs_reauth";
    const repository = new PgDropshipEbayListingPolicyOverrideRepository(poolFor(client));

    await expect(repository.replaceAssignment(input())).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_STORE_CONNECTION_BLOCKED",
    });
    expect(client.sql.at(-1)).toBe("ROLLBACK");
  });
});

class ScriptedClient {
  sql: string[] = [];
  storeStatus = "connected";
  existingRevision: Record<string, unknown> | null = null;
  currentAssignment: Record<string, unknown> | null = null;
  currentByVariant = new Map<number, Record<string, unknown>>();
  revisionByKey = new Map<string, Record<string, unknown>>();
  revisionInserts: unknown[][] = [];
  release = vi.fn();

  async query<T>(query: string, values: unknown[] = []): Promise<{ rows: T[] }> {
    const sql = query.trim();
    this.sql.push(sql);
    if (sql.includes("FROM dropship.dropship_store_connections")) {
      return rows<T>([{ platform: "ebay", status: this.storeStatus }]);
    }
    if (sql.includes("FROM dropship.dropship_ebay_listing_policy_override_revisions")) {
      const revision = this.revisionByKey.get(String(values[1])) ?? this.existingRevision;
      return rows<T>(revision ? [revision] : []);
    }
    if (sql.includes("SELECT id FROM catalog.product_variants")) {
      return rows<T>([{ id: 501 }]);
    }
    if (sql.includes("FROM dropship.dropship_ebay_listing_policy_overrides")
      && sql.includes("FOR UPDATE")) {
      const assignment = this.currentByVariant.get(Number(values[2])) ?? this.currentAssignment;
      return rows<T>(assignment ? [assignment] : []);
    }
    if (sql.includes("INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions")) {
      this.revisionInserts.push(values);
      return rows<T>([{ id: 91 }]);
    }
    if (sql.includes("INSERT INTO dropship.dropship_ebay_listing_policy_overrides")) {
      return rows<T>([{
        product_variant_id: 501,
        revision_id: 91,
        fulfillment_policy_id: "fulfillment-compatible",
        return_policy_id: null,
        payment_policy_id: null,
        updated_at: NOW,
      }]);
    }
    return rows<T>([]);
  }
}

function bulkInput(): ReplaceDropshipEbayListingPoliciesRepositoryInput {
  return {
    vendorId: 10, storeConnectionId: 44, idempotencyKey: "bulk-repository-001", requestHash: "whole-operation-hash",
    actor: { actorType: "vendor", actorId: "member-1" }, now: NOW,
    assignments: [502, 501].map((productVariantId) => ({ productVariantId, expectedRevisionId: null,
      fulfillmentPolicyId: "fulfillment-compatible", returnPolicyId: null, paymentPolicyId: null })),
  };
}

function rows<T>(values: unknown[]): { rows: T[] } {
  return { rows: values as T[] };
}

function poolFor(client: ScriptedClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}

function input(
  overrides: Partial<ReplaceDropshipEbayListingPolicyOverrideRepositoryInput> = {},
): ReplaceDropshipEbayListingPolicyOverrideRepositoryInput {
  return {
    vendorId: 10,
    storeConnectionId: 44,
    productVariantId: 501,
    expectedRevisionId: null,
    fulfillmentPolicyId: "fulfillment-compatible",
    returnPolicyId: null,
    paymentPolicyId: null,
    idempotencyKey: "listing-policy-repository-001",
    requestHash: "request-hash",
    actor: { actorType: "vendor", actorId: "member-1" },
    now: NOW,
    ...overrides,
  };
}
