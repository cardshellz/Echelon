/**
 * The exposure admin view must report the persisted runtime authority, never a
 * literal: after cutover the exposure dials are what publishes, and the page
 * badge is the operator's only signal. Connection labels likewise come from
 * persisted provider identities, with account ids used when names are empty.
 */
import { describe, expect, it, vi } from "vitest";
import { inventoryPublicationTargetAdminSchema } from "@shared/types/inventory-channel-exposure";
import { PostgresInventoryChannelExposureAdminStore } from "../../infrastructure/inventory-channel-exposure-admin.repository";

/** Flattens a drizzle `sql` template into text so a fake can route by statement. */
function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks.map((chunk) => {
    if (chunk && typeof chunk === "object" && "queryChunks" in chunk) return sqlText(chunk);
    if (chunk && typeof chunk === "object" && "value" in chunk && Array.isArray((chunk as { value: unknown }).value)) {
      return ((chunk as { value: string[] }).value).join("");
    }
    return "?";
  }).join("");
}

function createStore(authorityRows: unknown[], projectionRows: Record<string, unknown[]> = {}) {
  const execute = vi.fn(async (query: unknown) => {
    const text = sqlText(query);
    if (text.includes("FROM inventory.availability_runtime_authority")) return { rows: authorityRows };
    for (const [table, data] of Object.entries(projectionRows)) {
      if (text.includes(`FROM ${table}`)) return { rows: data };
    }
    return { rows: [] };
  });
  const database = { execute } as unknown as ConstructorParameters<typeof PostgresInventoryChannelExposureAdminStore>[0];
  const shadowStore = {} as ConstructorParameters<typeof PostgresInventoryChannelExposureAdminStore>[1];
  return { store: new PostgresInventoryChannelExposureAdminStore(database, shadowStore), execute };
}

describe("PostgresInventoryChannelExposureAdminStore.getAdminView runtime authority", () => {
  it.each([
    { authority: "legacy", revision: "1" },
    { authority: "canonical", revision: "12" },
  ])("reports the persisted singleton %j instead of asserting legacy", async (row) => {
    const { store, execute } = createStore([row]);

    const view = await store.getAdminView(null);

    expect(view).toMatchObject({
      runtimeAuthority: row.authority,
      runtimeAuthorityRevision: row.revision,
      providerWriteEnabled: false,
    });
    const authorityReads = execute.mock.calls.filter(([query]) => sqlText(query).includes("availability_runtime_authority"));
    expect(authorityReads).toHaveLength(1);
    expect(sqlText(authorityReads[0][0])).toContain("WHERE singleton_key = true");
  });

  it.each([
    { label: "no singleton row", rows: [] },
    { label: "a duplicated singleton", rows: [{ authority: "legacy", revision: "1" }, { authority: "legacy", revision: "1" }] },
    { label: "an unknown authority", rows: [{ authority: "shadow", revision: "1" }] },
    { label: "a zero revision", rows: [{ authority: "legacy", revision: "0" }] },
  ])("refuses the view on $label so no page shows an assumed authority", async ({ rows }) => {
    const { store } = createStore(rows);

    await expect(store.getAdminView(null)).rejects.toMatchObject({
      status: 503,
      code: "INVENTORY_RUNTIME_AUTHORITY_UNAVAILABLE",
    });
  });
});

describe("PostgresInventoryChannelExposureAdminStore.getAdminView connection labels", () => {
  it.each([
    { partnerName: "Card Shellz", expected: "Card Shellz" },
    { partnerName: "  Card Shellz  ", expected: "Card Shellz" },
    { partnerName: "  ", expected: "10002558022" },
  ])("shows the saved Walmart seller identity for '$partnerName'", async ({ partnerName, expected }) => {
    const { store } = createStore([{ authority: "canonical", revision: "12" }], {
      "channels.channels": [
        { id: 104, name: "Walmart", provider: "walmart", status: "active" },
        { id: 105, name: "Shopify", provider: "shopify", status: "active" },
        { id: 106, name: "eBay", provider: "ebay", status: "active" },
      ],
      "channels.channel_connections": [
        { id: 67, channel_id: 104, shop_domain: null, environment: "production" },
        { id: 68, channel_id: 105, shop_domain: "cardshellz.myshopify.com", shopify_location_id: "location-68", environment: "production" },
        { id: 69, channel_id: 106, shop_domain: null, environment: "production" },
      ],
      "channels.walmart_connections": [{
        connection_id: 67, partner_id: "10002558022", partner_name: partnerName, ship_node_id: "10002558022",
      }],
      "ebay.ebay_oauth_tokens": [{
        channel_id: 106, environment: "production", external_account_id: "ebay-user-69",
        external_account_display_name: "cardshellz", external_account_verified_at: "2026-10-04T12:00:00.000Z",
      }],
    });

    const view = await store.getAdminView(null);

    expect(view.channels[0].connections).toEqual([{
      id: 67, externalAccountLabel: expected, shopifyLocationId: null,
      providerLocationId: "10002558022", providerAccount: null,
    }]);
    expect(view.channels[1].connections).toEqual([{
      id: 68, externalAccountLabel: "cardshellz.myshopify.com", shopifyLocationId: "location-68",
      providerLocationId: null, providerAccount: null,
    }]);
    expect(view.channels[2].connections).toEqual([{
      id: 69, externalAccountLabel: null, shopifyLocationId: null, providerLocationId: null,
      providerAccount: { externalAccountId: "ebay-user-69", displayName: "cardshellz", verifiedAt: "2026-10-04T12:00:00.000Z" },
    }]);
  });
});

describe("publication target prior live-stop evidence", () => {
  const wireTarget = {
    id: 5,
    destinationKind: "channel_connection",
    channelId: 3,
    channelConnectionId: 33,
    dropshipStoreConnectionId: null,
    legacyFulfillmentNodeId: 7,
    providerScopeType: "location",
    externalScopeId: "location-1",
    publicationAuthority: "echelon",
    state: "preview",
    revision: "3",
    hold: null,
  };

  it("preserves unknown prior-stop history from an older response", () => {
    const target = inventoryPublicationTargetAdminSchema.parse(wireTarget);
    expect(target).not.toHaveProperty("hasPriorLiveStop");
  });

  it.each([false, true])("preserves explicit prior-stop evidence %s", (hasPriorLiveStop) => {
    expect(inventoryPublicationTargetAdminSchema.parse({ ...wireTarget, hasPriorLiveStop }))
      .toMatchObject({ hasPriorLiveStop });
  });

  it.each([null, "false", "true", 0, 1])("rejects non-boolean stop evidence %j", (hasPriorLiveStop) => {
    expect(inventoryPublicationTargetAdminSchema.safeParse({ ...wireTarget, hasPriorLiveStop }).success).toBe(false);
  });

  it.each([
    { state: "disabled", hasPriorLiveStop: false },
    { state: "preview", hasPriorLiveStop: false },
    { state: "disabled", hasPriorLiveStop: true },
    { state: "preview", hasPriorLiveStop: true },
    { state: "live", hasPriorLiveStop: true },
  ])("projects audited history without deriving it from $state ($hasPriorLiveStop)", async ({ state, hasPriorLiveStop }) => {
    const { store, execute } = createStore([{ authority: "canonical", revision: "12" }], {
      "inventory.inventory_publication_targets": [{
        id: 5, destination_kind: "channel_connection", channel_id: 3,
        channel_connection_id: 33, dropship_store_connection_id: null,
        fulfillment_node_id: 7, provider_scope_type: "location", external_scope_id: "location-1",
        publication_authority: "echelon", state, revision: "3",
        hold_reason: null, held_at: null, held_by: null,
        has_prior_live_stop: hasPriorLiveStop,
      }],
    });

    const view = await store.getAdminView(null);

    expect(view.publicationTargets).toEqual([{ ...wireTarget, state, hasPriorLiveStop }]);
    const statements = execute.mock.calls.map(([query]) => sqlText(query));
    const targetQuery = statements.find(text => text.includes("FROM inventory.inventory_publication_targets"))!;
    expect(targetQuery).toContain("EXISTS (");
    expect(targetQuery).toContain("audit.action = 'inventory_availability.publication_target.stopped'");
    expect(targetQuery).toContain("audit.target = 'inventory.inventory_publication_target:' || target.id::text");
    expect(targetQuery).not.toContain("publication_target.preview_state_changed");
    expect(statements.every(text => /^\s*SELECT\b/.test(text))).toBe(true);
  });
});
