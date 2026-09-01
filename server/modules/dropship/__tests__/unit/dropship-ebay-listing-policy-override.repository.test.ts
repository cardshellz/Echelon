import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { ReplaceDropshipEbayListingPolicyOverrideRepositoryInput } from "../../application/dropship-ebay-listing-policy-override-service";
import { PgDropshipEbayListingPolicyOverrideRepository } from "../../infrastructure/dropship-ebay-listing-policy-override.repository";

const NOW = new Date("2026-09-01T15:00:00.000Z");

describe("PgDropshipEbayListingPolicyOverrideRepository", () => {
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
  release = vi.fn();

  async query<T>(query: string): Promise<{ rows: T[] }> {
    const sql = query.trim();
    this.sql.push(sql);
    if (sql.includes("FROM dropship.dropship_store_connections")) {
      return rows<T>([{ platform: "ebay", status: this.storeStatus }]);
    }
    if (sql.includes("FROM dropship.dropship_ebay_listing_policy_override_revisions")) {
      return rows<T>(this.existingRevision ? [this.existingRevision] : []);
    }
    if (sql.includes("SELECT id FROM catalog.product_variants")) {
      return rows<T>([{ id: 501 }]);
    }
    if (sql.includes("FROM dropship.dropship_ebay_listing_policy_overrides")
      && sql.includes("FOR UPDATE")) {
      return rows<T>(this.currentAssignment ? [this.currentAssignment] : []);
    }
    if (sql.includes("INSERT INTO dropship.dropship_ebay_listing_policy_override_revisions")) {
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
