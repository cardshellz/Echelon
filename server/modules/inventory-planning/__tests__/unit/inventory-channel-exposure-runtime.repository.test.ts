import { describe, expect, it, vi } from "vitest";

import { PostgresInventoryChannelExposureRuntimeExecutor } from "../../infrastructure/inventory-channel-exposure-runtime.repository";

const HASH = "a".repeat(64);

describe("PostgresInventoryChannelExposureRuntimeExecutor", () => {
  it("does not read canonical supply or channel configuration while legacy owns authority", async () => {
    const client = fakeClient("legacy");
    const captureSupplySnapshot = vi.fn();
    const executor = new PostgresInventoryChannelExposureRuntimeExecutor(
      { connect: vi.fn(async () => client) } as never,
      captureSupplySnapshot,
    );

    const context = await executor.execute(10, async (value) => value);

    expect(context).toMatchObject({
      authority: "legacy",
      authorityRevision: "4",
      activationRunId: null,
      supplySnapshot: null,
      managedSellableVariantIds: [],
      publicationTargets: [],
    });
    expect(captureSupplySnapshot).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map((call) => sqlText(call[0]))).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ",
      expect.stringContaining("FOR SHARE"),
      "COMMIT",
    ]);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("loads only live Echelon targets and sealed active heads under one authority lock", async () => {
    const client = fakeClient("canonical");
    const supplySnapshot = {
      productId: 10,
      snapshotFingerprint: HASH,
      capturedAt: "2026-09-04T12:00:00.000Z",
    };
    const captureSupplySnapshot = vi.fn(async () => supplySnapshot as never);
    const executor = new PostgresInventoryChannelExposureRuntimeExecutor(
      { connect: vi.fn(async () => client) } as never,
      captureSupplySnapshot,
    );

    const context = await executor.execute(10, async (value) => value);

    expect(captureSupplySnapshot).toHaveBeenCalledWith(client, 10);
    expect(context).toMatchObject({
      authority: "canonical",
      authorityRevision: "4",
      activationRunId: "33",
      supplySnapshot,
      managedSellableVariantIds: [101],
      publicationTargets: [{
        publicationTargetId: 91,
        publicationTargetRevision: "3",
        destinationKind: "channel_connection",
        channelId: 7,
        channelName: "Shopify US",
        channelProvider: "shopify",
        channelConnectionId: 17,
        dropshipStoreConnectionId: null,
        sourceBinding: {
          bindingId: 201,
          version: 2,
          definitionHash: HASH,
          members: [{
            fulfillmentNodeId: 11,
            warehouseId: 1,
            fulfillmentNodeLifecycleStatus: "active",
          }],
        },
        policies: [{
          scopeKey: "channel:7",
          scopeType: "channel",
          policyId: 301,
          value: {
            allocationSemantics: "exposure",
            eligible: true,
            shareBps: 10_000,
            holdbackSellableUnits: "0",
            maxPublish: { mode: "unlimited" },
            minPublishSellableUnits: "0",
          },
        }],
        mappings: [{
          mappingId: 401,
          productVariantId: 101,
          externalInventoryItemId: "gid://shopify/InventoryItem/101",
        }],
      }],
    });
    const statements = client.query.mock.calls.map((call) => sqlText(call[0]));
    const operationalReads = statements.filter((statement) => statement.startsWith("SELECT"));
    expect(operationalReads.join("\n")).toContain("head.active_binding_id");
    expect(operationalReads.join("\n")).toContain("head.active_policy_id");
    expect(operationalReads.join("\n")).toContain("head.active_mapping_id");
    expect(operationalReads.join("\n")).toContain("target.state = 'live'");
    expect(operationalReads.join("\n")).toContain("target.publication_authority = 'echelon'");
    expect(operationalReads.join("\n")).toContain("requires_shipping = true");
    expect(operationalReads.join("\n")).not.toContain("draft_");
    expect(operationalReads.join("\n")).not.toContain("COALESCE(head.");
    expect(statements.at(-1)).toBe("COMMIT");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back if active database evidence is malformed", async () => {
    const client = fakeClient("canonical", { invalidTargetRevision: true });
    const executor = new PostgresInventoryChannelExposureRuntimeExecutor(
      { connect: vi.fn(async () => client) } as never,
      vi.fn(async () => ({ productId: 10 }) as never),
    );

    await expect(executor.execute(10, async (value) => value)).rejects.toMatchObject({
      code: "CANONICAL_CHANNEL_EXPOSURE_DATABASE_EVIDENCE_INVALID",
    });
    expect(client.query.mock.calls.map((call) => sqlText(call[0])).at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("loads a Dropship store as the exact transport owner while retaining its allocation channel", async () => {
    const client = fakeClient("canonical", { dropship: true });
    const executor = new PostgresInventoryChannelExposureRuntimeExecutor(
      { connect: vi.fn(async () => client) } as never,
      vi.fn(async () => ({ productId: 10 }) as never),
    );

    const context = await executor.execute(10, async (value) => value);

    expect(context.publicationTargets[0]).toMatchObject({
      destinationKind: "dropship_store_connection",
      channelId: 7,
      channelProvider: "ebay",
      channelConnectionId: null,
      dropshipStoreConnectionId: 77,
    });
  });
});

function fakeClient(
  authority: "legacy" | "canonical",
  options: { invalidTargetRevision?: boolean; dropship?: boolean } = {},
) {
  const query = vi.fn(async (statement: unknown) => {
    const sql = sqlText(statement);
    if (sql.startsWith("BEGIN") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
    if (sql.startsWith("SELECT authority")) return { rows: [{
      authority,
      authority_revision: "4",
      activation_run_id: authority === "canonical" ? "33" : null,
    }] };
    if (sql.includes("FROM catalog.product_variants")) return { rows: [{ id: 101 }] };
    if (sql.includes("FROM inventory.inventory_publication_targets AS target")
      && sql.includes("JOIN channels.channels")) return { rows: [{
        publication_target_id: 91,
        publication_target_revision: options.invalidTargetRevision ? "0" : "3",
        destination_kind: options.dropship ? "dropship_store_connection" : "channel_connection",
        channel_id: 7,
        channel_name: "Shopify US",
        channel_provider: options.dropship ? "ebay" : "shopify",
        channel_connection_id: options.dropship ? null : 17,
        dropship_store_connection_id: options.dropship ? 77 : null,
        provider_scope_type: "location",
        external_scope_id: "gid://shopify/Location/1",
        publication_authority: "echelon",
        publication_target_state: "live",
      }] };
    if (sql.includes("publication_source_binding_heads")) return { rows: [{
      publication_target_id: 91,
      binding_id: 201,
      binding_version: 2,
      binding_definition_hash: HASH,
      fulfillment_node_id: 11,
      warehouse_id: 1,
      fulfillment_node_lifecycle_status: "active",
    }] };
    if (sql.includes("channel_exposure_policy_heads")) return { rows: [{
      channel_id: 7,
      scope_key: "channel:7",
      policy_id: 301,
      policy_version: 1,
      policy_definition_hash: HASH,
      scope_type: "channel",
      product_id: null,
      product_variant_id: null,
      allocation_semantics: "exposure",
      eligible: true,
      share_bps: 10_000,
      holdback_sellable_units: "0",
      max_publish_mode: "unlimited",
      max_publish_sellable_units: null,
      min_publish_sellable_units: "0",
    }] };
    if (sql.includes("publication_variant_mapping_heads")) return { rows: [{
      publication_target_id: 91,
      product_variant_id: 101,
      mapping_id: 401,
      mapping_version: 1,
      mapping_definition_hash: HASH,
      external_inventory_item_id: "gid://shopify/InventoryItem/101",
      external_sku: "EA",
    }] };
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  return { query, release: vi.fn() };
}

function sqlText(value: unknown): string {
  return String(value).trim().replace(/\s+/g, " ");
}
