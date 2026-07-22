/**
 * C7 Phase 3 tests: Write-back core hardening.
 *
 * Tests for:
 * - D-ENQFAIL: Dead-letter event persisted when retry enqueue fails
 * - D-PUSHAUDIT: versioned package-completion evidence recorded after Shopify reconciliation
 * - D-PUSHIDEM: legacy ID persistence cannot masquerade as completion
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

describe("D-PUSHAUDIT: OMS package-completion evidence", () => {
  it("records versioned, line-sensitive completion evidence", () => {
    const evidenceStart = FULFILLMENT_PUSH_SRC.indexOf(
      "async function recordShopifyWritebackEvidence",
    );
    const evidenceEnd = FULFILLMENT_PUSH_SRC.indexOf(
      "async function",
      evidenceStart + 10,
    );
    const evidenceBlock = FULFILLMENT_PUSH_SRC.substring(evidenceStart, evidenceEnd);
    expect(evidenceBlock).toContain("wmsShipmentId");
    expect(evidenceBlock).toContain("trackingNumber");
    expect(evidenceBlock).toContain("coverageVersion");
    expect(evidenceBlock).toContain("packageSignature");
    expect(evidenceBlock).toContain("writebackComplete");
    expect(evidenceBlock).toContain("requestedQuantity");
    expect(evidenceBlock).toContain("lineEvidence");
  });

  it("uses event type matching what reconcilers and ops-health query for", () => {
    const pushFnStart = FULFILLMENT_PUSH_SRC.indexOf(
      "async function pushSingleShipmentFulfillment",
    );
    const pushFnEnd = FULFILLMENT_PUSH_SRC.indexOf(
      "async function",
      pushFnStart + 10,
    );
    const fnBlock = FULFILLMENT_PUSH_SRC.substring(pushFnStart, pushFnEnd);
    expect(fnBlock).toContain("shopify_fulfillment_pushed");
    expect(fnBlock).not.toMatch(/eventType:\s*"fulfillment_pushed"/);
  });

  it("requires a valid OMS order id before evidence can be persisted", () => {
    const evidenceBlock = FULFILLMENT_PUSH_SRC.substring(
      FULFILLMENT_PUSH_SRC.indexOf("async function recordShopifyWritebackEvidence"),
      FULFILLMENT_PUSH_SRC.indexOf("async function pushFulfillmentForCombinedGroup"),
    );
    expect(evidenceBlock).toContain("oms_fulfillment_order_id");
    expect(evidenceBlock).toContain("Number.isInteger(omsOrderId)");
    expect(evidenceBlock).toContain("cannot record reconciled writeback without an OMS order id");
  });

  it("fails closed when completion evidence cannot be persisted", () => {
    const auditBlock = FULFILLMENT_PUSH_SRC.substring(
      FULFILLMENT_PUSH_SRC.indexOf("D-PUSHAUDIT"),
      FULFILLMENT_PUSH_SRC.indexOf("shopify_push_succeeded"),
    );
    expect(auditBlock).toContain("await recordShopifyWritebackEvidence");
    expect(auditBlock).not.toContain("catch (auditErr");
  });
});

// ─── D-PUSHIDEM structural checks ────────────────────────────────

describe("D-PUSHIDEM: legacy fulfillment handle persistence", () => {
  it("uses conditional UPDATE with NULL guard when persisting fulfillment ID", () => {
    const persistBlock = FULFILLMENT_PUSH_SRC.substring(
      FULFILLMENT_PUSH_SRC.indexOf("D-PUSHIDEM"),
      FULFILLMENT_PUSH_SRC.indexOf("D-PUSHAUDIT"),
    );
    expect(persistBlock).toContain("shopify_fulfillment_id IS NULL");
    expect(persistBlock).toContain("rowCount");
  });

  it("does not treat a preserved legacy handle as package completion", () => {
    const persistBlock = FULFILLMENT_PUSH_SRC.substring(
      FULFILLMENT_PUSH_SRC.indexOf("D-PUSHIDEM"),
      FULFILLMENT_PUSH_SRC.indexOf("D-PUSHAUDIT"),
    );
    expect(persistBlock).toContain("recorded additional fulfillment");
    expect(persistBlock).not.toContain("alreadyPushed: true");
    expect(persistBlock).not.toContain("return {");
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
    const migrationPath = fileURLToPath(
      new URL(
        "../../../../../migrations/0572_webhook_retry_queue_pending_dedup.sql",
        import.meta.url,
      ),
    );
    expect(existsSync(migrationPath)).toBe(true);

    const sql = readFileSync(migrationPath, "utf8");
    expect(sql).toContain("CREATE UNIQUE INDEX");
    expect(sql).toContain("uq_webhook_retry_queue_pending_dedup");
    expect(sql).toContain("status = 'pending'");
    expect(sql).toContain("shipmentId");
  });
});
