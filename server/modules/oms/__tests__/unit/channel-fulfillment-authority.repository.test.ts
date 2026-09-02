import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  createChannelFulfillmentAuthorityRepository,
} from "../../channel-fulfillment-authority.repository";

const dialect = new PgDialect();

function render(query: unknown): string {
  return dialect.sqlToQuery(query as any).sql.replace(/\s+/g, " ").trim();
}

describe("channel fulfillment authority repository", () => {
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
      "COALESCE( physical_item.legacy_wms_shipment_item_id, allocation_source.source_wms_shipment_item_id )",
    );
  });
});
