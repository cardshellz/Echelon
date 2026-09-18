import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  createChannelFulfillmentAuthorityRepository,
  type MaterializePhysicalPackageInput,
} from "../../channel-fulfillment-authority.repository";

const dialect = new PgDialect();

const previewInput: MaterializePhysicalPackageInput = {
  legacyWmsShipmentIds: [501], shippingProvider: "shipstation", providerPhysicalShipmentId: "9001",
  providerOrderId: "new-order", providerOrderKey: "stable-work", trackingNumber: "1ZTEST", carrier: "UPS",
  source: "script:backfill-channel-fulfillment-authority", legacyHeaderPolicy: "strict",
  providerOrderIdentityPolicy: "stable_key_alias", notifyCustomer: false,
};
const previewHeader = {
  legacy_shipment_id: 501, shipment_status: "shipped", persisted_shipping_provider: "shipstation",
  persisted_provider_order_id: "new-order", persisted_provider_order_key: "stable-work",
  persisted_physical_identity: "shipstation_shipment:9001", persisted_tracking_number: "1ZTEST", persisted_carrier: "ups",
  wms_order_id: 20, shipment_purpose: "customer_fulfillment", legacy_shipment_item_id: 502,
  shipment_item_purpose: "customer_fulfillment", order_item_id: 21, oms_order_id: 30, oms_order_line_id: 31,
  sku: "TEST", channel_provider: "shopify", channel_order_line_id: "channel-line", quantity_shipped: 1,
  max_authorized_quantity: 4, paid_quantity: 4, authority_fulfillable_quantity: 4,
  cancelled_quantity: 0, refunded_quantity: 0, refund_cancel_quantity: 0, refund_other_quantity: 0,
};
const previewEngine = { id: 10, provider_order_id: "old-order", provider_order_key: "stable-work",
  incoming_provider_order_id_already_aliased: false };

function identityPreviewFixture(headers = [previewHeader], engines = [previewEngine]) {
  const execute = vi.fn(async (query: unknown) => {
    const text = render(query);
    if (text.includes("FROM wms.outbound_shipments AS shipment")) return { rows: headers };
    if (text.includes("FROM wms.fulfillment_plans AS plan")
      || text.includes("FROM wms.shipment_request_items AS item")
      || text.includes("FROM wms.physical_shipment_items AS item")) return { rows: [] };
    if (text.includes("FROM wms.shipping_engine_orders AS engine")) return { rows: engines };
    throw new Error(`Unexpected identity preview query: ${text}`);
  });
  const tx = { execute };
  const transaction = vi.fn(async (callback: (executor: typeof tx) => Promise<void>, _options: unknown) => callback(tx));
  return { execute, transaction, repository: createChannelFulfillmentAuthorityRepository({ transaction }) };
}

function render(query: unknown): string {
  return dialect.sqlToQuery(query as any).sql.replace(/\s+/g, " ").trim();
}

describe("channel fulfillment authority repository", () => {
  it("previews strict package headers and stable parent aliases using only read-only queries", async () => {
    const { repository, execute, transaction } = identityPreviewFixture();
    await expect(repository.validatePhysicalPackageIdentity(previewInput)).resolves.toBeUndefined();
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), { isolationLevel: "repeatable read", accessMode: "read only" });
    expect(execute).toHaveBeenCalledTimes(5);
    for (const [query] of execute.mock.calls) expect(render(query)).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
  });

  it("keeps the default engine policy strict", async () => {
    const { repository } = identityPreviewFixture();
    await expect(repository.validatePhysicalPackageIdentity({ ...previewInput, providerOrderIdentityPolicy: undefined }))
      .rejects.toMatchObject({ code: "PACKAGE_IDENTITY_CONFLICT", context: { field: "providerOrderId" } });
  });

  it("rejects wrong tracking before looking up the parent order", async () => {
    const { repository, execute } = identityPreviewFixture();
    await expect(repository.validatePhysicalPackageIdentity({ ...previewInput, trackingNumber: "OTHER" }))
      .rejects.toMatchObject({ code: "PACKAGE_IDENTITY_CONFLICT", context: { field: "trackingNumber" } });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("rejects missing shipment rows and ambiguous parent orders", async () => {
    await expect(identityPreviewFixture([]).repository.validatePhysicalPackageIdentity(previewInput))
      .rejects.toMatchObject({ code: "LEGACY_SHIPMENT_NOT_FOUND" });
    await expect(identityPreviewFixture([previewHeader], [previewEngine, { ...previewEngine, id: 11 }])
      .repository.validatePhysicalPackageIdentity(previewInput)).rejects.toMatchObject({ code: "CANONICAL_STATE_CONFLICT" });
  });

  it("rejects a contradictory canonical order key even when the order ID is a saved alias", async () => {
    const { repository } = identityPreviewFixture([previewHeader], [{
      ...previewEngine,
      provider_order_key: "another-stable-work-key",
      incoming_provider_order_id_already_aliased: true,
    }]);
    await expect(repository.validatePhysicalPackageIdentity(previewInput))
      .rejects.toMatchObject({ code: "PACKAGE_IDENTITY_CONFLICT", context: { field: "providerOrderKey" } });
  });

  it("validates identity inputs before opening a transaction", async () => {
    const { repository, transaction } = identityPreviewFixture();
    await expect(repository.validatePhysicalPackageIdentity({ ...previewInput, providerOrderIdentityPolicy: "skip" as never }))
      .rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(repository.validatePhysicalPackageIdentity({ ...previewInput, providerOrderId: null, providerOrderKey: null }))
      .rejects.toMatchObject({ code: "PROVIDER_ORDER_IDENTITY_MISSING" });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("types the terminal completion timestamp explicitly", async () => {
    const queries: unknown[] = [];
    const tx = {
      execute: vi.fn(async (query: unknown) => {
        queries.push(query);
        if (queries.length === 1) {
          return {
            rows: [{
              id: 91,
              push_status: "processing",
              lease_token: "lease-91",
              attempt_count: 1,
              request_hash: "request-hash",
              correlation_id: null,
              causation_id: null,
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const repository = createChannelFulfillmentAuthorityRepository({
      transaction: (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx),
    });

    await repository.completeAttempt({
      commandId: 91,
      leaseToken: "lease-91",
      outcome: "success",
      providerResponseId: "gid://shopify/Fulfillment/91",
      startedAt: new Date("2026-07-23T15:00:00.000Z"),
      completedAt: new Date("2026-07-23T15:00:01.000Z"),
    });

    const update = queries.map(render).find((query) =>
      query.startsWith("UPDATE oms.channel_fulfillment_pushes"),
    );
    expect(update).toMatch(
      /completed_at = CASE WHEN \$\d+::boolean THEN \$\d+::timestamptz ELSE NULL::timestamptz END/,
    );
  });

  it("types the expired-lease dead-letter timestamp explicitly", async () => {
    const queries: unknown[] = [];
    const now = new Date("2026-07-23T15:10:00.000Z");
    const tx = {
      execute: vi.fn(async (query: unknown) => {
        queries.push(query);
        const text = render(query);
        if (text.includes("WHERE push_status = 'processing'")) {
          return {
            rows: [{
              id: 92,
              attempt_count: 12,
              max_attempts: 12,
              request_hash: "request-hash",
              last_attempt_at: new Date("2026-07-23T15:00:00.000Z"),
              correlation_id: null,
              causation_id: null,
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const repository = createChannelFulfillmentAuthorityRepository({
      transaction: (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx),
    });

    const claimed = await repository.claimCommands({
      now,
      leaseToken: "lease-92",
      leaseDurationMs: 120_000,
      limit: 25,
    });

    expect(claimed).toEqual([]);
    const update = queries.map(render).find((query) =>
      query.startsWith("UPDATE oms.channel_fulfillment_pushes")
      && query.includes("last_error_code = 'LEASE_EXPIRED'"),
    );
    expect(update).toMatch(
      /completed_at = CASE WHEN attempt_count >= max_attempts THEN \$\d+::timestamptz ELSE NULL::timestamptz END/,
    );
  });

  it("claims both legacy and exact package-allocation physical-item provenance", async () => {
    const queries: unknown[] = [];
    const now = new Date("2026-09-01T14:00:00.000Z");
    const tx = {
      execute: vi.fn(async (query: unknown) => {
        queries.push(query);
        const text = render(query);
        if (text.includes("WHERE push_status = 'processing'")) return { rows: [] };
        if (text.startsWith("SELECT command.id")) return { rows: [{ id: 93 }] };
        if (text.startsWith("UPDATE oms.channel_fulfillment_pushes")) {
          return {
            rows: [{
              id: 93,
              command_key: "fulfillment:v1:shopify:100:200:order",
              request_hash: "a".repeat(64),
              oms_order_id: 100,
              physical_shipment_id: 200,
              channel_provider: "shopify",
              channel_fulfillment_scope_key: "order",
              tracking_number: "1ZTEST",
              carrier: "UPS",
              tracking_url: null,
              shipped_at: now,
              attempt_count: 1,
              max_attempts: 12,
              lease_token: "lease-93",
              metadata: { legacyWmsShipmentIds: [501, 502] },
            }],
          };
        }
        if (text.includes("FROM oms.channel_fulfillment_push_items AS push_item")) {
          return {
            rows: [
              {
                channel_fulfillment_push_id: 93,
                physical_shipment_item_id: 300,
                package_allocation_entry_id: null,
                shipment_request_item_id: 250,
                legacy_wms_shipment_item_id: 700,
                legacy_wms_shipment_id: 501,
                oms_order_line_id: 101,
                channel_order_line_id: "gid://shopify/LineItem/1",
                quantity_pushed: 2,
              },
              {
                channel_fulfillment_push_id: 93,
                physical_shipment_item_id: 301,
                package_allocation_entry_id: 9001,
                shipment_request_item_id: 251,
                legacy_wms_shipment_item_id: 701,
                legacy_wms_shipment_id: 502,
                oms_order_line_id: 102,
                channel_order_line_id: "gid://shopify/LineItem/2",
                quantity_pushed: 1,
              },
            ],
          };
        }
        return { rows: [] };
      }),
    };
    const repository = createChannelFulfillmentAuthorityRepository({
      transaction: (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx),
    });

    const claimed = await repository.claimCommands({
      now,
      leaseToken: "lease-93",
      leaseDurationMs: 120_000,
      limit: 25,
    });

    expect(claimed).toHaveLength(1);
    expect(claimed[0]?.items).toEqual([
      expect.objectContaining({
        physicalShipmentItemId: 300,
        packageAllocationEntryId: null,
        legacyWmsShipmentItemId: 700,
        quantity: 2,
      }),
      expect.objectContaining({
        physicalShipmentItemId: 301,
        packageAllocationEntryId: 9001,
        legacyWmsShipmentItemId: 701,
        quantity: 1,
      }),
    ]);
    const itemQuery = queries.map(render).find((query) =>
      query.includes("FROM oms.channel_fulfillment_push_items AS push_item"),
    );
    expect(itemQuery).toContain("LEFT JOIN wms.package_allocation_entries AS allocation_entry");
    expect(itemQuery).toContain("LEFT JOIN wms.package_allocation_source_lines AS allocation_source");
    expect(itemQuery).toContain(
      "COALESCE( physical_item.legacy_wms_shipment_item_id, physical_item.label_replacement_source_item_id, allocation_source.source_wms_shipment_item_id )",
    );
  });
});
