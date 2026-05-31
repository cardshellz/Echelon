/**
 * C7 Phase 3 tests: Write-back core hardening.
 *
 * Tests for:
 * - D-ENQFAIL: Dead-letter event persisted when retry enqueue fails
 * - D-PUSHAUDIT: OMS event recorded on successful Shopify push
 * - D-PUSHIDEM: FOR UPDATE on idempotency check serializes concurrent pushes
 * - D-RETRYDEDUP: DB-level dedup on webhook_retry_queue pending rows
 */

import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHIPSTATION_SRC = readFileSync(
  fileURLToPath(new URL("../../shipstation.service.ts", import.meta.url)),
  "utf8",
);

const FULFILLMENT_PUSH_SRC = readFileSync(
  fileURLToPath(new URL("../../fulfillment-push.service.ts", import.meta.url)),
  "utf8",
);

const WEBHOOK_RETRY_SRC = readFileSync(
  fileURLToPath(new URL("../../webhook-retry.worker.ts", import.meta.url)),
  "utf8",
);

// ─── D-ENQFAIL structural checks ─────────────────────────────────

describe("D-ENQFAIL: dead-letter on enqueue failure", () => {
  it("persists dead-letter event when Shopify push + retry enqueue both fail", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("async function pushShopifyFulfillmentFromShipNotify"),
      SHIPSTATION_SRC.indexOf(
        "async function",
        SHIPSTATION_SRC.indexOf("async function pushShopifyFulfillmentFromShipNotify") + 10,
      ),
    );
    expect(fnBlock).toContain("fulfillment_push_enqueue_failed");
    expect(fnBlock).toContain("requiresReview: true");
    expect(fnBlock).toContain("pushError");
    expect(fnBlock).toContain("enqueueError");
  });

  it("persists dead-letter for service-unavailable enqueue failure", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("fulfillment push service not available on db.__fulfillmentPush"),
      SHIPSTATION_SRC.indexOf("const result = await fulfillmentPush.pushShopifyFulfillment"),
    );
    expect(fnBlock).toContain("fulfillment_push_enqueue_failed");
    expect(fnBlock).toContain("requiresReview: true");
  });

  it("persists dead-letter for tracking push enqueue failure (enqueueDelayedTrackingPushFromShipNotify)", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("async function enqueueDelayedTrackingPushFromShipNotify"),
      SHIPSTATION_SRC.indexOf(
        "async function",
        SHIPSTATION_SRC.indexOf("async function enqueueDelayedTrackingPushFromShipNotify") + 10,
      ),
    );
    expect(fnBlock).toContain("fulfillment_push_enqueue_failed");
    expect(fnBlock).toContain("requiresReview: true");
  });

  it("persists dead-letter for tracking push enqueue failure (enqueueDelayedTrackingPushForShippedShipment)", () => {
    const fnBlock = SHIPSTATION_SRC.substring(
      SHIPSTATION_SRC.indexOf("async function enqueueDelayedTrackingPushForShippedShipment"),
      SHIPSTATION_SRC.indexOf(
        "async function",
        SHIPSTATION_SRC.indexOf("async function enqueueDelayedTrackingPushForShippedShipment") + 10,
      ),
    );
    expect(fnBlock).toContain("fulfillment_push_enqueue_failed");
    expect(fnBlock).toContain("requiresReview: true");
  });
});

// ─── D-PUSHAUDIT structural checks ───────────────────────────────

describe("D-PUSHAUDIT: OMS event on successful Shopify push", () => {
  it("records fulfillment_pushed event after persisting shopify_fulfillment_id", () => {
    const pushFnStart = FULFILLMENT_PUSH_SRC.indexOf(
      "async function pushSingleShipmentFulfillment",
    );
    const pushFnEnd = FULFILLMENT_PUSH_SRC.indexOf(
      "async function",
      pushFnStart + 10,
    );
    const fnBlock = FULFILLMENT_PUSH_SRC.substring(pushFnStart, pushFnEnd);
    expect(fnBlock).toContain("fulfillment_pushed");
    expect(fnBlock).toContain("shopifyFulfillmentId");
    expect(fnBlock).toContain("wmsShipmentId");
    expect(fnBlock).toContain("trackingNumber");
    expect(fnBlock).toContain("carrier");
  });

  it("resolves OMS order id from oms_fulfillment_order_id", () => {
    const auditBlock = FULFILLMENT_PUSH_SRC.substring(
      FULFILLMENT_PUSH_SRC.indexOf("D-PUSHAUDIT"),
      FULFILLMENT_PUSH_SRC.indexOf("shopify_push_succeeded"),
    );
    expect(auditBlock).toContain("oms_fulfillment_order_id");
    expect(auditBlock).toContain("parseInt");
  });

  it("does not throw on audit event persistence failure", () => {
    const auditBlock = FULFILLMENT_PUSH_SRC.substring(
      FULFILLMENT_PUSH_SRC.indexOf("D-PUSHAUDIT"),
      FULFILLMENT_PUSH_SRC.indexOf("shopify_push_succeeded"),
    );
    expect(auditBlock).toContain("catch (auditErr");
  });
});

// ─── D-PUSHIDEM structural checks ────────────────────────────────

describe("D-PUSHIDEM: FOR UPDATE on idempotency check", () => {
  it("uses FOR UPDATE on the shipment row idempotency check", () => {
    const idempBlock = FULFILLMENT_PUSH_SRC.substring(
      FULFILLMENT_PUSH_SRC.indexOf("Idempotency check (D1)"),
      FULFILLMENT_PUSH_SRC.indexOf("shopify_push_attempted"),
    );
    expect(idempBlock).toContain("FOR UPDATE");
    expect(idempBlock).toContain("shopify_fulfillment_id");
  });
});

// ─── D-RETRYDEDUP structural checks ──────────────────────────────

describe("D-RETRYDEDUP: DB-level dedup on retry queue", () => {
  it("catches 23505 constraint on pending_dedup in enqueueShopifyFulfillmentRetry", () => {
    const fnBlock = WEBHOOK_RETRY_SRC.substring(
      WEBHOOK_RETRY_SRC.indexOf("async function enqueueShopifyFulfillmentRetry"),
      WEBHOOK_RETRY_SRC.indexOf(
        "async function",
        WEBHOOK_RETRY_SRC.indexOf("async function enqueueShopifyFulfillmentRetry") + 10,
      ) > 0
        ? WEBHOOK_RETRY_SRC.indexOf(
            "async function",
            WEBHOOK_RETRY_SRC.indexOf("async function enqueueShopifyFulfillmentRetry") + 10,
          )
        : WEBHOOK_RETRY_SRC.length,
    );
    expect(fnBlock).toContain('err?.code === "23505"');
    expect(fnBlock).toContain("pending_dedup");
  });

  it("catches 23505 constraint on pending_dedup in enqueueDelayedTrackingPush", () => {
    const fnBlock = WEBHOOK_RETRY_SRC.substring(
      WEBHOOK_RETRY_SRC.indexOf("async function enqueueDelayedTrackingPush"),
      WEBHOOK_RETRY_SRC.indexOf(
        "async function",
        WEBHOOK_RETRY_SRC.indexOf("async function enqueueDelayedTrackingPush") + 10,
      ) > 0
        ? WEBHOOK_RETRY_SRC.indexOf(
            "async function",
            WEBHOOK_RETRY_SRC.indexOf("async function enqueueDelayedTrackingPush") + 10,
          )
        : WEBHOOK_RETRY_SRC.length,
    );
    expect(fnBlock).toContain('err?.code === "23505"');
    expect(fnBlock).toContain("pending_dedup");
  });

  it("migration exists for the unique index", () => {
    const migrationPath =
      "/home/user/Echelon/migrations/0572_webhook_retry_queue_pending_dedup.sql";
    expect(existsSync(migrationPath)).toBe(true);

    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("CREATE UNIQUE INDEX");
    expect(sql).toContain("uq_webhook_retry_queue_pending_dedup");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("shipmentId");
  });
});
