import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const migration = readFileSync(
  join(here, "..", "..", "..", "migrations", "154_carrier_tracking_event_authority.sql"),
  "utf8",
);
const v2WebhookAuthMigration = readFileSync(
  join(here, "..", "..", "..", "migrations", "0591_carrier_tracking_v2_webhook_auth.sql"),
  "utf8",
);

describe("carrier tracking authority migration", () => {
  it("separates labels, label links, label events, authenticated receipts, parse attempts, carrier events, and match attempts", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.shipping_provider_labels");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.shipping_provider_label_links");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.shipping_provider_label_events");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_subscriptions");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_subscription_labels");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_subscription_attempts");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_events");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_webhook_receipts");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_webhook_receipt_parses");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_webhook_hydrations");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_webhook_hydration_attempts");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_event_matches");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS wms.carrier_tracking_reconciliation_state");
  });

  it("allows one label to link to multiple exactly identified shipment targets", () => {
    expect(migration).toContain("NUM_NONNULLS(");
    expect(migration).toContain(") = 1");
    expect(migration).toContain("uq_shipping_provider_label_links_request");
    expect(migration).toContain("uq_shipping_provider_label_links_engine_order");
    expect(migration).toContain("uq_shipping_provider_label_links_physical");
    expect(migration).toContain("uq_shipping_provider_label_links_legacy");
    expect(migration).not.toMatch(/UNIQUE\s*\(\s*shipping_provider_label_id\s*\)/i);
  });

  it("makes evidence and linkage ledgers immutable", () => {
    expect(migration).toContain("shipping_provider_label_links_immutable");
    expect(migration).toContain("shipping_provider_label_events_immutable");
    expect(migration).toContain("carrier_tracking_events_immutable");
    expect(migration).toContain("carrier_tracking_webhook_receipts_immutable");
    expect(migration).toContain("carrier_tracking_webhook_receipt_parses_immutable");
    expect(migration).toContain("carrier_tracking_event_matches_immutable");
    expect(migration).toContain("carrier_tracking_subscription_labels_immutable");
    expect(migration).toContain("carrier_tracking_subscription_attempts_immutable");
    expect(migration).toContain("carrier_tracking_webhook_hydration_attempts_immutable");
    expect(migration.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(9);
    expect(migration).not.toContain("carrier_tracking_reconciliation_state_immutable");
    expect(migration).not.toContain("carrier_tracking_webhook_hydrations_immutable");
  });

  it("keeps retry scheduling in a mutable projection outside the evidence ledger", () => {
    expect(migration).toContain("last_match_attempt_id BIGINT NOT NULL");
    expect(migration).toContain("next_reconcile_at TIMESTAMPTZ");
    expect(migration).toContain("carrier_tracking_reconciliation_state_retry_shape_chk");
    expect(migration).toContain("carrier_tracking_subscriptions_lease_shape_chk");
    expect(migration).toContain("uq_carrier_tracking_subscription_attempts_number");
    expect(migration).toContain("carrier_tracking_webhook_hydrations_lease_shape_chk");
    expect(migration).toContain("uq_carrier_tracking_webhook_hydration_attempts_number");
  });

  it("deduplicates provider enrollment by carrier tuple while allowing many labels per parcel", () => {
    expect(migration).toContain("uq_carrier_tracking_subscriptions_identity UNIQUE(");
    expect(migration).toContain("tracking_provider,");
    expect(migration).toContain("carrier_code,");
    expect(migration).toContain("normalized_tracking_number");
    expect(migration).toContain("uq_carrier_tracking_subscription_labels UNIQUE(");
  });

  it("retains exact signed request evidence for independent verification", () => {
    expect(migration).toContain("raw_body_base64 TEXT NOT NULL");
    expect(migration).toContain("signature_base64 TEXT NOT NULL");
    expect(migration).toContain("raw_body_hash VARCHAR(64) NOT NULL");
    expect(migration).toContain("signature_hash VARCHAR(64) NOT NULL");
    expect(migration).toContain("carrier_tracking_webhook_receipt_parses_shape_chk");
    expect(migration).toContain("outcome IN ('normalized', 'rejected')");
  });

  it("does not change live fulfillment or inventory state", () => {
    expect(migration).not.toMatch(/UPDATE\s+(?:oms|wms|inventory)\./i);
    expect(migration).not.toContain("inventory_levels");
    expect(migration).not.toContain("fulfillment_status");
  });

  it("accepts V2 HMAC receipts while preserving historical RSA receipt evidence", () => {
    expect(v2WebhookAuthMigration).toContain("signature_algorithm IN ('RSA-SHA256', 'HMAC-SHA256')");
    expect(v2WebhookAuthMigration).not.toMatch(/UPDATE\s+(?:oms|wms|inventory)\./i);
    expect(v2WebhookAuthMigration).not.toContain("inventory_levels");
    expect(v2WebhookAuthMigration).not.toContain("fulfillment_status");
  });
});
