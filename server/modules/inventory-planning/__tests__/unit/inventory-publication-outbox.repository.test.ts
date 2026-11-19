import { describe, expect, it, vi } from "vitest";

import {
  PostgresInventoryPublicationOutboxRepository,
  type ClaimedInventoryPublication,
} from "../../infrastructure/inventory-publication-outbox.repository";

const NOW = new Date("2026-09-04T16:00:00.000Z");

describe("PostgresInventoryPublicationOutboxRepository full publication phase", () => {
  it("holds the target/variant advisory lock while the provider operation runs", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("AS newer_exists")) {
        return { rows: [{ state: "leased", lease_token: "lease-runtime", newer_exists: false }] };
      }
      if (sql.includes("AS unlocked")) return { rows: [{ unlocked: true }] };
      return { rows: [] };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));
    const work = vi.fn(async () => {
      expect(client.queries[0].sql).toContain("pg_advisory_lock");
      expect(client.queries.some(({ sql }) => sql.includes("pg_advisory_unlock"))).toBe(false);
      return "published";
    });

    await expect(repository.runIfCurrent(claim(), work)).resolves.toEqual({
      status: "current",
      value: "published",
    });
    expect(work).toHaveBeenCalledOnce();
    expect(client.queries.at(-1)?.sql).toContain("pg_advisory_unlock");
  });

  it("records and skips a stale claim before any provider operation", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("AS newer_exists")) {
        return { rows: [{ state: "superseded", lease_token: null, newer_exists: true }] };
      }
      if (sql.includes("AS unlocked")) return { rows: [{ unlocked: true }] };
      return { rows: [], rowCount: 1 };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));
    const work = vi.fn();

    await expect(repository.runIfCurrent(claim(), work)).resolves.toEqual({
      status: "superseded",
    });
    expect(work).not.toHaveBeenCalled();
    expect(client.queries.some(({ sql, values }) =>
      values?.includes("SUPERSEDED_BEFORE_PROVIDER_WRITE")
      && sql.includes("inventory_publication_attempts"))).toBe(true);
    expect(client.queries.map(({ sql }) => sql)).toEqual([
      expect.stringContaining("pg_advisory_lock"),
      expect.stringContaining("AS newer_exists"),
      "BEGIN",
      expect.stringContaining("inventory_publication_attempts"),
      "COMMIT",
      expect.stringContaining("pg_advisory_unlock"),
    ]);
  });

  it("atomically records and transitions a stale claim while its lease is still owned", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("AS newer_exists")) {
        return { rows: [{ state: "leased", lease_token: "lease-runtime", newer_exists: true }] };
      }
      if (sql.includes("AS unlocked")) return { rows: [{ unlocked: true }] };
      return { rows: [], rowCount: 1 };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));

    await expect(repository.runIfCurrent(claim(), vi.fn())).resolves.toEqual({
      status: "superseded",
    });
    const transition = client.queries.find(({ sql, values }) =>
      sql.includes("UPDATE inventory.inventory_publication_outbox")
      && values?.includes("SUPERSEDED_BEFORE_PROVIDER_WRITE"));
    expect(transition?.values).toEqual(["41", "lease-runtime", "SUPERSEDED_BEFORE_PROVIDER_WRITE",
      "A newer desired revision exists; no provider request was made."]);
    expect(client.queries.map(({ sql }) => sql)).toContain("COMMIT");
  });

  it("rejects a pool that cannot preserve the provider lock during durable recording", () => {
    expect(() => new PostgresInventoryPublicationOutboxRepository({
      connect: vi.fn(),
      options: { max: 1 },
    } as never)).toThrowError(expect.objectContaining({
      code: "PUBLICATION_POOL_CAPACITY_INVALID",
    }));
  });

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
    expect(claimSql).toContain("global_control.singleton_key = TRUE");
    expect(claimSql).toContain("global_control.global_enabled = TRUE");
    expect(claimSql).toContain("target.revision = outbox.publication_target_revision_snapshot");
    expect(claimSql).toContain("target.destination_kind = outbox.destination_kind_snapshot");
    expect(claimSql).toContain("target.channel_connection_id IS NOT DISTINCT FROM outbox.channel_connection_id_snapshot");
    expect(claimSql).toContain("target.dropship_store_connection_id IS NOT DISTINCT FROM outbox.dropship_store_connection_id_snapshot");
    expect(claimSql).toContain("target.external_scope_id = outbox.external_scope_id_snapshot");
    expect(claimSql).toContain("target.state = 'live'");
  });

  it("requeues a leased row without consuming an attempt when the global stop wins admission", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("SELECT * FROM inventory.inventory_publication_outbox")) {
        return { rows: [{ id: "41" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const log = { error: vi.fn() };
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client), log);

    await expect(repository.recordFailure(claim(), {
      errorClass: "PUBLICATION_GLOBAL_STOP_ACTIVE",
      errorMessage: "Global publication stopped before provider I/O.",
      retryable: true,
      completedAt: NOW,
    })).resolves.toBe(true);

    const requeue = client.queries.find(({ sql }) =>
      sql.includes("attempt_count = GREATEST(attempt_count - 1, 0)"));
    expect(requeue?.values).toEqual([
      "41",
      "lease-runtime",
      "PUBLICATION_GLOBAL_STOP_ACTIVE",
      "Global publication stopped before provider I/O.",
      NOW.toISOString(),
    ]);
    expect(client.queries.some(({ sql }) =>
      sql.includes("INSERT INTO inventory.inventory_publication_attempts"))).toBe(false);
    expect(log.error).not.toHaveBeenCalled();
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
      if (sql.includes("SELECT TRUE AS valid")) return { rows: [{ valid: true }] };
      return { rows: [] };
    });
    const log = { error: vi.fn() };
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client), log);

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
    expect(log.error).not.toHaveBeenCalled();
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
    const log = { error: vi.fn() };
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client), log);

    await expect(repository.recordFailure({ ...claim(), publicationPhase: "conservative" }, {
      errorClass: "PROVIDER_TEMPORARY_FAILURE",
      errorMessage: "This row cannot retry after its activation batch failed",
      retryable: true,
      completedAt: NOW,
    })).resolves.toBe(true);

    const failureUpdate = client.queries.find(({ sql }) =>
      sql.includes("last_error_class = $4") && sql.includes("last_error_message = $5"));
    expect(failureUpdate?.values?.[2]).toBe("cancelled");
    // A cancelled row is not a dead letter: nothing is logged for a person.
    expect(log.error).not.toHaveBeenCalled();
    // Failure/result persistence no longer closes the run under a provider lock.
    expect(client.queries.some(({ sql }) => sql.includes("SET state = 'failed'"))).toBe(false);
    expect(client.queries.some(({ sql }) => sql.includes("availability_activation_freezes"))).toBe(false);
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
      if (sql.includes("SELECT TRUE AS valid")) return { rows: [{ valid: true }] };
      return { rows: [] };
    });
    const log = { error: vi.fn() };
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client), log);

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
    expect(log.error).toHaveBeenCalledExactlyOnceWith("inventory_publication.outbox.dead_lettered",
      expect.objectContaining({ error_code: "PUBLICATION_IDENTITY_INVALID", error_class: "permanent" }));
  });

  // Channels PR1: a dead letter needs a person, so it is logged once at ERROR with
  // its correlation ids, and only after its transaction committed.
  describe("dead-letter log line", () => {
    const activeRun = (sql: string): QueryResponse => {
      if (sql.includes("SELECT * FROM inventory.inventory_publication_outbox")) return { rows: [{ id: "41" }] };
      if (sql.includes("SELECT state FROM inventory.availability_activation_runs")) return { rows: [{ state: "active" }] };
      if (sql.includes("SELECT state, reason FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "active", reason: "Activated after verification" }] };
      }
      if (sql.includes("SELECT TRUE AS valid")) return { rows: [{ valid: true }] };
      return { rows: [] };
    };
    const refused = { errorClass: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND", errorMessage: "Shopify API POST /inventory_levels/set.json failed (404)",
      retryable: false, completedAt: NOW };

    it("logs a permanent refusal once, after commit, with every correlation id", async () => {
      const client = fakeClient(activeRun);
      const log = { error: vi.fn(() => {
        // The line describes durable state: COMMIT has already run.
        expect(client.queries.at(-1)?.sql).toBe("COMMIT");
      }) };
      const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client), log);
      await expect(repository.recordFailure(claim(), refused)).resolves.toBe(true);
      expect(log.error).toHaveBeenCalledExactlyOnceWith("inventory_publication.outbox.dead_lettered", {
        outcome: "dead_letter", error_code: "SHOPIFY_INVENTORY_ITEM_NOT_FOUND", error_class: "permanent",
        dead_letter_reason: "non_retryable", error_message: "Shopify API POST /inventory_levels/set.json failed (404)",
        before: { state: "leased", attempt_number: 1 }, after: { state: "dead_letter" },
        outbox_id: "41", activation_run_id: "12", publication_phase: "full", publication_target_id: 9, product_variant_id: 101,
        desired_revision: "2", desired_quantity: "7", channel_id: 3, destination_kind: "channel_connection",
        channel_connection_id: 33, dropship_store_connection_id: null, provider_key: "shopify", provider_scope_type: "location",
        external_scope_id: "location-9", external_inventory_item_id: "inventory-item-101", external_sku: "SKU-101",
      });
    });

    it("logs a retryable failure that reached the attempt cap as permanent, with the exhausted reason", async () => {
      const log = { error: vi.fn() };
      const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(fakeClient(activeRun)), log);
      await repository.recordFailure({ ...claim(), attemptNumber: 10 }, { ...refused, errorClass: "PROVIDER_PUBLICATION_REJECTED", retryable: true });
      // A dead letter is never retried: error_class stays in the platform's transient | permanent | fatal vocabulary.
      expect(log.error).toHaveBeenCalledExactlyOnceWith("inventory_publication.outbox.dead_lettered", expect.objectContaining({
        error_code: "PROVIDER_PUBLICATION_REJECTED", error_class: "permanent", dead_letter_reason: "attempts_exhausted",
        before: { state: "leased", attempt_number: 10 } }));
    });

    it("does not log a retry, a lost lease or a failure that rolled back", async () => {
      const log = { error: vi.fn() };
      await new PostgresInventoryPublicationOutboxRepository(fakePool(fakeClient(activeRun)), log)
        .recordFailure(claim(), { ...refused, retryable: true });
      const lostLease = fakeClient(sql => sql.includes("SELECT * FROM inventory.inventory_publication_outbox") ? { rows: [] } : activeRun(sql));
      await expect(new PostgresInventoryPublicationOutboxRepository(fakePool(lostLease), log).recordFailure(claim(), refused)).resolves.toBe(false);
      const brokenCommit = fakeClient(sql => {
        if (sql === "COMMIT") throw new Error("commit failed");
        return activeRun(sql);
      });
      await expect(new PostgresInventoryPublicationOutboxRepository(fakePool(brokenCommit), log).recordFailure(claim(), refused))
        .rejects.toThrow("commit failed");
      expect(log.error).not.toHaveBeenCalled();
    });
  });

  it("requeues a full publication after readback drift while the run remains active", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("SELECT * FROM inventory.inventory_publication_outbox")) {
        return { rows: [{ id: "41" }] };
      }
      if (sql.includes("SELECT state FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "active" }] };
      }
      if (sql.includes("SELECT TRUE AS valid")) return { rows: [{ valid: true }] };
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

  it("records readback evidence against the exact Dropship owner snapshot", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("SELECT * FROM inventory.inventory_publication_outbox")) {
        return { rows: [{ id: "41" }] };
      }
      if (sql.includes("SELECT state FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "active" }] };
      }
      if (sql.includes("SELECT state, reason FROM inventory.availability_activation_runs")) {
        return { rows: [{ state: "active", reason: "Activated" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));
    const dropshipClaim: ClaimedInventoryPublication = {
      ...claim(),
      destinationKind: "dropship_store_connection",
      channelConnectionId: null,
      dropshipStoreConnectionId: 77,
      providerKey: "ebay",
      providerScopeType: "account",
      externalScopeId: "seller-account-1",
    };

    await expect(repository.recordVerified(dropshipClaim, {
      observedQuantity: 7,
      providerResponse: { status: 200 },
      completedAt: NOW,
    })).resolves.toBe("verified");

    const readbackInsert = client.queries.find(({ sql }) =>
      sql.includes("INSERT INTO inventory.inventory_publication_readbacks"));
    expect(readbackInsert?.values?.slice(7, 10)).toEqual([
      "dropship_store_connection",
      null,
      77,
    ]);
  });

  it("queues another canonical write when provider surfaces disagree despite scalar equality", async () => {
    const client = fakeClient(sql => {
      if (sql.includes("SELECT * FROM inventory.inventory_publication_outbox")) return { rows: [{ id: "41" }] };
      if (sql.includes("SELECT TRUE AS valid")) return { rows: [{ valid: true }] };
      if (sql.includes("SELECT state")) return { rows: [{ state: "active", reason: "Activated" }] };
      return { rows: [], rowCount: 1 };
    });
    const repository = new PostgresInventoryPublicationOutboxRepository(fakePool(client));
    await expect(repository.recordVerified(claim(), { observedQuantity: 7, quantityConsistent: false,
      providerResponse: { item: 8, offer: 7 }, completedAt: NOW })).resolves.toBe("drifted");
    const readback = client.queries.find(({ sql }) => sql.includes("INSERT INTO inventory.inventory_publication_readbacks"));
    expect(readback?.values?.[4]).toBe(false);
    expect(client.queries.some(({ sql }) => sql.includes("state = 'queued'") && sql.includes("PROVIDER_READBACK_MISMATCH"))).toBe(true);
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
    destinationKind: "channel_connection",
    channelConnectionId: 33,
    dropshipStoreConnectionId: null,
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
    destination_kind_snapshot: value.destinationKind,
    channel_connection_id_snapshot: value.channelConnectionId,
    dropship_store_connection_id_snapshot: value.dropshipStoreConnectionId,
    provider_key_snapshot: value.providerKey,
    provider_scope_type_snapshot: value.providerScopeType,
    external_scope_id_snapshot: value.externalScopeId,
    external_inventory_item_id_snapshot: value.externalInventoryItemId,
    external_sku_snapshot: value.externalSku,
    lease_token: value.leaseToken,
    attempt_count: value.attemptNumber,
  };
}
