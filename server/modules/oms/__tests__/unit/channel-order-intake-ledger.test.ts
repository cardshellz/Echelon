import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ebayOrderIsShippable,
  recordChannelOrderFailure,
  recordChannelOrderObservation,
} from "../../channel-order-intake.service";

const migration = readFileSync(
  resolve(process.cwd(), "migrations/152_channel_order_intake_ledger.sql"),
  "utf8",
);

describe("channel order intake ledger", () => {
  it("stores source payloads and links source observations to OMS ingestion", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS oms.channel_order_intakes");
    expect(migration).toContain("raw_payload JSONB");
    expect(migration).toContain("source_observed_at TIMESTAMPTZ");
    expect(migration).toContain("UNIQUE (provider, external_order_id)");
    expect(migration).toContain("channel_order_intake_from_webhook");
    expect(migration).toContain("channel_order_intake_from_shopify_raw");
    expect(migration).toContain("channel_order_intake_from_oms_order");
    expect(migration).toContain("channel_order_intake_from_oms_lines");
    expect(migration).toContain("channel_order_intakes.raw_payload || EXCLUDED.raw_payload");
  });

  it("does not misrepresent an OMS-only fallback as source evidence", () => {
    const omsTriggerStart = migration.indexOf("CREATE OR REPLACE FUNCTION oms.capture_oms_order_intake");
    const omsTriggerEnd = migration.indexOf("DROP TRIGGER IF EXISTS channel_order_intake_from_oms_order", omsTriggerStart);
    const omsTrigger = migration.slice(omsTriggerStart, omsTriggerEnd);

    expect(omsTrigger).toContain("p_status => 'ingested'");
    expect(omsTrigger).toContain("p_is_source_observation => FALSE");
  });

  it("backfills both existing OMS orders and pre-OMS Shopify source rows", () => {
    expect(migration).toContain("FROM oms.oms_orders oo");
    expect(migration).toContain("FROM public.shopify_orders so");
    expect(migration).toContain("FROM oms.webhook_inbox wi");
    expect(migration).toContain("public.shopify_order_items item");
    expect(migration).toContain("TIMESTAMPTZ '2026-07-01 00:00:00+00'");
  });

  it("identifies physical eBay orders from positive-quantity lines", () => {
    expect(ebayOrderIsShippable({ lineItems: [] })).toBe(false);
    expect(ebayOrderIsShippable({ lineItems: [{ quantity: 0 }] })).toBe(false);
    expect(ebayOrderIsShippable({ lineItems: [{ quantity: 1 }] })).toBe(true);
  });

  it("requires the database ledger to acknowledge observations and failures", async () => {
    const execute = vi.fn(async () => ({ rows: [{ id: 41 }] }));
    const database = { execute };
    const observation = {
      provider: "ebay",
      channelId: 67,
      externalOrderId: "24-14885-40737",
      observationMethod: "ebay_poll",
      rawPayload: { orderId: "24-14885-40737", lineItems: [{ quantity: 1 }] },
      isShippable: true,
    };

    await expect(recordChannelOrderObservation(database, observation)).resolves.toBe(41);
    await expect(recordChannelOrderFailure(database, observation, new Error("mapping failed"))).resolves.toBe(41);
    expect(execute).toHaveBeenCalledTimes(2);

    const unavailable = { execute: vi.fn(async () => ({ rows: [] })) };
    await expect(recordChannelOrderObservation(unavailable, observation)).rejects.toThrow(
      "Order intake ledger did not confirm ebay order 24-14885-40737",
    );
  });
});
