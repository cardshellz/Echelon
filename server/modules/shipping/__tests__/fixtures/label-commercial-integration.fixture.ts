import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { shipmentQuantityEvidenceFixtureSql } from "./shipment-quantity-evidence.fixture";
import type { Pool } from "pg";

export async function installProviderExecutionTestRelations(pool: Pool): Promise<void> {
  await pool.query(`
    -- Migration 154 carrier-label insert contract. Install for every test,
    -- rather than relying on a later webhook test to add these columns.
    ALTER TABLE wms.shipping_provider_labels
      ADD COLUMN IF NOT EXISTS last_link_reconciled_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS next_link_reconcile_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS link_reconcile_attempts INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE oms.oms_orders
      ADD COLUMN external_order_number VARCHAR(50),
      ADD COLUMN ordered_at TIMESTAMP NOT NULL,
      ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT now(),
      ADD COLUMN updated_at TIMESTAMP,
      ADD COLUMN fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled',
      ADD COLUMN tracking_number VARCHAR(100),
      ADD COLUMN tracking_carrier VARCHAR(50),
      ADD COLUMN shipped_at TIMESTAMP;
    ALTER TABLE oms.oms_order_lines
      ADD COLUMN sku VARCHAR(100),
      ADD COLUMN shopify_fulfillment_order_id VARCHAR(100),
      ADD COLUMN shopify_fulfillment_order_line_item_id VARCHAR(100),
      ADD COLUMN provider_fulfillment_order_id VARCHAR(200),
      ADD COLUMN provider_fulfillment_order_line_item_id VARCHAR(200),
      ADD COLUMN requires_shipping BOOLEAN DEFAULT true,
      ADD COLUMN fulfillment_status VARCHAR(30) DEFAULT 'unfulfilled',
      ADD COLUMN updated_at TIMESTAMP;
    ALTER TABLE wms.orders
      ADD COLUMN channel_id INTEGER REFERENCES channels.channels(id) ON DELETE SET NULL,
      ADD COLUMN source VARCHAR(20) NOT NULL DEFAULT 'shopify',
      ADD COLUMN external_order_id VARCHAR(100),
      ADD COLUMN combined_group_id INTEGER,
      ADD COLUMN combined_role VARCHAR(20),
      ADD COLUMN picked_count INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN updated_at TIMESTAMP;
    ALTER TABLE wms.order_items
      ADD COLUMN picked_quantity INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN fulfilled_quantity INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN picked_at TIMESTAMP,
      ADD COLUMN requires_shipping INTEGER NOT NULL DEFAULT 1;
    -- Tracking amendments are read by the real OMS projection. No amendment
    -- is synthesized by label activation in these tests.
    CREATE TABLE wms.physical_shipment_tracking_amendments (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      physical_shipment_id BIGINT NOT NULL REFERENCES wms.physical_shipments(id) ON DELETE RESTRICT,
      provider VARCHAR(40) NOT NULL,
      provider_event_id VARCHAR(200),
      request_hash VARCHAR(64) NOT NULL,
      tracking_number VARCHAR(200),
      carrier VARCHAR(100),
      tracking_url TEXT,
      occurred_at TIMESTAMPTZ NOT NULL,
      source VARCHAR(80) NOT NULL,
      raw_payload JSONB NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (physical_shipment_id, request_hash)
    );
    ALTER TABLE wms.outbound_shipments
      ADD COLUMN channel_id INTEGER REFERENCES channels.channels(id),
      ADD COLUMN engine_shipment_ref VARCHAR(100),
      ADD COLUMN shopify_fulfillment_id VARCHAR(100);
    CREATE TABLE oms.oms_order_events (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      order_id BIGINT NOT NULL REFERENCES oms.oms_orders(id) ON DELETE CASCADE,
      event_type VARCHAR(50) NOT NULL,
      details JSONB,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_oms_events_order ON oms.oms_order_events(order_id);

    -- Exact attempt/audit contract from 0593_fulfillment_authority_cutover_foundation.sql.
    CREATE TABLE oms.channel_fulfillment_push_attempts (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      channel_fulfillment_push_id BIGINT NOT NULL
        REFERENCES oms.channel_fulfillment_pushes(id) ON DELETE RESTRICT,
      attempt_number INTEGER NOT NULL,
      outcome VARCHAR(30) NOT NULL,
      request_hash VARCHAR(64) NOT NULL,
      provider_response_id VARCHAR(300),
      error_code VARCHAR(100),
      error_message VARCHAR(1000),
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      correlation_id VARCHAR(100),
      causation_id VARCHAR(100),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT channel_fulfillment_push_attempts_number_chk CHECK (attempt_number > 0),
      CONSTRAINT channel_fulfillment_push_attempts_outcome_chk CHECK (
        outcome IN ('success', 'retry_scheduled', 'ignored', 'review_required', 'dead_lettered')
      ),
      CONSTRAINT channel_fulfillment_push_attempts_hash_chk CHECK (
        request_hash ~ '^[0-9a-f]{64}$'
      ),
      CONSTRAINT channel_fulfillment_push_attempts_time_chk CHECK (completed_at >= started_at),
      CONSTRAINT channel_fulfillment_push_attempts_unique
        UNIQUE (channel_fulfillment_push_id, attempt_number)
    );
    CREATE INDEX idx_channel_fulfillment_push_attempts_push
      ON oms.channel_fulfillment_push_attempts(channel_fulfillment_push_id, attempt_number DESC);
    CREATE OR REPLACE FUNCTION oms.reject_channel_fulfillment_attempt_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION '% is append-only; % is not allowed', TG_TABLE_NAME, TG_OP
        USING ERRCODE = '55000';
    END;
    $$;
    CREATE TRIGGER channel_fulfillment_push_attempts_immutable
      BEFORE UPDATE OR DELETE ON oms.channel_fulfillment_push_attempts
      FOR EACH ROW EXECUTE FUNCTION oms.reject_channel_fulfillment_attempt_mutation();

    -- Existing production audit contract from 171_historical_fulfillment_repair_audit.sql.
    CREATE TABLE oms.channel_fulfillment_push_requeues (
      id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      channel_fulfillment_push_id BIGINT NOT NULL REFERENCES oms.channel_fulfillment_pushes(id) ON DELETE RESTRICT,
      idempotency_key VARCHAR(200) NOT NULL,
      operator VARCHAR(200) NOT NULL,
      reason TEXT NOT NULL,
      previous_status VARCHAR(30) NOT NULL,
      previous_attempt_count INTEGER NOT NULL,
      previous_error_code VARCHAR(100),
      previous_error_message TEXT,
      previous_request_hash VARCHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_channel_fulfillment_push_requeues_idempotency UNIQUE(channel_fulfillment_push_id,idempotency_key),
      CHECK (BTRIM(operator) <> ''), CHECK (BTRIM(idempotency_key) <> ''), CHECK (BTRIM(reason) <> ''),
      CHECK (previous_status = 'review'), CHECK (previous_attempt_count >= 0),
      CHECK (previous_request_hash IS NULL OR LENGTH(previous_request_hash) = 64)
    );
    CREATE TRIGGER channel_fulfillment_push_requeues_immutable
      BEFORE UPDATE OR DELETE ON oms.channel_fulfillment_push_requeues
      FOR EACH ROW EXECUTE FUNCTION wms.reject_shipping_evidence_ledger_mutation();
  `);
}


export async function seedCommercialFulfillmentAuthoritySource(
  pool: Pool,
  sku: string,
  quantity: number,
): Promise<number> {
  const channel = await pool.query<{ id: number }>(
    `INSERT INTO channels.channels (name, provider, status)
     VALUES ('Package allocation integration', 'shopify', 'active')
     RETURNING id`,
  );
  const omsOrder = await pool.query<{ id: string }>(
    `INSERT INTO oms.oms_orders (
       external_order_id, channel_id, status, financial_status, ordered_at
     ) VALUES (
       'gid://shopify/Order/640001', $1::integer, 'open', 'paid',
       '2026-08-22T13:00:00.000'::timestamp
     )
     RETURNING id::text AS id`,
    [channel.rows[0].id],
  );
  const omsLine = await pool.query<{ id: string }>(
    `INSERT INTO oms.oms_order_lines (
       order_id, external_line_item_id, fulfillment_provider,
       paid_quantity, authority_fulfillable_quantity
     ) VALUES ($1::bigint, 'gid://shopify/LineItem/640002', 'shopify', $2::integer, $2::integer)
     RETURNING id::text AS id`,
    [omsOrder.rows[0].id, quantity],
  );
  await pool.query(
    `INSERT INTO oms.oms_order_line_authority_events (order_line_id, paid_quantity)
     VALUES ($1::bigint, $2::integer)`,
    [omsLine.rows[0].id, quantity],
  );
  const product = await pool.query<{ id: number }>(
    `INSERT INTO catalog.products (sku, name)
     VALUES ($1, 'Package allocation integration product')
     RETURNING id`,
    [sku],
  );
  const variant = await pool.query<{ id: number }>(
    `INSERT INTO catalog.product_variants (product_id, sku, name)
     VALUES ($1::integer, $2, 'Package allocation integration variant')
     RETURNING id`,
    [product.rows[0].id, sku],
  );
  const order = await pool.query<{ id: number }>(
    `INSERT INTO wms.orders (
       order_number, oms_fulfillment_order_id, source,
       shipping_name, shipping_address, shipping_city,
       shipping_state, shipping_postal_code, shipping_country
     ) VALUES (
       'PACKAGE-COMMERCIAL-640001', $1, 'oms',
       'Integration Customer', '1 Test Way', 'Charlotte',
       'NC', '28202', 'US'
     )
     RETURNING id`,
    [omsOrder.rows[0].id],
  );
  const orderItem = await pool.query<{ id: number }>(
    `INSERT INTO wms.order_items (
       order_id, oms_order_line_id, sku, quantity
     ) VALUES ($1::integer, $2::bigint, $3, $4::integer)
     RETURNING id`,
    [order.rows[0].id, omsLine.rows[0].id, sku, quantity],
  );
  const shipment = await pool.query<{ id: number }>(
    `INSERT INTO wms.outbound_shipments (
       order_id, status, shipment_purpose, shipping_engine,
       engine_order_ref, shipstation_order_key,
       external_fulfillment_id, tracking_number, carrier
     ) VALUES (
       $1::integer, 'pending', 'customer_fulfillment', 'shipstation',
       '99001', 'provider-order-key-99001',
       'shipstation_shipment:44010', '1Z0000000000044010', 'ups'
     )
     RETURNING id`,
    [order.rows[0].id],
  );
  const shipmentItem = await pool.query<{ id: number }>(
    `INSERT INTO wms.outbound_shipment_items (
       shipment_id, order_item_id, shipment_item_purpose,
       product_variant_id, qty
     ) VALUES ($1::integer, $2::integer, 'customer_fulfillment', $3::integer, $4::integer)
     RETURNING id`,
    [shipment.rows[0].id, orderItem.rows[0].id, variant.rows[0].id, quantity],
  );
  return shipmentItem.rows[0].id;
}


export async function seedCanonicalRequestForSource(
  pool: Pool,
  sourceId: number,
): Promise<void> {
  const source = await pool.query<{
    shipment_id: number;
    order_id: number;
    oms_order_id: string;
    oms_line_id: string;
    order_item_id: number;
    product_variant_id: number;
    sku: string;
    qty: number;
  }>(
    `SELECT item.shipment_id, order_item.order_id, oms_line.order_id::text AS oms_order_id,
       oms_line.id::text AS oms_line_id, order_item.id AS order_item_id, item.product_variant_id, order_item.sku, item.qty
     FROM wms.outbound_shipment_items item JOIN wms.order_items order_item ON order_item.id = item.order_item_id
     JOIN oms.oms_order_lines oms_line ON oms_line.id = order_item.oms_order_line_id WHERE item.id = $1`,
    [sourceId],
  );
  const row = source.rows[0];
  const existingPlan = await pool.query<{ id: string }>(
    "SELECT id::text AS id FROM wms.fulfillment_plans WHERE wms_order_id = $1 AND plan_status = 'active'",
    [row.order_id],
  );
  const plan = existingPlan.rows.length > 0 ? existingPlan : await pool.query<{ id: string }>(
    `INSERT INTO wms.fulfillment_plans (oms_order_id, wms_order_id, planner_version)
    VALUES ($1, $2, 'canonical-v1') RETURNING id::text AS id`,
    [row.oms_order_id, row.order_id],
  );
  const line = await pool.query<{ id: string }>(
    `INSERT INTO wms.fulfillment_plan_lines (
    fulfillment_plan_id, oms_order_line_id, wms_order_item_id, product_variant_id, sku, quantity_planned)
    VALUES ($1, $2, $3, $4, $5, $6) RETURNING id::text AS id`,
    [
      plan.rows[0].id,
      row.oms_line_id,
      row.order_item_id,
      row.product_variant_id,
      row.sku,
      row.qty,
    ],
  );
  const existingRequest = await pool.query<{ id: string }>(
    "SELECT id::text AS id FROM wms.shipment_requests WHERE legacy_wms_shipment_id = $1",
    [row.shipment_id],
  );
  const request = existingRequest.rows.length > 0 ? existingRequest : await pool.query<{ id: string }>(
    `INSERT INTO wms.shipment_requests (
    fulfillment_plan_id, wms_order_id, legacy_wms_shipment_id, warehouse_id)
    VALUES ($1, $2, $3, (SELECT warehouse_id FROM wms.orders WHERE id = $2)) RETURNING id::text AS id`,
    [plan.rows[0].id, row.order_id, row.shipment_id],
  );
  await pool.query(
    `INSERT INTO wms.shipment_request_items (shipment_request_id, fulfillment_plan_line_id,
    wms_order_item_id, legacy_wms_shipment_item_id, quantity_requested) VALUES ($1, $2, $3, $4, $5)`,
    [request.rows[0].id, line.rows[0].id, row.order_item_id, sourceId, row.qty],
  );
}


export async function installAuthorityReadinessTestRelations(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE wms.carrier_tracking_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      dispatch_evidence varchar(30) NOT NULL,
      event_occurred_at timestamptz,
      received_at timestamptz NOT NULL
    );

    CREATE TABLE wms.carrier_tracking_event_matches (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      carrier_tracking_event_id bigint NOT NULL
        REFERENCES wms.carrier_tracking_events(id) ON DELETE RESTRICT,
      shipping_provider_label_id bigint NOT NULL
        REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
      attempt_hash varchar(64) NOT NULL,
      match_status varchar(30) NOT NULL
    );

    CREATE TABLE wms.carrier_tracking_reconciliation_state (
      carrier_tracking_event_id bigint PRIMARY KEY
        REFERENCES wms.carrier_tracking_events(id) ON DELETE RESTRICT,
      last_match_attempt_id bigint NOT NULL
        REFERENCES wms.carrier_tracking_event_matches(id) ON DELETE RESTRICT,
      last_match_attempt_hash varchar(64) NOT NULL,
      last_match_status varchar(30) NOT NULL
    );
  `);
}

/** Production SQL contracts shared by the label activation and split suites. */
export async function installLabelCommercialIntegrationFixtures(pool: Pool): Promise<void> {
  const foundation = readFileSync(resolve(process.cwd(), "migrations/0593_fulfillment_authority_cutover_foundation.sql"), "utf8");
  const receiptStart = foundation.indexOf("CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_receipts (");
  const receiptEnd = foundation.indexOf("CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_receipt_attempts (");
  if (receiptStart < 0 || receiptEnd <= receiptStart) throw new Error("Production receipt fixture markers are missing");
  await pool.query(foundation.slice(receiptStart, receiptEnd));
  await pool.query(shipmentQuantityEvidenceFixtureSql);
  await installProviderExecutionTestRelations(pool);
  await pool.query(readFileSync(resolve(process.cwd(), "migrations/0675_channel_fulfillment_silent_review_retry.sql"), "utf8"));
  await installAuthorityReadinessTestRelations(pool);
}
