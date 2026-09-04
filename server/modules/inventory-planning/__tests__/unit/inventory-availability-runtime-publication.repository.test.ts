import { describe, expect, it, vi } from "vitest";

import type { CanonicalInventoryPublicationIntent } from "../../application/inventory-availability-runtime-publication.service";
import { PostgresInventoryAvailabilityRuntimePublicationExecutor } from "../../infrastructure/inventory-availability-runtime-publication.repository";

describe("PostgresInventoryAvailabilityRuntimePublicationExecutor", () => {
  it("pins legacy authority through the selected publisher and commits afterward", async () => {
    const client = fakeClient({ authority: "legacy", authority_revision: "1", activation_run_id: null });
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(
      { connect: vi.fn(async () => client), options: { max: 2 } } as never,
    );

    await expect(executor.execute(async (context) => {
      expect(context.authority).toBe("legacy");
      expect(client.query.mock.calls.map(([sql]) => String(sql).trim())).not.toContain("COMMIT");
      return "published";
    })).resolves.toBe("published");

    expect(transactionCommands(client)).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      expect.stringContaining("FOR SHARE"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("releases its routing slot when acquiring a database connection fails", async () => {
    const client = fakeClient({ authority: "legacy", authority_revision: "1", activation_run_id: null });
    const connect = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(client);
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(
      { connect, options: { max: 2 } } as never,
    );

    await expect(executor.execute(async () => "unreachable")).rejects.toThrow("database unavailable");
    await expect(executor.execute(async () => "recovered")).resolves.toBe("recovered");
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("reserves half of the configured pool for nested legacy database work", async () => {
    let active = 0;
    let peak = 0;
    let signalTwoEntered!: () => void;
    const twoEntered = new Promise<void>((resolve) => { signalTwoEntered = resolve; });
    let unblock!: () => void;
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    const connect = vi.fn(async () => fakeClient({
      authority: "legacy",
      authority_revision: "1",
      activation_run_id: null,
    }));
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(
      { connect, options: { max: 4 } } as never,
    );

    const operations = [1, 2, 3].map((value) => executor.execute(async () => {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) signalTwoEntered();
      await blocked;
      active -= 1;
      return value;
    }));
    await twoEntered;

    expect(connect).toHaveBeenCalledTimes(2);
    expect(peak).toBe(2);
    unblock();
    await expect(Promise.all(operations)).resolves.toEqual([1, 2, 3]);
    expect(connect).toHaveBeenCalledTimes(3);
  });

  it("requires an active activation run before exposing canonical publication operations", async () => {
    const client = fakeClient(
      { authority: "canonical", authority_revision: "9", activation_run_id: "44" },
      { activationState: "publication_verified" },
    );
    const work = vi.fn(async () => "unreachable");
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(
      { connect: vi.fn(async () => client), options: { max: 2 } } as never,
    );

    await expect(executor.execute(work)).rejects.toMatchObject({
      code: "INVENTORY_PUBLICATION_ACTIVATION_NOT_ACTIVE",
    });
    expect(work).not.toHaveBeenCalled();
    expect(transactionCommands(client).at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back and fails closed when the authority singleton is invalid", async () => {
    const client = fakeClient(null);
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(
      { connect: vi.fn(async () => client), options: { max: 2 } } as never,
    );

    await expect(executor.execute(async () => "unreachable")).rejects.toMatchObject({
      code: "INVENTORY_ATP_RUNTIME_AUTHORITY_INVALID",
    });
    expect(transactionCommands(client).at(-1)).toBe("ROLLBACK");
  });

  it("loads only sealed active target definitions and normalizes integer warehouse activity", async () => {
    const client = fakeClient(
      { authority: "canonical", authority_revision: "9", activation_run_id: "44" },
      {
        activationState: "active",
        query: async (sql) => {
          if (sql.includes("FROM inventory.inventory_publication_targets AS target")) {
            expect(sql).toContain("warehouse_row.is_active = 1 AS warehouse_is_active");
            return { rows: [{
              publication_target_id: 5,
              publication_target_revision: "2",
              destination_kind: "channel_connection",
              channel_id: 3,
              channel_name: "Shopify US",
              provider_key: "shopify",
              channel_connection_id: 33,
              dropship_store_connection_id: null,
              provider_scope_type: "location",
              external_scope_id: "location-1",
              active_binding_id: 7,
              binding_lifecycle_status: "sealed",
              warehouse_id: 1,
              fulfillment_node_lifecycle_status: "active",
              warehouse_is_active: true,
            }] };
          }
          if (sql.includes("FROM inventory.channel_exposure_policy_heads")) {
            return { rows: [{
              scope_key: "channel:3",
              scope_type: "channel",
              channel_id: 3,
              product_id: null,
              product_variant_id: null,
              lifecycle_status: "sealed",
              allocation_semantics: "exposure",
              eligible: true,
              share_bps: 10_000,
              holdback_sellable_units: "0",
              max_publish_mode: "unlimited",
              max_publish_sellable_units: null,
              min_publish_sellable_units: "0",
            }] };
          }
          if (sql.includes("FROM inventory.publication_variant_mapping_heads")) {
            return { rows: [{
              publication_target_id: 5,
              product_variant_id: 101,
              lifecycle_status: "sealed",
              external_inventory_item_id: "inventory-item-101",
              external_sku: "EA",
            }] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      },
    );
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(
      { connect: vi.fn(async () => client), options: { max: 2 } } as never,
    );

    const targets = await executor.execute((context) => context.loadActivePublicationTargets({
      productId: 10,
      productVariantIds: [101],
      channelId: 3,
    }));

    expect(targets).toEqual([expect.objectContaining({
      publicationTargetId: 5,
      sourceBindingId: 7,
      sourceWarehouseIds: [1],
      mappings: [{
        productVariantId: 101,
        externalInventoryItemId: "inventory-item-101",
        externalSku: "EA",
      }],
    })]);
  });

  it("loads a Dropship-owned target with its exact transport owner", async () => {
    const client = fakeClient(
      { authority: "canonical", authority_revision: "9", activation_run_id: "44" },
      {
        activationState: "active",
        query: async (sql) => {
          if (sql.includes("FROM inventory.inventory_publication_targets AS target")) {
            return { rows: [{
              publication_target_id: 5,
              publication_target_revision: "2",
              destination_kind: "dropship_store_connection",
              channel_id: 3,
              channel_name: "eBay Dropship",
              provider_key: "ebay",
              channel_connection_id: null,
              dropship_store_connection_id: 91,
              provider_scope_type: "account",
              external_scope_id: "seller-account-1",
              active_binding_id: 7,
              binding_lifecycle_status: "sealed",
              warehouse_id: 1,
              fulfillment_node_lifecycle_status: "active",
              warehouse_is_active: true,
            }] };
          }
          if (sql.includes("FROM inventory.channel_exposure_policy_heads")
            || sql.includes("FROM inventory.publication_variant_mapping_heads")) {
            return { rows: [] };
          }
          throw new Error(`Unexpected SQL: ${sql}`);
        },
      },
    );
    const executor = new PostgresInventoryAvailabilityRuntimePublicationExecutor(
      { connect: vi.fn(async () => client), options: { max: 2 } } as never,
    );

    await expect(executor.execute((context) => context.loadActivePublicationTargets({
      productId: 10,
      productVariantIds: [101],
      channelId: 3,
    }))).resolves.toEqual([expect.objectContaining({
      destinationKind: "dropship_store_connection",
      channelConnectionId: null,
      dropshipStoreConnectionId: 91,
      providerKey: "ebay",
    })]);
    expect(transactionCommands(client).at(-1)).toBe("COMMIT");
  });

  it("coalesces an identical reusable desired state instead of creating another revision", async () => {
    const database = publicationDatabase();
    const executor = executorFor(database);

    const first = await executor.execute((context) =>
      context.enqueueFullPublications("44", [publicationIntent("4")]));
    const second = await executor.execute((context) =>
      context.enqueueFullPublications("44", [publicationIntent("4")]));

    expect(first).toEqual({
      enqueuedRows: 1,
      coalescedRows: 0,
      enqueuedPublicationKeys: ["5:101"],
      coalescedPublicationKeys: [],
    });
    expect(second).toEqual({
      enqueuedRows: 0,
      coalescedRows: 1,
      enqueuedPublicationKeys: [],
      coalescedPublicationKeys: ["5:101"],
    });
    expect(database.insertedRevisions).toEqual(["1"]);
  });

  it("supersedes mutable work and inserts the next monotonic desired revision", async () => {
    const database = publicationDatabase();
    const executor = executorFor(database);

    await executor.execute((context) => context.enqueueFullPublications("44", [publicationIntent("4")]));
    const second = await executor.execute((context) =>
      context.enqueueFullPublications("44", [publicationIntent("3")]));

    expect(second).toMatchObject({ enqueuedRows: 1, coalescedRows: 0 });
    expect(database.insertedRevisions).toEqual(["1", "2"]);
    expect(database.latest).toMatchObject({ desired_revision: "2", desired_quantity: "3", state: "queued" });
    expect(database.supersededCount).toBe(2);
  });

  it("creates a retryable new revision after a terminal dead letter even when quantity is unchanged", async () => {
    const database = publicationDatabase();
    const executor = executorFor(database);

    await executor.execute((context) => context.enqueueFullPublications("44", [publicationIntent("4")]));
    database.latest!.state = "dead_letter";
    await executor.execute((context) => context.enqueueFullPublications("44", [publicationIntent("4")]));

    expect(database.insertedRevisions).toEqual(["1", "2"]);
    expect(database.latest).toMatchObject({ desired_revision: "2", state: "queued" });
  });

  it("rolls back the authority transaction when an outbox row cannot enter the queue", async () => {
    const database = publicationDatabase({ failQueueTransition: true });
    const executor = executorFor(database);

    await expect(executor.execute((context) =>
      context.enqueueFullPublications("44", [publicationIntent("4")]))).rejects.toMatchObject({
      code: "INVENTORY_PUBLICATION_OUTBOX_QUEUE_FAILED",
    });
    expect(transactionCommands(database.client).at(-1)).toBe("ROLLBACK");
  });

  it("fails at composition when the pool cannot reserve a nested legacy connection", () => {
    expect(() => new PostgresInventoryAvailabilityRuntimePublicationExecutor(
      { connect: vi.fn(), options: { max: 1 } } as never,
    )).toThrow(expect.objectContaining({ code: "INVENTORY_PUBLICATION_POOL_CAPACITY_INVALID" }));
  });
});

function executorFor(database: ReturnType<typeof publicationDatabase>) {
  return new PostgresInventoryAvailabilityRuntimePublicationExecutor(
    { connect: vi.fn(async () => database.client), options: { max: 2 } } as never,
  );
}

function publicationDatabase(options: { failQueueTransition?: boolean } = {}) {
  const database: {
    client: ReturnType<typeof fakeClient>;
    latest: Record<string, unknown> | null;
    insertedRevisions: string[];
    supersededCount: number;
  } = {
    client: undefined as never,
    latest: null,
    insertedRevisions: [],
    supersededCount: 0,
  };
  database.client = fakeClient(
    { authority: "canonical", authority_revision: "9", activation_run_id: "44" },
    {
      activationState: "active",
      query: async (sql, values) => {
        if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
        if (sql.includes("FROM inventory.inventory_publication_outbox")
          && sql.includes("ORDER BY desired_revision DESC")) {
          return { rows: database.latest ? [{ ...database.latest }] : [] };
        }
        if (sql.startsWith("UPDATE inventory.inventory_publication_outbox")
          && sql.includes("SET state = 'superseded'")) {
          database.supersededCount += 1;
          if (database.latest && ["desired", "queued", "leased", "retryable", "drifted"]
            .includes(String(database.latest.state))) {
            database.latest.state = "superseded";
          }
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("INSERT INTO inventory.inventory_publication_outbox")) {
          const revision = String(values?.[3]);
          database.insertedRevisions.push(revision);
          database.latest = {
            activation_run_id: String(values?.[0]),
            state: "desired",
            desired_revision: revision,
            desired_quantity: String(values?.[4]),
            destination_kind_snapshot: String(values?.[5]),
            channel_connection_id_snapshot: values?.[6] == null ? null : Number(values[6]),
            dropship_store_connection_id_snapshot: values?.[7] == null ? null : Number(values[7]),
            external_scope_id_snapshot: String(values?.[8]),
            external_inventory_item_id_snapshot: String(values?.[9]),
            channel_id_snapshot: Number(values?.[10]),
            provider_key_snapshot: String(values?.[11]),
            provider_scope_type_snapshot: String(values?.[12]),
            external_sku_snapshot: values?.[13] == null ? null : String(values[13]),
            publication_target_revision_snapshot: String(values?.[14]),
          };
          return { rows: [{ id: revision }], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE inventory.inventory_publication_outbox")
          && sql.includes("SET state = 'queued'")) {
          if (options.failQueueTransition) return { rows: [], rowCount: 0 };
          if (database.latest) database.latest.state = "queued";
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("UPDATE inventory.availability_activation_runs")) {
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected SQL: ${sql}`);
      },
    },
  );
  return database;
}

function fakeClient(
  authority: Record<string, unknown> | null,
  options: {
    activationState?: string;
    query?: (sql: string, values: readonly unknown[] | undefined) => Promise<{
      rows: Record<string, unknown>[];
      rowCount?: number;
    }>;
  } = {},
) {
  const query = vi.fn(async (statement: unknown, values?: readonly unknown[]) => {
    const sql = String(statement).trim();
    if (sql.startsWith("SELECT authority")) return { rows: authority ? [authority] : [] };
    if (sql.startsWith("SELECT state") && sql.includes("availability_activation_runs")) {
      return { rows: options.activationState == null ? [] : [{ state: options.activationState }] };
    }
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (options.query) return options.query(sql, values);
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, release: vi.fn() };
}

function transactionCommands(client: ReturnType<typeof fakeClient>): string[] {
  return client.query.mock.calls
    .map(([sql]) => String(sql).trim())
    .filter((sql) => sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK"
      || sql.startsWith("SELECT authority"));
}

function publicationIntent(desiredQuantity: string): CanonicalInventoryPublicationIntent {
  return {
    publicationTargetId: 5,
    publicationTargetRevision: "2",
    productVariantId: 101,
    sku: "EA",
    desiredQuantity,
    channelId: 3,
    channelName: "Shopify US",
    destinationKind: "channel_connection",
    channelConnectionId: 33,
    dropshipStoreConnectionId: null,
    providerKey: "shopify",
    providerScopeType: "location",
    externalScopeId: "location-1",
    externalInventoryItemId: "inventory-item-101",
    externalSku: "EA",
    sourceWarehouseIds: [1],
    blockerCodes: [],
  };
}
