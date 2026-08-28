import { describe, expect, it, vi } from "vitest";

import type { PersistActivationDryRunInput } from "../../application/inventory-availability-activation-dry-run.service";
import { PostgresInventoryAvailabilityActivationDryRunRepository } from "../../infrastructure/inventory-availability-activation-dry-run.repository";

const HASH = "a".repeat(64);
const STARTED_AT = new Date("2026-08-28T18:00:00.000Z");
const COMPLETED_AT = new Date("2026-08-28T18:00:01.000Z");

describe("Postgres inventory availability activation dry-run repository", () => {
  it("captures acknowledgement and provider readback as separate evidence", async () => {
    const client = fakeClient((sql) => {
      if (sql.includes("FROM channels.channel_feeds")) return [{
        id: 90,
        channel_id: 36,
        product_variant_id: 101,
        is_active: 1,
        channel_inventory_item_id: "inventory-item-1",
        last_synced_qty: 7,
        last_synced_at: "2026-08-28T17:00:00.000Z",
        quarantined_at: null,
      }];
      if (sql.includes("FROM inventory.inventory_publication_targets")) return [{
        id: 5,
        channel_id: 36,
        channel_connection_id: 44,
        fulfillment_node_id: 1,
        warehouse_id: 1,
        provider_scope_type: "location",
        external_scope_id: "location-1",
        publication_authority: "echelon",
        state: "preview",
      }];
      if (sql.includes("FROM inventory.inventory_publication_readbacks")) return [{
        publication_target_id: 5,
        product_variant_id: 101,
        observed_quantity: "6",
        observed_at: "2026-08-28T17:05:00.000Z",
      }];
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresInventoryAvailabilityActivationDryRunRepository(
      { connect: vi.fn(async () => client) } as never,
    );

    const [evidence] = await repository.captureCurrentPublicationEvidence([
      { channelId: 36, productVariantId: 101 },
      { channelId: 36, productVariantId: 101 },
    ]);

    expect(evidence).toMatchObject({
      mappingState: "active",
      lastAcknowledgedUnits: "7",
      configuredTargets: [{
        publicationTargetId: 5,
        channelConnectionId: 44,
        externalScopeId: "location-1",
        publicationAuthority: "echelon",
        latestReadbackUnits: "6",
      }],
    });
    expect(client.query.mock.calls[0]?.[0]).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("persists terminal dry-run evidence without enqueueing publication work", async () => {
    const input = activationInput();
    const evidencePayload = {
      summary: input.summary,
      products: input.products,
      blockers: input.blockers,
    };
    const client = fakeClient((sql) => {
      if (sql.includes("INSERT INTO inventory.availability_activation_runs")) return [{ id: "12" }];
      if (sql.includes("INSERT INTO inventory.availability_activation_product_evidence")) return [];
      if (sql.includes("INSERT INTO inventory.availability_activation_events")) return [];
      if (sql.includes("FROM inventory.availability_activation_runs")) return [{
        id: "12",
        mode: "dry_run",
        scope: "full_catalog",
        state: input.state,
        request_hash: input.requestHash,
        result_hash: input.resultHash,
        captured_catalog_input_hash: input.catalogInputHash,
        captured_catalog_result_hash: input.catalogResultHash,
        evidence_payload: evidencePayload,
        requested_by: input.requestedBy,
        reason: input.reason,
        started_at: input.startedAt,
        completed_at: input.completedAt,
        runtime_authority_changed: false,
        provider_write_attempted: false,
        outbox_enqueued: false,
      }];
      throw new Error(`Unexpected SQL: ${sql}`);
    });
    const repository = new PostgresInventoryAvailabilityActivationDryRunRepository(
      { connect: vi.fn(async () => client) } as never,
    );

    const result = await repository.persistActivationDryRun(input);

    expect(result).toMatchObject({
      activationRunId: "12",
      state: "blocked",
      providerWriteAttempted: false,
      outboxEnqueued: false,
    });
    const statements = client.query.mock.calls.map((call) => String(call[0]));
    expect(statements.some((sql) => sql.includes("inventory_publication_outbox"))).toBe(false);
    expect(statements).toEqual(expect.arrayContaining(["BEGIN", "COMMIT"]));
    const runInsert = client.query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO inventory.availability_activation_runs"));
    expect(runInsert?.[1]?.[8]).toBe(JSON.stringify(["PROVIDER_READBACK_MISSING"]));
  });
});

function fakeClient(rowsFor: (sql: string) => Record<string, any>[]) {
  const query = vi.fn(async (statement: unknown) => {
    const sql = String(statement).trim();
    if (sql === "BEGIN" || sql === "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
      || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    return { rows: rowsFor(sql) };
  });
  return { query, release: vi.fn() };
}

function activationInput(): PersistActivationDryRunInput {
  const blocker = {
    code: "PROVIDER_READBACK_MISSING",
    severity: "blocking" as const,
    message: "No provider readback.",
    productId: 10,
    context: { channelId: 36 },
  };
  return {
    requestHash: HASH,
    resultHash: HASH,
    expectedCatalogInputHash: HASH,
    expectedCatalogResultHash: HASH,
    catalogInputHash: HASH,
    catalogResultHash: HASH,
    idempotencyKey: "activation-repository-1",
    reason: "Persist inactive evidence",
    requestedBy: "operator-1",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    state: "blocked",
    summary: { totalProducts: 1, readyProducts: 0, blockedProducts: 1, publicationRows: 0 },
    products: [{
      productId: 10,
      queueState: "approved",
      status: "blocked",
      draftModelId: 501,
      draftModelVersion: 1,
      draftDefinitionHash: HASH,
      reviewId: "1",
      shadowRunId: "2",
      shadowSnapshotFingerprint: HASH,
      channelPreviewHash: HASH,
      proposedPublications: [],
      publicationEvidence: [],
      blockers: [blocker],
    }],
    blockers: [],
  };
}
