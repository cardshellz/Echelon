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
const AUTHORITY_SERVICE_SRC = readFileSync(
  fileURLToPath(new URL("../../channel-fulfillment-authority.service.ts", import.meta.url)),
  "utf8",
);
const AUTHORITY_REPOSITORY_SRC = readFileSync(
  fileURLToPath(new URL("../../channel-fulfillment-authority.repository.ts", import.meta.url)),
  "utf8",
);
const AUTHORITY_MIGRATION_SRC = readFileSync(
  fileURLToPath(new URL("../../../../../migrations/0593_fulfillment_authority_cutover_foundation.sql", import.meta.url)),
  "utf8",
);
const SERVER_INDEX_SRC = readFileSync(
  fileURLToPath(new URL("../../../../index.ts", import.meta.url)),
  "utf8",
);
const SERVICE_REGISTRY_SRC = readFileSync(
  fileURLToPath(new URL("../../../../services/index.ts", import.meta.url)),
  "utf8",
);
const LEGACY_FULFILLMENT_SERVICE_PATH = fileURLToPath(
  new URL("../../../orders/fulfillment.service.ts", import.meta.url),
);

// ─── D-ENQFAIL structural checks ─────────────────────────────────

describe("D-COMMANDFAIL: durable canonical channel commands", () => {
  it("classifies every provider failure into review, retry, or dead-letter", () => {
    expect(AUTHORITY_SERVICE_SRC).toContain('outcome: "review_required"');
    expect(AUTHORITY_SERVICE_SRC).toContain('outcome: exhausted ? "dead_lettered" : "retry_scheduled"');
    expect(AUTHORITY_SERVICE_SRC).toContain("calculateChannelFulfillmentRetryAt");
  });

  it("claims due commands under a bounded lease with skip-locked concurrency", () => {
    expect(AUTHORITY_REPOSITORY_SRC).toContain("FOR UPDATE SKIP LOCKED");
    expect(AUTHORITY_REPOSITORY_SRC).toContain("lease_expires_at");
    expect(AUTHORITY_REPOSITORY_SRC).toContain("attempt_count = attempt_count + 1");
  });

  it("records immutable append-only attempt evidence", () => {
    expect(AUTHORITY_MIGRATION_SRC).toContain("CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_push_attempts");
    expect(AUTHORITY_MIGRATION_SRC).toContain("channel_fulfillment_push_attempts_immutable");
    expect(AUTHORITY_MIGRATION_SRC).toContain("BEFORE UPDATE OR DELETE ON oms.channel_fulfillment_push_attempts");
  });

  it("requires explicit fulfillment authority instead of a database service locator", () => {
    expect(SHIPSTATION_SRC).toContain("requireFulfillmentAuthority().recordPhysicalPackage");
    expect(SHIPSTATION_SRC).not.toContain("db.__fulfillmentPush");
    expect(SHIPSTATION_SRC).not.toContain("db.__channelFulfillmentAuthority");
  });
});

describe("D-SINGLEWRITER: physical shipment projection has one authority", () => {
  it("does not wire the legacy whole-order Shopify fulfillment writer", () => {
    expect(existsSync(LEGACY_FULFILLMENT_SERVICE_PATH)).toBe(false);
    expect(SERVICE_REGISTRY_SRC).not.toContain("createFulfillmentService");
  });

  it("does not infer WMS shipped state from an OMS aggregate", () => {
    const reconcileBlock = SERVER_INDEX_SRC.slice(
      SERVER_INDEX_SRC.indexOf("OMS<->WMS cancellation reconciliation"),
      SERVER_INDEX_SRC.indexOf("Startup reconciliation for orders"),
    );
    expect(reconcileBlock).toContain("oms.status IN ('cancelled', 'refunded')");
    expect(reconcileBlock).not.toContain("markOrderShipped");
    expect(reconcileBlock).not.toContain("oms.status IN ('cancelled', 'shipped', 'refunded')");
  });

  it("does not force item fulfillment quantities during application startup", () => {
    expect(SERVER_INDEX_SRC).not.toContain("Completed ${itemFix.rows.length} orphaned item(s)");
    expect(SERVER_INDEX_SRC).not.toMatch(
      /UPDATE wms\.order_items oi SET\s+status = 'completed',\s+fulfilled_quantity = oi\.quantity/,
    );
  });

  it("always uses physical-shipment reconciliation without a legacy flag fallback", () => {
    expect(SERVER_INDEX_SRC).not.toContain("runShipStationReconcileV1");
    expect(SERVER_INDEX_SRC).not.toContain("process.env.RECONCILE_V2");
    expect(SERVER_INDEX_SRC).toContain("await runShipStationReconcileV2()");
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
