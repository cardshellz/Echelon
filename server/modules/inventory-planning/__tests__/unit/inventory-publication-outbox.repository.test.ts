import { describe, expect, it, vi } from "vitest";

import {
  PostgresInventoryPublicationOutboxRepository,
  type ClaimedInventoryPublication,
} from "../../infrastructure/inventory-publication-outbox.repository";

const NOW = new Date("2026-09-04T16:00:00.000Z");

describe("PostgresInventoryPublicationOutboxRepository full publication phase", () => {
  it("claims full publications only through the active-run branch", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("RETURNING outbox.*")) return { rows: [claimRow()] };
      return { rows: [] };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));

    await expect(repository.claimDue({
      batchSize: 5,
      leaseSeconds: 90,
      leaseToken: "lease-runtime",
      now: NOW,
    })).resolves.toEqual([claim()]);

    const claimSql = client.queries.find(({ sql }) => sql.includes("RETURNING outbox.*"))?.sql;
    expect(claimSql).toContain("outbox.publication_phase = 'conservative' AND run.state = 'publishing'");
    expect(claimSql).toContain("outbox.publication_phase = 'full' AND run.state = 'active'");
  });

  it("retries a failed full publication while its activation run remains active", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("SELECT * FROM inventory.inventory_publication_outbox")) {
        return { rows: [{ id: "41" }] };
      }
      if (sql.includes("SELECT state FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "active" }] };
      }
      if (sql.includes("SELECT state, reason FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "active", reason: "Activated after verification" }] };
      }
      return { rows: [] };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));

    await expect(repository.recordFailure(claim(), {
      errorClass: "PROVIDER_TEMPORARY_FAILURE",
      errorMessage: "Retry later",
      retryable: true,
      completedAt: NOW,
    })).resolves.toBe(true);

    expect(client.queries.some(({ sql }) => sql.includes("state = 'queued'")
      && sql.includes("state = 'retryable'"))).toBe(true);
    expect(client.queries.some(({ sql }) => sql.includes("state = 'failed'"))).toBe(false);
    expect(client.queries.some(({ sql }) => sql.includes("state = 'dead_letter'")
      && sql.includes("SELECT EXISTS"))).toBe(false);
  });

  it("preserves the conservative activation stop rule when any row is dead-lettered", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("SELECT * FROM inventory.inventory_publication_outbox")) {
        return { rows: [{ id: "41" }] };
      }
      if (sql.includes("SELECT state FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "publishing" }] };
      }
      if (sql.includes("SELECT EXISTS") && sql.includes("state = 'dead_letter'")) {
        return { rows: [{ exists: true }] };
      }
      if (sql.includes("SELECT state, reason FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "publishing", reason: "Pre-cutover publication" }] };
      }
      if (sql.includes("count(*) FILTER")) {
        return { rows: [{ leased: "0", dead_letter: "1" }] };
      }
      if (sql.includes("SELECT id, last_error_class")) {
        return { rows: [{ id: "40", last_error_class: "PERMANENT_FAILURE" }] };
      }
      return { rows: [] };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));

    await expect(repository.recordFailure({ ...claim(), publicationPhase: "conservative" }, {
      errorClass: "PROVIDER_TEMPORARY_FAILURE",
      errorMessage: "This row cannot retry after its activation batch failed",
      retryable: true,
      completedAt: NOW,
    })).resolves.toBe(true);

    const failureUpdate = client.queries.find(({ sql }) =>
      sql.includes("last_error_class = $4") && sql.includes("last_error_message = $5"));
    expect(failureUpdate?.values?.[2]).toBe("cancelled");
    expect(client.queries.some(({ sql }) => sql.includes("SET state = 'failed'"))).toBe(true);
  });

  it("dead-letters only the failed full row instead of failing an active authority run", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("SELECT * FROM inventory.inventory_publication_outbox")) {
        return { rows: [{ id: "41" }] };
      }
      if (sql.includes("SELECT state FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "active" }] };
      }
      if (sql.includes("SELECT state, reason FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "active", reason: "Activated after verification" }] };
      }
      return { rows: [] };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));

    await expect(repository.recordFailure(claim(), {
      errorClass: "PUBLICATION_IDENTITY_INVALID",
      errorMessage: "Permanent exact-identity failure",
      retryable: false,
      completedAt: NOW,
    })).resolves.toBe(true);

    const failureUpdate = client.queries.find(({ sql }) =>
      sql.includes("last_error_class = $4") && sql.includes("last_error_message = $5"));
    expect(failureUpdate?.values?.[2]).toBe("dead_letter");
    expect(client.queries.some(({ sql }) => sql.includes("SET state = 'failed'"))).toBe(false);
  });

  it("requeues a full publication after readback drift while the run remains active", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("SELECT * FROM inventory.inventory_publication_outbox")) {
        return { rows: [{ id: "41" }] };
      }
      if (sql.includes("SELECT state FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "active" }] };
      }
      return { rows: [] };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));

    await expect(repository.recordVerified(claim(), {
      observedQuantity: 6,
      providerResponse: { observedQuantity: 6 },
      completedAt: NOW,
    })).resolves.toBe("drifted");

    expect(client.queries.some(({ sql }) => sql.includes("state = 'queued'")
      && sql.includes("PROVIDER_READBACK_MISMATCH"))).toBe(true);
    expect(client.queries.some(({ sql }) => sql.includes("state = 'cancelled'")
      && sql.includes("ACTIVATION_ABORTED_DURING_PROVIDER_WRITE"))).toBe(false);
  });
});

type QueryResponse = { rows: Record<string, unknown>[]; rowCount?: number };

function fakeClient(handler: (sql: string, values?: readonly unknown[]) => QueryResponse) {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = [];
  return {
    queries,
    query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      queries.push({ sql, values });
      return handler(sql, values);
    }),
    release: vi.fn(),
  };
}

function fakePool(client: ReturnType<typeof fakeClient>) {
  return { connect: vi.fn(async () => client) } as never;
}

function claim(): ClaimedInventoryPublication {
  return {
    outboxId: "41",
    activationRunId: "12",
    publicationPhase: "full",
    publicationTargetId: 9,
    publicationTargetRevision: "4",
    productVariantId: 101,
    desiredRevision: "2",
    desiredQuantity: "7",
    channelId: 3,
    channelConnectionId: 33,
    providerKey: "shopify",
    providerScopeType: "location",
    externalScopeId: "location-9",
    externalInventoryItemId: "inventory-item-101",
    externalSku: "SKU-101",
    leaseToken: "lease-runtime",
    attemptNumber: 1,
    attemptStartedAt: NOW,
  };
}

function claimRow(): Record<string, unknown> {
  const value = claim();
  return {
    id: value.outboxId,
    activation_run_id: value.activationRunId,
    publication_phase: value.publicationPhase,
    publication_target_id: value.publicationTargetId,
    publication_target_revision_snapshot: value.publicationTargetRevision,
    product_variant_id: value.productVariantId,
    desired_revision: value.desiredRevision,
    desired_quantity: value.desiredQuantity,
    channel_id_snapshot: value.channelId,
    channel_connection_id_snapshot: value.channelConnectionId,
    provider_key_snapshot: value.providerKey,
    provider_scope_type_snapshot: value.providerScopeType,
    external_scope_id_snapshot: value.externalScopeId,
    external_inventory_item_id_snapshot: value.externalInventoryItemId,
    external_sku_snapshot: value.externalSku,
    lease_token: value.leaseToken,
    attempt_count: value.attemptNumber,
  };
}
