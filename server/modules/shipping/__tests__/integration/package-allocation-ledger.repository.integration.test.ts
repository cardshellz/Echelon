import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";
import { parseFlags, runBackfill, type BackfillCandidate } from "../../../../../scripts/backfill-channel-fulfillment-authority";
import { createPackageAllocationLabelCommercialWorkflow } from "../../../../services/package-allocation-label-commercial-workflow";

import {
  closeTestDb,
  describeWithDisposableDb,
  getTestDb,
  getTestPool,
  runMigrations,
  truncateTestData,
} from "../../../../../test/setup-integration";
import { createChannelFulfillmentAuthorityRepository } from "../../../oms/channel-fulfillment-authority.repository";
import { CHANNEL_FULFILLMENT_REPAIR_SOURCES } from "../../../oms/channel-fulfillment-notification.policy";
import { planChannelFulfillmentCommands } from "../../../oms/channel-fulfillment-command";
import { createChannelFulfillmentReviewRetryRepository } from "../../../oms/channel-fulfillment-review-retry.repository";
import {
  createChannelFulfillmentAuthorityService,
  createCompatibilityChannelFulfillmentProviderExecutor,
} from "../../../oms/channel-fulfillment-authority.service";
import { createFulfillmentPushService } from "../../../oms/fulfillment-push.service";
import { createShipStationService } from "../../../oms/shipstation.service";
import { CarrierTrackingService } from "../../carrier-tracking.service";
import { createDrizzleCarrierTrackingRepository } from "../../carrier-tracking.repository";
import { EbayApiClient } from "../../../channels/adapters/ebay/ebay-api.client";
import type { ShopifyAdminGraphQLClient } from "../../../shopify/admin-gql-client";
import { PackageAllocationLabelCommercialFulfillmentService } from "../../package-allocation-label-commercial-fulfillment.service";
import type {
  PackageAllocationEffectIntentV1,
  PackageAllocationEntryV1,
} from "../../package-allocation-group.domain";
import {
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES,
  PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_REQUIRED_RELATIONS,
} from "../../package-allocation-authority-discovery.query";
import {
  PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL,
  PACKAGE_ALLOCATION_DISCOVERY_INDEX_CATALOG_SQL,
  PACKAGE_ALLOCATION_DISCOVERY_RELATION_ASSERTION_SQL,
} from "../../package-allocation-authority-discovery-plan-audit.repository";
import {
  auditPackageAllocationAuthorityDiscoveryExecution,
  type PackageAllocationDiscoveryExecutionAuditReport,
} from "../../package-allocation-authority-discovery-execution-audit.repository";
import { packageAllocationPackageKey } from "../../package-allocation-authority-resolution.domain";
import { resolvePackageAllocationAuthorityEvidence } from "../../package-allocation-authority-resolution.service";
import { assessVoidedLabelExclusion } from "../../package-allocation-voided-label.domain";
import { PackageAllocationAuthorityReadinessService } from "../../package-allocation-authority-readiness.service";
import { PackageAllocationAuthorityResolutionPreviewService } from "../../package-allocation-authority-resolution.service";
import {
  derivePackageAllocationBootstrapGroupKey,
  PackageAllocationBootstrapPersistenceService,
} from "../../package-allocation-bootstrap.service";
import {
  PACKAGE_ALLOCATION_AUTHORITY_PREVIEW_REQUIRED_RELATIONS,
  PgPackageAllocationLedgerRepository,
  readObservedPackagesForSources,
  type PersistedPackageAllocationEffectOutboxEntry,
  type PersistedPackageAllocationEntry,
  type PersistedPackageAllocationIntent,
} from "../../package-allocation-ledger.repository";
import {
  PACKAGE_ALLOCATION_PLANNER_VERSION,
  packageAllocationPlanAuthoritySnapshotSchema,
  PackageAllocationPlanningService,
  type PersistPackageAllocationPlanCommand,
  type PersistPackageAllocationPlanResult,
} from "../../package-allocation-planning.service";
import { loadHistoricalShipStationContentsCandidates } from "../../historical-shipstation-contents-audit.repository";
import type { HistoricalShipStationContentsClient } from "../../historical-shipstation-contents-audit.client";
import { PgHistoricalShipStationContentsAttestationRepository } from "../../historical-shipstation-contents-attestation.repository";
import { HistoricalShipStationContentsAttestationService } from "../../historical-shipstation-contents-attestation.service";
import {
  buildHistoricalShipStationContentsRecoveryEvidence,
  buildHistoricalShipStationContentsSystemRecoveryEvent,
  historicalShipStationRecoverableCaseEvidenceHash,
} from "../../historical-shipstation-contents-recovery.domain";
import { PgHistoricalShipStationContentsSystemRecoveryRepository } from "../../historical-shipstation-contents-system-recovery.repository";
import { HistoricalShipStationContentsSystemRecoveryService } from "../../historical-shipstation-contents-system-recovery.service";
import { PgHistoricalShipStationContentsReviewRepository } from "../../historical-shipstation-contents-review.repository";
import { HistoricalShipStationContentsReviewService } from "../../historical-shipstation-contents-review.service";
import { PgHistoricalShipStationContentsCorrectionRepository } from "../../historical-shipstation-contents-correction.repository";
import { HistoricalShipStationContentsCorrectionService } from "../../historical-shipstation-contents-correction.service";
import { projectPersistedDeclaredPackageLifecycleShadow } from "../../declared-package-lifecycle-shadow.domain";
import { shipmentQuantityEvidenceFixtureSql } from "../fixtures/shipment-quantity-evidence.fixture";

const PRIMARY_GROUP_KEY = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";
const COMPETING_GROUP_KEY = "96e1be0d-c7d8-4c91-919f-04f5eb547f80";
const CONCURRENCY_TEST_TIMEOUT_MS = 20_000;
const BARRIER_TIMEOUT_MS = 5_000;
const EXECUTION_AUDIT_ROLE = "package_allocation_discovery_execution_auditor";

/**
 * The named-schema fixture stops at command persistence. These additional
 * columns use shared/schema/{oms,orders}.schema.ts definitions so this suite
 * can execute the real provider adapter and persist its writeback audit too.
 * No provider or owner SQL is mocked.
 */
async function installProviderExecutionTestRelations(pool: Pool): Promise<void> {
  await pool.query(`
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

interface LedgerCounts {
  readonly groups: number;
  readonly sourceLines: number;
  readonly memberships: number;
  readonly allocationKeys: number;
  readonly packageBindings: number;
  readonly plans: number;
  readonly entries: number;
  readonly intents: number;
  readonly effectOutbox: number;
}

interface QueryContext {
  readonly client: PoolClient;
  readonly text: string;
  readonly values: readonly unknown[];
}

interface RepositoryTelemetry {
  beginCount: number;
  readonly postgresCodes: string[];
}

type BeforeQuery = (context: QueryContext) => Promise<void>;

function postgresErrorCode(error: unknown): string | null {
  const code = (error as { readonly code?: unknown } | null)?.code;
  return typeof code === "string" ? code : null;
}

function positiveSafeIntegerFromPostgres(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} is not a positive safe integer`);
  }
  return parsed;
}

function instrumentedPool(
  basePool: Pool,
  telemetry: RepositoryTelemetry,
  beforeQuery: BeforeQuery,
): Pick<Pool, "connect"> {
  return {
    connect: async () => {
      const client = await basePool.connect();
      const wrapped = {
        query: async (text: string, values: readonly unknown[] = []) => {
          if (text === "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE") {
            telemetry.beginCount += 1;
          }
          try {
            await beforeQuery({ client, text, values });
            return values.length === 0
              ? await client.query(text)
              : await client.query(text, [...values]);
          } catch (error) {
            const code = postgresErrorCode(error);
            if (code !== null) telemetry.postgresCodes.push(code);
            throw error;
          }
        },
        release: (error?: Error | boolean) => client.release(error),
      };
      return wrapped as unknown as PoolClient;
    },
  } as Pick<Pool, "connect">;
}

async function waitForBarrier(
  barrier: Promise<void>,
  label: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      barrier,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          BARRIER_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function firstWaveBarrier(
  label: string,
  matches: (context: QueryContext) => boolean,
  snapshotSql: string,
): BeforeQuery {
  const expectedArrivals = 2;
  let claimedSlots = 0;
  let completedSnapshots = 0;
  let releaseBarrier: (() => void) | undefined;
  const barrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  return async (context) => {
    if (!matches(context) || claimedSlots >= expectedArrivals) return;
    claimedSlots += 1;
    await context.client.query(snapshotSql);
    completedSnapshots += 1;
    if (completedSnapshots === expectedArrivals) releaseBarrier?.();
    await waitForBarrier(barrier, label);
  };
}

async function seedCustomerFulfillmentSource(
  pool: Pool,
  sku: string,
  quantity: number,
): Promise<number> {
  const order = await pool.query<{ id: number }>(
    "INSERT INTO wms.orders DEFAULT VALUES RETURNING id",
  );
  const orderItem = await pool.query<{ id: number }>(
    `INSERT INTO wms.order_items (order_id, sku, quantity)
     VALUES ($1::integer, $2, $3::integer)
     RETURNING id`,
    [order.rows[0].id, sku, quantity],
  );
  const shipmentItem = await pool.query<{ id: number }>(
    `INSERT INTO wms.outbound_shipment_items (
       order_item_id, shipment_item_purpose, qty
     ) VALUES ($1::integer, 'customer_fulfillment', $2::integer)
     RETURNING id`,
    [orderItem.rows[0].id, quantity],
  );
  return shipmentItem.rows[0].id;
}

async function seedCommercialFulfillmentAuthoritySource(
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
       order_number, oms_fulfillment_order_id,
       shipping_name, shipping_address, shipping_city,
       shipping_state, shipping_postal_code, shipping_country
     ) VALUES (
       'PACKAGE-COMMERCIAL-640001', $1,
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

/** Pre-label queue lineage, matching the canonical owner materializer's existing
 * plan/request contracts. This prevents the test from registering a legacy-only
 * source and then silently changing its immutable source identity after labeling. */
async function seedCanonicalRequestForSource(
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
  const plan = await pool.query<{ id: string }>(
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
  const request = await pool.query<{ id: string }>(
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

async function seedOutboundBusinessShipmentLabel(
  pool: Pool,
  input: {
    readonly providerPhysicalShipmentId: string;
    readonly trackingNumber: string;
    readonly labelStatus: "active" | "voided";
    readonly ordinal: number;
    readonly carrier?: string;
  },
): Promise<void> {
  const label = await pool.query<{ id: string }>(
    `INSERT INTO wms.shipping_provider_labels (
       provider, provider_label_id, provider_order_id, provider_order_key,
       tracking_number, normalized_tracking_number, label_status, label_direction,
       carrier, service_code, first_observed_at, last_observed_at
      ) VALUES (
        'shipstation', $1, '99001', 'provider-order-key-99001',
        $2, $2, $3, 'outbound', $4, 'ups_ground',
        '2026-08-22T14:00:00.000Z', '2026-08-22T14:00:00.000Z'
      )
      RETURNING id::text AS id`,
    [
      input.providerPhysicalShipmentId,
      input.trackingNumber,
      input.labelStatus,
      input.carrier ?? "ups",
    ],
  );
  await pool.query(
    `INSERT INTO wms.shipping_provider_label_events (
       shipping_provider_label_id, event_hash, event_type, label_status,
       tracking_number, provider_occurred_at, received_at, sanitized_payload
     ) VALUES (
       $1::bigint, $2, 'label_observed', 'active',
       $3, '2026-08-22T13:59:50.000Z', '2026-08-22T14:00:00.000Z',
       '{"isReturnLabel":false}'::jsonb
     )`,
    [
      label.rows[0].id,
      input.ordinal.toString(16).padStart(64, "0"),
      input.trackingNumber,
    ],
  );
}

async function installAuthorityReadinessTestRelations(pool: Pool): Promise<void> {
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

async function installExecutionAuditRole(pool: Pool): Promise<void> {
  const requiredRelations = PACKAGE_ALLOCATION_AUTHORITY_PREVIEW_REQUIRED_RELATIONS;
  await pool.query(`
    DO $role$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = '${EXECUTION_AUDIT_ROLE}'
      ) THEN
        CREATE ROLE ${EXECUTION_AUDIT_ROLE}
          NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
          NOREPLICATION NOBYPASSRLS;
      END IF;
    END
    $role$;
    ALTER ROLE ${EXECUTION_AUDIT_ROLE}
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
      NOREPLICATION NOBYPASSRLS;
    GRANT USAGE ON SCHEMA catalog, wms, oms, channels TO ${EXECUTION_AUDIT_ROLE};
    GRANT SELECT ON TABLE ${requiredRelations.join(", ")}
      TO ${EXECUTION_AUDIT_ROLE};
  `);
}

async function removeExecutionAuditRole(pool: Pool): Promise<void> {
  await pool.query(`
    DROP OWNED BY ${EXECUTION_AUDIT_ROLE};
    DROP ROLE IF EXISTS ${EXECUTION_AUDIT_ROLE};
  `);
}

async function withExecutionAuditRole<T>(
  pool: Pool,
  work: (scopedPool: Pick<Pool, "connect">) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  let result: T | undefined;
  let primaryFailure: unknown;
  let resetFailure: unknown;
  try {
    await client.query(`SET ROLE ${EXECUTION_AUDIT_ROLE}`);
    const scopedPool = {
      connect: async () => ({
        query: client.query.bind(client),
        release: () => undefined,
      } as unknown as PoolClient),
    } as Pick<Pool, "connect">;
    result = await work(scopedPool);
  } catch (error) {
    primaryFailure = error;
  } finally {
    try {
      await client.query("RESET ROLE");
    } catch (error) {
      resetFailure = error;
    }
    client.release(resetFailure instanceof Error ? resetFailure : undefined);
  }
  if (primaryFailure !== undefined && resetFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, resetFailure],
      "Execution-audit role work and role reset both failed",
    );
  }
  if (primaryFailure !== undefined) throw primaryFailure;
  if (resetFailure !== undefined) throw resetFailure;
  return result as T;
}

async function seedAuthorityReadinessLabel(
  pool: Pool,
  sourceId: number,
  options: {
    readonly providerLabelId?: string;
    readonly carrierCode?: string;
    readonly trackingNumber?: string;
    readonly providerOrderId?: string;
    readonly contentsStatus?: "authoritative" | "empty";
    readonly contentsLines?: readonly { readonly lineItemKey: string; readonly quantity: number }[];
    readonly receivedAt?: string;
    readonly voidDate?: string;
    readonly persistedVoidAt?: string;
  } = {},
): Promise<number> {
  const trackingNumber = options.trackingNumber ?? "1Z999AA10123456784";
  const providerLabelId = options.providerLabelId ?? "44001";
  const receivedAt = options.receivedAt ?? "2026-08-23T14:00:00.000Z";
  const labelStatus = options.voidDate ? "voided" : "active";
  const hasAuthoritativeContents = (options.contentsStatus ?? "authoritative") === "authoritative";
  const contentsLines = hasAuthoritativeContents
    ? options.contentsLines ?? [{ lineItemKey: `wms-item-${sourceId}`, quantity: 2 }] : [];
  const payload = {
    payloadSchemaVersion: 2,
    ...(options.carrierCode ? { carrierCode: options.carrierCode } : {}),
    providerLabelId,
    trackingNumber,
    observationSource: "shipstation_shipment_observation",
    sourceObservationHash: "f".repeat(64),
    createDate: null,
    shipDate: null,
    voidDate: options.voidDate ?? null,
    isReturnLabel: false,
    declaredContentsEvidence: {
      evidenceSchemaVersion: 1,
      status: hasAuthoritativeContents ? "authoritative" : "empty",
      providerItemCount: contentsLines.length,
      recognizedProviderItemCount: contentsLines.length,
      canonicalLineCount: contentsLines.length,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
      rejectedItemCount: 0,
      reviewRequired: !hasAuthoritativeContents,
      lines: contentsLines,
    },
  };
  const label = await pool.query<{ id: string }>(
    `INSERT INTO wms.shipping_provider_labels (
       provider, provider_label_id, provider_order_id, tracking_number,
       label_status, label_direction, first_observed_at, last_observed_at, voided_at
     ) VALUES ('shipstation', $1, $2, $3, $5, 'outbound', $4, $4, $6)
     RETURNING id::text AS id`,
    [providerLabelId, options.providerOrderId ?? null, trackingNumber, receivedAt,
      labelStatus, options.persistedVoidAt ?? null],
  );
  const labelId = positiveSafeIntegerFromPostgres(
    label.rows[0].id,
    "shipping_provider_labels.id",
  );
  const eventHash = createHash("sha256").update(canonicalJson({
    provider: "shipstation",
    ...payload,
    labelStatus,
  })).digest("hex");
  await pool.query(
    `INSERT INTO wms.shipping_provider_label_events (
       shipping_provider_label_id, event_hash, event_type, label_status,
       tracking_number, provider_occurred_at, received_at, sanitized_payload
     ) VALUES ($1, $2, $6, $7, $3, $8, $4, $5::jsonb)`,
    [labelId, eventHash, trackingNumber, receivedAt, JSON.stringify(payload),
      options.voidDate ? "label_voided" : "label_observed", labelStatus, options.persistedVoidAt ?? null],
  );
  return labelId;
}

async function seedAuthorityDiscoveryRelations(
  pool: Pool,
  sourceId: number,
  linkedLabelId: number,
  providerOrderId: string,
): Promise<void> {
  const shipment = await pool.query<{ id: number }>(
    "INSERT INTO wms.outbound_shipments DEFAULT VALUES RETURNING id",
  );
  await pool.query(
    `UPDATE wms.outbound_shipment_items
     SET shipment_id = $1::integer
     WHERE id = $2::integer`,
    [shipment.rows[0].id, sourceId],
  );
  const request = await pool.query<{ id: string }>(
    `INSERT INTO wms.shipment_requests (legacy_wms_shipment_id)
     VALUES ($1::integer)
     RETURNING id::text AS id`,
    [shipment.rows[0].id],
  );
  await pool.query(
    `INSERT INTO wms.shipment_request_items (
       shipment_request_id, legacy_wms_shipment_item_id
     ) VALUES ($1::bigint, $2::integer)`,
    [request.rows[0].id, sourceId],
  );
  const engineOrder = await pool.query<{ id: string }>(
    `INSERT INTO wms.shipping_engine_orders (
       shipment_request_id, provider, provider_order_id
     ) VALUES ($1::bigint, 'shipstation', $2)
     RETURNING id::text AS id`,
    [request.rows[0].id, providerOrderId],
  );
  await pool.query(
    `INSERT INTO wms.shipping_engine_order_requests (
       shipping_engine_order_id, shipment_request_id
     ) VALUES ($1::bigint, $2::bigint)`,
    [engineOrder.rows[0].id, request.rows[0].id],
  );
  await pool.query(
    `INSERT INTO wms.shipping_provider_label_links (
       shipping_provider_label_id, shipping_engine_order_id
     ) VALUES ($1::bigint, $2::bigint)`,
    [linkedLabelId, engineOrder.rows[0].id],
  );
}

function commandFor(
  sourceWmsShipmentItemId: number,
  overrides: {
    readonly groupKey?: string;
    readonly packageKey?: string;
    readonly providerPhysicalShipmentId?: string;
    readonly trackingNumber?: string;
  } = {},
): PersistPackageAllocationPlanCommand {
  const groupKey = overrides.groupKey ?? PRIMARY_GROUP_KEY;
  const packageKey = overrides.packageKey ?? "package-a";
  const providerPhysicalShipmentId = overrides.providerPhysicalShipmentId ?? "44001";
  const trackingNumber = overrides.trackingNumber ?? "1Z0000000000044001";
  return {
    contractVersion: 1,
    authorityMode: "shadow_only",
    groupKey,
    expectedGroupVersion: 0,
    sourceLines: [{
      wmsShipmentItemId: sourceWmsShipmentItemId,
      sourceQuantity: 2,
      physicalConsumptionAuthorityQuantity: 2,
      authorityVersion: 1,
    }],
    packages: [{
      packageKey,
      allocationRole: "primary",
      membership: {
        status: "proven",
        evidenceKey: `membership:${packageKey}`,
      },
      lifecycle: {
        provider: "shipstation",
        providerPhysicalShipmentId,
        events: [{
          kind: "outbound_label_observed",
          eventKey: `shipstation:${providerPhysicalShipmentId}:observed`,
          observedAt: "2026-08-22T14:00:00.000Z",
          providerOccurredAt: "2026-08-22T13:59:50.000Z",
          trackingNumber,
          contentsEvidence: {
            status: "authoritative",
            lines: [{ wmsShipmentItemId: sourceWmsShipmentItemId, quantity: 2 }],
          },
        }],
      },
    }],
    actions: [],
    writeContext: {
      createdBy: "package-allocation-postgres-integration",
      reason: "Prove transactional package allocation persistence",
    },
  };
}

async function loadLedgerCounts(pool: Pool): Promise<LedgerCounts> {
  const result = await pool.query<LedgerCounts>(
    `SELECT
       (SELECT COUNT(*)::integer FROM wms.package_allocation_groups) AS "groups",
       (SELECT COUNT(*)::integer FROM wms.package_allocation_source_lines) AS "sourceLines",
       (SELECT COUNT(*)::integer FROM wms.package_allocation_group_source_lines) AS "memberships",
       (SELECT COUNT(*)::integer FROM wms.package_allocation_keys) AS "allocationKeys",
       (SELECT COUNT(*)::integer FROM wms.package_allocation_package_bindings) AS "packageBindings",
       (SELECT COUNT(*)::integer FROM wms.package_allocation_plans) AS "plans",
       (SELECT COUNT(*)::integer FROM wms.package_allocation_entries) AS "entries",
       (SELECT COUNT(*)::integer FROM wms.package_allocation_effect_intents) AS "intents",
       (SELECT COUNT(*)::integer FROM wms.package_allocation_effect_outbox) AS "effectOutbox"`,
  );
  return result.rows[0];
}

function expectedEntry(
  entry: PackageAllocationEntryV1,
): PersistedPackageAllocationEntry {
  return {
    entryKey: entry.entryKey,
    allocationKey: entry.allocationKey,
    sourceWmsShipmentItemId: entry.wmsShipmentItemId,
    allocationKind: entry.allocationKind,
    targetKind: entry.targetKind,
    packageKey: entry.packageKey,
    shippingProviderLabelId: null,
    quantity: entry.quantity,
  };
}

function expectedIntent(
  intent: PackageAllocationEffectIntentV1,
): PersistedPackageAllocationIntent {
  return {
    intentKey: intent.intentKey,
    effectType: intent.effectType,
    payloadHash: intent.payloadHash,
    sourceWmsShipmentItemId: intent.wmsShipmentItemId,
    packageKey: intent.packageKey,
    shippingProviderLabelId: null,
    quantity: intent.quantity,
    payload: {
      effectType: intent.effectType,
      subjectKey: intent.subjectKey,
      wmsShipmentItemId: intent.wmsShipmentItemId,
      packageKey: intent.packageKey,
      quantity: intent.quantity,
    },
    executable: false,
  };
}

function expectedEffectOutbox(
  intent: PackageAllocationEffectIntentV1,
): PersistedPackageAllocationEffectOutboxEntry {
  return {
    intentKey: intent.intentKey,
    idempotencyKey: intent.intentKey,
    payloadHash: intent.payloadHash,
    state: "shadow",
    executionEnabled: false,
    attemptCount: 0,
  };
}

function fulfilledValues(
  results: readonly PromiseSettledResult<PersistPackageAllocationPlanResult>[],
): PersistPackageAllocationPlanResult[] {
  return results.flatMap((result) => (
    result.status === "fulfilled" ? [result.value] : []
  ));
}

const DISCOVERY_INDEX_NAMES = [
  "idx_physical_shipment_items_request_item_lookup",
  "idx_physical_shipments_engine_order_lookup",
  "idx_shipping_provider_label_links_request_lookup",
  "idx_shipping_provider_label_links_engine_order_lookup",
  "idx_shipping_provider_label_links_physical_lookup",
  "idx_shipping_provider_label_links_legacy_lookup",
  "idx_shipping_provider_labels_provider_order_id_lookup",
  "idx_shipping_provider_labels_provider_order_key_lookup",
] as const;

interface CapturedDiscoveryQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

function queryResult(rows: readonly Record<string, unknown>[]) {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows: [...rows],
  };
}

async function captureProductionDiscoveryQuery(): Promise<CapturedDiscoveryQuery> {
  const capture: { current: CapturedDiscoveryQuery | null } = { current: null };
  const client = {
    query: async (text: string, values: readonly unknown[] = []) => {
      if (text.includes("WITH selected_sources AS MATERIALIZED")) {
        capture.current = { text, values: [...values] };
        return queryResult([{
          source_count: 1,
          found_source_ids: [1],
          shipping_provider_label_id: "1",
          relationship_types: ["shipment_request_link"],
        }]);
      }
      return queryResult([]);
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const repository = new PgPackageAllocationLedgerRepository({
    connect: async () => client,
  } as Pick<Pool, "connect">);

  await repository.withSerializableTransaction((transaction) =>
    transaction.discoverAuthorityReadinessPackageSelection([1]),
  );
  if (capture.current === null) {
    throw new Error("Production package-discovery SQL was not captured");
  }
  return capture.current;
}

function recordValue(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} is not a PostgreSQL plan object`);
  }
  return value as Record<string, unknown>;
}

function explainPlanRoot(value: unknown): Record<string, unknown> {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("PostgreSQL EXPLAIN JSON did not contain one root document");
  }
  return recordValue(recordValue(parsed[0], "EXPLAIN document").Plan, "EXPLAIN root");
}

function planIndexNames(root: Record<string, unknown>): readonly string[] {
  const names = new Set<string>();
  const pending: Record<string, unknown>[] = [root];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (typeof node["Index Name"] === "string") {
      names.add(node["Index Name"]);
    }
    const children = node.Plans;
    if (Array.isArray(children)) {
      for (const child of children) {
        pending.push(recordValue(child, "EXPLAIN child plan"));
      }
    }
  }
  return [...names].sort();
}

describeWithDisposableDb("Package allocation ledger PostgreSQL guarantees", () => {
  let pool: Pool;

  beforeAll(async () => {
    await runMigrations();
    pool = getTestPool();
    // The focused foundation omits ingress receipts. Install the exact
    // production table/index contract used by retired-label footprint reads.
    const foundation = readFileSync(resolve(process.cwd(), "migrations/0593_fulfillment_authority_cutover_foundation.sql"), "utf8");
    const receiptStart = foundation.indexOf("CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_receipts (");
    const receiptEnd = foundation.indexOf("CREATE TABLE IF NOT EXISTS oms.channel_fulfillment_receipt_attempts (");
    if (receiptStart < 0 || receiptEnd <= receiptStart) throw new Error("Production receipt fixture markers are missing");
    await pool.query(foundation.slice(receiptStart, receiptEnd));
    // Historical correction now projects immutable dispatch evidence even when
    // this legacy package fixture has no canonical receipts to read.
    await pool.query(shipmentQuantityEvidenceFixtureSql);
    await installProviderExecutionTestRelations(pool);
    await pool.query(readFileSync(resolve(process.cwd(), "migrations/0675_channel_fulfillment_silent_review_retry.sql"), "utf8"));
    await installAuthorityReadinessTestRelations(pool);
    await installExecutionAuditRole(pool);
  }, 30_000);

  beforeEach(async () => {
    await truncateTestData();
  });

  afterAll(async () => {
    let roleCleanupFailure: unknown;
    if (pool) {
      try {
        await removeExecutionAuditRole(pool);
      } catch (error) {
        roleCleanupFailure = error;
      }
    }
    try {
      await closeTestDb();
    } catch (error) {
      if (roleCleanupFailure !== undefined) {
        throw new AggregateError([roleCleanupFailure, error], "Integration cleanup failed");
      }
      throw error;
    }
    if (roleCleanupFailure !== undefined) throw roleCleanupFailure;
  });

  it.each(["late_void", "void_first", "both_grouped", "rollback", "concurrent", "worker_projection_failure", "health", "processing", "competing", "repeated"])("conserves eBay combined relabel authority: %s", async mode => {
    const first = await seedCommercialFulfillmentAuthoritySource(pool, "EBAY-RELABEL-A", 2);
    const second = await seedCommercialFulfillmentAuthoritySource(pool, "EBAY-RELABEL-B", 1);
    await pool.query("UPDATE channels.channels SET provider = 'ebay'");
    await pool.query("UPDATE oms.oms_orders SET external_order_id = 'ebay-order-' || id");
    await pool.query("UPDATE oms.oms_order_lines SET fulfillment_provider = 'ebay', external_line_item_id = 'ebay-line-' || id");
    await seedCanonicalRequestForSource(pool, first);
    await seedCanonicalRequestForSource(pool, second);
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let workerTime = new Date("2026-09-18T12:00:00Z");
    const clock = { now: () => new Date(workerTime) };
    async function advanceWorkerClockToDueCommands() {
      // Command admission uses PostgreSQL now(). A fixed test date eventually
      // precedes that deadline. Advance this injected worker clock from the
      // persisted schedule, rounding past PostgreSQL's sub-millisecond precision.
      const { rows } = await pool.query<{ due_at: Date | null }>(
        "SELECT MAX(next_attempt_at) + INTERVAL '1 millisecond' AS due_at FROM oms.channel_fulfillment_pushes",
      );
      if (rows[0].due_at && rows[0].due_at > workerTime) workerTime = rows[0].due_at;
    }
    const workflow = createPackageAllocationLabelCommercialWorkflow({ pool, clock, logger });
    let failBeforeCommit = false;
    const replacementReviews = vi.fn();
    const handler = new PackageAllocationLabelCommercialFulfillmentService({ enabled: true, logger,
      labelLinker: { reconcileShipStationLabel: vi.fn().mockResolvedValue({ linksInserted: 0, totalLinks: 0 }) },
      reviewRepository: { record: replacementReviews },
      workflow: { run: work => workflow.run(async context => {
        const result = await work(context);
        if (failBeforeCommit) throw new Error("injected replacement rollback");
        return result;
      }) },
    });
    async function makeLabel(providerLabelId: string, items: { lineItemKey: string; quantity: number }[]) {
      const id = await seedAuthorityReadinessLabel(pool, first, { providerLabelId, providerOrderId: "99001", carrierCode: "ups",
        trackingNumber: `TRACK${providerLabelId}`, contentsLines: items, receivedAt: "2026-09-17T12:00:00Z" });
      await pool.query("UPDATE wms.shipping_provider_labels SET carrier = 'ups' WHERE id = $1", [id]);
      await pool.query(`INSERT INTO wms.shipping_provider_label_links (shipping_provider_label_id, legacy_wms_shipment_id)
        SELECT DISTINCT $1::bigint, shipment_id FROM wms.outbound_shipment_items WHERE id = ANY($2::integer[])`,
        [id, items.map(item => Number(item.lineItemKey.replace("wms-item-", "")))]);
      const shipment = { shipmentId: Number(providerLabelId), orderId: 99001, trackingNumber: `TRACK${providerLabelId}`,
        isReturnLabel: false, shipmentItems: items };
      return { id, receive: () => handler.process(shipment, { shippingProviderLabelId: String(id) } as any) };
    }
    const a = { lineItemKey: `wms-item-${first}`, quantity: 2 };
    const b = { lineItemKey: `wms-item-${second}`, quantity: 1 };
    const original = await makeLabel("44010", [a]);
    const originalResult = await original.receive();
    expect(originalResult, JSON.stringify({ originalResult, logs: logger.warn.mock.calls, reviews: replacementReviews.mock.calls })).toMatchObject({ outcome: "activated" });
    const originalB = mode === "both_grouped" ? await makeLabel("44012", [b]) : null;
    if (originalB) expect(await originalB.receive()).toMatchObject({ outcome: "activated" });
    const replacement = await makeLabel("44011", [a, b]);
    if (mode === "late_void") {
      expect(await replacement.receive()).toMatchObject({ outcome: "waiting", reason: "awaiting_replaced_label_void" });
      expect((await pool.query("SELECT SUM(quantity_shipped)::int AS qty FROM wms.effective_physical_shipment_items")).rows).toEqual([{ qty: 2 }]);
    }
    async function voidLabel(oldId: number) {
      const old = (await pool.query("SELECT sanitized_payload FROM wms.shipping_provider_label_events WHERE shipping_provider_label_id = $1 ORDER BY id LIMIT 1", [oldId])).rows[0].sanitized_payload;
      const payload = { ...old, voidDate: "2026-09-17T13:00:00Z" };
      const hash = createHash("sha256").update(canonicalJson({ provider: "shipstation", ...payload, labelStatus: "voided" })).digest("hex");
      await pool.query(`INSERT INTO wms.shipping_provider_label_events (shipping_provider_label_id, event_hash, event_type,
        label_status, tracking_number, provider_occurred_at, received_at, sanitized_payload)
        VALUES ($1, $2, 'label_voided', 'voided', $3, '2026-09-17T13:00:00Z', '2026-09-17T13:00:00Z', $4)`, [oldId, hash, payload.trackingNumber, payload]);
      await pool.query("UPDATE wms.shipping_provider_labels SET label_status = 'voided', last_observed_at = '2026-09-17T13:00:00Z' WHERE id = $1", [oldId]);
    }
    for (const oldId of [original.id, ...(originalB ? [originalB.id] : [])]) await voidLabel(oldId);
    if (mode === "competing") {
      await makeLabel("44013", [a, b]);
      expect(await replacement.receive()).toMatchObject({ outcome: "review", reason: "multiple_active_replacement_candidates" });
      expect((await pool.query("SELECT id FROM wms.physical_shipment_item_quantity_adjustments")).rowCount).toBe(0);
      expect((await pool.query("SELECT id FROM inventory.inventory_transactions")).rowCount).toBe(0);
      return;
    }
    if (mode === "processing") {
      await pool.query("UPDATE oms.channel_fulfillment_pushes SET push_status = 'processing'");
      expect(await replacement.receive()).toMatchObject({ outcome: "waiting", reason: "previous_channel_command_processing" });
      expect((await pool.query("SELECT id FROM wms.physical_shipment_item_quantity_adjustments")).rowCount).toBe(0);
      await pool.query("UPDATE oms.channel_fulfillment_pushes SET push_status = 'success'");
    }
    if (mode === "rollback") {
      failBeforeCommit = true;
      await expect(replacement.receive()).rejects.toThrow("injected replacement rollback");
      expect((await pool.query("SELECT id FROM wms.physical_shipment_item_quantity_adjustments")).rowCount).toBe(0);
      expect((await pool.query("SELECT SUM(quantity_shipped)::int AS qty FROM wms.effective_physical_shipment_items")).rows).toEqual([{ qty: 2 }]);
      failBeforeCommit = false;
    }
    if (mode === "worker_projection_failure") {
      const workerRepository = createChannelFulfillmentAuthorityRepository(getTestDb());
      const applied = await workerRepository.reconcileEbayLabelReplacement!(replacement.id, clock.now());
      expect(applied).toMatchObject({ outcome: "applied" });
      await advanceWorkerClockToDueCommands();
      const worker = createChannelFulfillmentAuthorityService({ repository: workerRepository, clock, logger,
        projector: { projectPhysicalShipment: vi.fn().mockRejectedValue(new Error("injected projection failure")) },
        providerExecutor: { execute: vi.fn().mockRejectedValue(new Error("Provider must remain blocked")) },
      });
      expect(await worker.runDueBatch({ limit: 25 })).toMatchObject({ claimed: 0 });
      expect(await workerRepository.findWaitingEbayLabelReplacements!(25)).toEqual([replacement.id]);
    }
    const results = mode === "concurrent"
      ? await Promise.all([replacement.receive(), replacement.receive()]) : [await replacement.receive()];
    for (const result of results) expect(result, JSON.stringify(result)).toMatchObject({ outcome: "replaced", commandIds: expect.any(Array) });
    expect(await replacement.receive()).toMatchObject({ outcome: "replaced" });
    expect((await pool.query("SELECT quantity_planned, quantity_shipped FROM wms.fulfillment_plan_lines ORDER BY id")).rows)
      .toEqual([{ quantity_planned: 2, quantity_shipped: 2 }, { quantity_planned: 1, quantity_shipped: 1 }]);
    expect((await pool.query(`SELECT package.tracking_number, item.quantity_shipped FROM wms.effective_physical_shipment_items item
      JOIN wms.physical_shipments package ON package.id = item.physical_shipment_id ORDER BY item.wms_order_item_id`)).rows)
      .toEqual([{ tracking_number: "TRACK44011", quantity_shipped: 2 }, { tracking_number: "TRACK44011", quantity_shipped: 1 }]);
    const repository = createChannelFulfillmentAuthorityRepository(getTestDb());
    await advanceWorkerClockToDueCommands();
    const commands = await repository.claimCommands({ now: clock.now(), limit: 25, leaseToken: "relabel-test", leaseDurationMs: 120000 });
    expect(commands).toHaveLength(2);
    expect(commands.map(command => command.items[0].legacyWmsShipmentItemId).sort()).toEqual([first, second]);
    expect(commands.every(command => command.trackingNumber === "TRACK44011" && command.metadata.trackingReplacement === true)).toBe(true);
    const providerOrders = (await pool.query(`SELECT orders.id, orders.channel_id, orders.external_order_id, line.external_line_item_id,
      line.paid_quantity FROM oms.oms_orders orders JOIN oms.oms_order_lines line ON line.order_id = orders.id ORDER BY orders.id`)).rows;
    const providerPackages = new Map<string, { fulfillmentId: string; shipmentTrackingNumber: string; shippedDate: string;
      lineItems: { lineItemId: string; quantity: number }[] }[]>();
    providerOrders.forEach((order, index) => providerPackages.set(order.external_order_id, index === 0 || originalB ? [{
      fulfillmentId: `provider-${order.id}`, shipmentTrackingNumber: index === 0 ? "TRACK44010" : "TRACK44012",
      shippedDate: "2026-09-17T12:00:00Z", lineItems: [{ lineItemId: order.external_line_item_id, quantity: order.paid_quantity }],
    }] : []));
    const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith("/ws/api.dll")) {
        const orderId = /<OrderID>([^<]+)<\/OrderID>/.exec(String(init?.body))?.[1];
        const existing = orderId ? providerPackages.get(orderId) : undefined;
        if (!existing?.[0]) throw new Error("Unexpected amendment order scope");
        existing[0] = { ...existing[0], shipmentTrackingNumber: "TRACK44011" };
        return new Response("<CompleteSaleResponse><Ack>Success</Ack></CompleteSaleResponse>");
      }
      const order = providerOrders.find(order => path.includes(`/order/${order.external_order_id}`));
      if (!order) throw new Error("Unexpected provider account/order request");
      const packages = providerPackages.get(order.external_order_id)!;
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(packages).toHaveLength(0);
        packages.push({ fulfillmentId: `provider-${order.id}`, shipmentTrackingNumber: body.trackingNumber,
          shippedDate: body.shippedDate, lineItems: body.lineItems });
        return new Response(null, { status: 201, headers: { Location: `${path}/provider-${order.id}` } });
      }
      if (path.endsWith("/shipping_fulfillment")) return Response.json({ fulfillments: packages });
      return Response.json({ orderId: order.external_order_id, orderFulfillmentStatus: "FULFILLED",
        cancelStatus: { cancelState: "NONE_REQUESTED", cancelRequests: [] },
        lineItems: [{ lineItemId: order.external_line_item_id, quantity: order.paid_quantity, lineItemFulfillmentStatus: "FULFILLED" }] });
    });
    const push = createFulfillmentPushService(getTestDb(), null, { providerClients: {
      shopify: async () => { throw new Error("Unexpected Shopify account"); },
      ebay: async channelId => ({ channelId, externalAccountId: `account-${channelId}`,
        client: new EbayApiClient({ getAccessToken: async () => "test-token" }, channelId, "sandbox", { request, strictFulfillmentReadback: true }) }),
    } });
    const executor = createCompatibilityChannelFulfillmentProviderExecutor(push);
    for (const command of commands) {
      await expect(executor.execute(command)).resolves.toMatchObject({ outcome: "success", providerResponseId: `provider-${command.omsOrderId}` });
    }
    const mutationCount = request.mock.calls.filter(call => call[1]?.method === "POST").length;
    expect(mutationCount).toBe(2);
    for (const command of commands) await executor.execute(command);
    expect(request.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(mutationCount);
    expect([...providerPackages.values()].map(packages => packages[0].shipmentTrackingNumber)).toEqual(["TRACK44011", "TRACK44011"]);
    // Carrier finalization reuses the proven replacement package and commands.
    await pool.query("UPDATE wms.outbound_shipments SET status = 'shipped', tracking_number = 'TRACK44011'");
    const shipmentIds = (await pool.query("SELECT id FROM wms.outbound_shipments ORDER BY id")).rows.map(row => row.id);
    const dispatchReplay = await repository.materializePhysicalPackage({ legacyWmsShipmentIds: shipmentIds,
      shippingProvider: "shipstation", providerPhysicalShipmentId: "44011", providerOrderId: "99001",
      trackingNumber: "TRACK44011", carrier: "ups", shippedAt: clock.now(), source: "carrier_tracking_confirmed_dispatch",
      legacyHeaderPolicy: "aggregate_projection" });
    expect(dispatchReplay.channelCommands.map(command => command.id)).toEqual(commands.map(command => command.id));
    expect((await pool.query("SELECT SUM(quantity_shipped)::int AS qty FROM wms.effective_physical_shipment_items")).rows).toEqual([{ qty: 3 }]);

    if (mode === "health") {
      const { findChannelWritebackCandidates } = await import("../../../oms/channel-writeback.service");
      await pool.query("ALTER TABLE wms.orders ADD COLUMN source_table_id VARCHAR(100)");
      await pool.query("UPDATE wms.orders SET source = 'oms'");
      await pool.query(`CREATE TABLE oms.webhook_retry_queue (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, provider TEXT NOT NULL,
        status TEXT NOT NULL, topic TEXT NOT NULL, payload JSONB NOT NULL)`);
      // Empty inbound receipt relations complete the health reader's schema;
      // this scenario only produces outbound canonical commands.
      await pool.query(`CREATE TABLE oms.channel_fulfillment_receipt_items (
        id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, receipt_id BIGINT NOT NULL,
        legacy_wms_shipment_item_id INTEGER, quantity INTEGER NOT NULL)`);
      await pool.query("UPDATE wms.outbound_shipments SET shipped_at = NOW() - INTERVAL '2 hours'");
      await pool.query(`INSERT INTO oms.oms_order_events(order_id, event_type, details)
        SELECT orders.oms_fulfillment_order_id::bigint, 'tracking_pushed',
          jsonb_build_object('wmsShipmentId', shipment.id, 'trackingNumber', 'TRACK44010')
        FROM wms.outbound_shipments shipment JOIN wms.orders orders ON orders.id = shipment.order_id`);
      const candidates = () => findChannelWritebackCandidates(getTestDb(), {
        provider: "ebay", minAgeMinutes: 1, maxAgeDays: null, excludeRetryStates: false,
      });
      // Both tracking_pushed events exist, but each current command must settle.
      expect(await candidates()).toHaveLength(2);
      await pool.query("UPDATE oms.channel_fulfillment_pushes SET push_status = 'success' WHERE id = $1", [commands[0].id]);
      expect(await candidates()).toHaveLength(1);
      await pool.query("UPDATE oms.channel_fulfillment_pushes SET push_status = 'success' WHERE id = $1", [commands[1].id]);
      expect(await candidates()).toHaveLength(0);
    }

    expect((await pool.query("SELECT tracking_number FROM oms.oms_orders ORDER BY id")).rows)
      .toEqual([{ tracking_number: "TRACK44011" }, { tracking_number: "TRACK44011" }]);
    expect((await pool.query("SELECT id FROM inventory.inventory_transactions")).rowCount).toBe(0);
    expect((await pool.query("SELECT qty FROM wms.outbound_shipment_items ORDER BY id")).rows).toEqual([{ qty: 2 }, { qty: 1 }]);
    if (mode === "repeated") {
      await pool.query("UPDATE oms.channel_fulfillment_pushes SET push_status = 'success' WHERE id = ANY($1::integer[])", [commands.map(command => command.id)]);
      await voidLabel(replacement.id);
      const next = await makeLabel("44014", [a, b]);
      expect(await next.receive()).toMatchObject({ outcome: "replaced" });
      expect((await pool.query(`SELECT package.tracking_number, item.quantity_shipped FROM wms.effective_physical_shipment_items item
        JOIN wms.physical_shipments package ON package.id = item.physical_shipment_id ORDER BY item.wms_order_item_id`)).rows)
        .toEqual([{ tracking_number: "TRACK44014", quantity_shipped: 2 }, { tracking_number: "TRACK44014", quantity_shipped: 1 }]);
      expect((await pool.query("SELECT id FROM wms.physical_shipment_item_quantity_adjustments")).rowCount).toBe(3);
      expect((await pool.query("SELECT id FROM inventory.inventory_transactions")).rowCount).toBe(0);
    }
  }, 20000);

  it("records one immutable business-shipped fact for an explicit outbound label observation", async () => {
    const label = await pool.query<{ id: number }>(
      `INSERT INTO wms.shipping_provider_labels (
         provider,
         provider_label_id,
         tracking_number,
         label_status,
         label_direction,
         first_observed_at,
         last_observed_at
       ) VALUES (
         'shipstation',
         'phase-2-outbound-label',
         '1ZPHASE2OUTBOUND',
         'active',
         'outbound',
         '2026-09-01T20:00:00.000Z',
         '2026-09-01T20:00:00.000Z'
       )
       RETURNING id`,
    );
    const event = await pool.query<{ id: number }>(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id,
         event_hash,
         event_type,
         label_status,
         tracking_number,
         provider_occurred_at,
         received_at,
         sanitized_payload
       ) VALUES (
         $1::bigint,
         $2,
         'label_observed',
         'active',
         '1ZPHASE2OUTBOUND',
         '2026-09-01T19:59:00.000Z',
         '2026-09-01T20:00:00.000Z',
         '{"isReturnLabel":false}'::jsonb
       )
       RETURNING id`,
      [label.rows[0].id, "b".repeat(64)],
    );

    const facts = await pool.query<{
      shipping_provider_label_id: number;
      recognition_event_id: number;
      business_shipment_recognized_at: Date;
      provider_occurred_at: Date;
      recognition_source: string;
    }>(
      `SELECT
         shipping_provider_label_id,
         recognition_event_id,
         business_shipment_recognized_at,
         provider_occurred_at,
         recognition_source
       FROM wms.declared_package_business_shipments`,
    );
    expect(facts.rows).toEqual([{
      shipping_provider_label_id: label.rows[0].id,
      recognition_event_id: event.rows[0].id,
      business_shipment_recognized_at: new Date("2026-09-01T20:00:00.000Z"),
      provider_occurred_at: new Date("2026-09-01T19:59:00.000Z"),
      recognition_source: "outbound_label_observed",
    }]);

    await pool.query(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id,
         event_hash,
         event_type,
         label_status,
         tracking_number,
         provider_occurred_at,
         received_at,
         sanitized_payload
       ) VALUES (
         $1::bigint,
         $2,
         'label_observed',
         'active',
         '1ZPHASE2OUTBOUND',
         '2026-09-01T20:01:00.000Z',
         '2026-09-01T20:02:00.000Z',
         '{"isReturnLabel":false}'::jsonb
       )`,
      [label.rows[0].id, "c".repeat(64)],
    );
    const factCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM wms.declared_package_business_shipments`,
    );
    expect(factCount.rows).toEqual([{ count: 1 }]);
    await expect(pool.query(
      `UPDATE wms.declared_package_business_shipments
       SET recognition_source = 'forged'
       WHERE shipping_provider_label_id = $1::bigint`,
      [label.rows[0].id],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("does not create or permit a business-shipped fact for return or void-only evidence", async () => {
    const label = await pool.query<{ id: number }>(
      `INSERT INTO wms.shipping_provider_labels (
         provider,
         provider_label_id,
         tracking_number,
         label_status,
         label_direction,
         first_observed_at,
         last_observed_at
       ) VALUES (
         'shipstation',
         'phase-2-return-label',
         '1ZPHASE2RETURN',
         'active',
         'return',
         '2026-09-01T21:00:00.000Z',
         '2026-09-01T21:00:00.000Z'
       )
       RETURNING id`,
    );
    const event = await pool.query<{ id: number }>(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id,
         event_hash,
         event_type,
         label_status,
         tracking_number,
         provider_occurred_at,
         received_at,
         sanitized_payload
       ) VALUES (
         $1::bigint,
         $2,
         'label_observed',
         'active',
         '1ZPHASE2RETURN',
         NULL,
         '2026-09-01T21:00:00.000Z',
         '{"isReturnLabel":true}'::jsonb
       )
       RETURNING id`,
      [label.rows[0].id, "d".repeat(64)],
    );
    const factCount = await pool.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM wms.declared_package_business_shipments`,
    );
    expect(factCount.rows).toEqual([{ count: 0 }]);

    await expect(pool.query(
      `INSERT INTO wms.declared_package_business_shipments (
         shipping_provider_label_id,
         recognition_event_id,
         business_shipment_recognized_at,
         provider_occurred_at,
         recognition_source
       ) VALUES (
         $1::bigint,
         $2::bigint,
         '2026-09-01T21:00:00.000Z',
         NULL,
         'outbound_label_observed'
       )`,
      [label.rows[0].id, event.rows[0].id],
    )).rejects.toMatchObject({ code: "23514" });

    const voidedLabel = await pool.query<{ id: number }>(
      `INSERT INTO wms.shipping_provider_labels (
         provider,
         provider_label_id,
         tracking_number,
         label_status,
         label_direction,
         first_observed_at,
         last_observed_at
       ) VALUES (
         'shipstation',
         'phase-2-void-only-label',
         '1ZPHASE2VOIDONLY',
         'voided',
         'outbound',
         '2026-09-01T22:00:00.000Z',
         '2026-09-01T22:00:00.000Z'
       )
       RETURNING id`,
    );
    const voidEvent = await pool.query<{ id: number }>(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id,
         event_hash,
         event_type,
         label_status,
         tracking_number,
         provider_occurred_at,
         received_at,
         sanitized_payload
       ) VALUES (
         $1::bigint,
         $2,
         'label_voided',
         'voided',
         '1ZPHASE2VOIDONLY',
         '2026-09-01T21:59:00.000Z',
         '2026-09-01T22:00:00.000Z',
         '{"isReturnLabel":false}'::jsonb
       )
       RETURNING id`,
      [voidedLabel.rows[0].id, "e".repeat(64)],
    );
    expect((await pool.query<{ count: number }>(
      `SELECT COUNT(*)::integer AS count
       FROM wms.declared_package_business_shipments`,
    )).rows).toEqual([{ count: 0 }]);
    await expect(pool.query(
      `INSERT INTO wms.declared_package_business_shipments (
         shipping_provider_label_id,
         recognition_event_id,
         business_shipment_recognized_at,
         provider_occurred_at,
         recognition_source
       ) VALUES (
         $1::bigint,
         $2::bigint,
         '2026-09-01T22:00:00.000Z',
         '2026-09-01T21:59:00.000Z',
         'outbound_label_observed'
       )`,
      [voidedLabel.rows[0].id, voidEvent.rows[0].id],
    )).rejects.toMatchObject({ code: "23514" });
  });

  it("executes historical ShipStation WMS-content recovery queries under the restricted role", async () => {
    const legacyOrder = await pool.query<{ id: number }>(
      "INSERT INTO wms.orders DEFAULT VALUES RETURNING id",
    );
    const legacyOrderItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.order_items (order_id, sku, quantity)
       VALUES ($1::integer, 'LEGACY-SKU', 3)
       RETURNING id`,
      [legacyOrder.rows[0].id],
    );
    const legacyShipment = await pool.query<{ id: number }>(
      "INSERT INTO wms.outbound_shipments DEFAULT VALUES RETURNING id",
    );
    const legacyItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipment_items (
         shipment_id, order_item_id, shipment_item_purpose, qty
       ) VALUES ($1::integer, $2::integer, 'customer_fulfillment', 3)
       RETURNING id`,
      [legacyShipment.rows[0].id, legacyOrderItem.rows[0].id],
    );
    const legacyLabel = await pool.query<{ id: string }>(
      `INSERT INTO wms.shipping_provider_labels (
         provider, provider_label_id, tracking_number, label_status,
         label_direction, first_observed_at, last_observed_at
       ) VALUES (
         'shipstation', '44001', '1ZRECOVERYLEGACY', 'active',
         'outbound', '2026-08-25T12:00:00.000Z', '2026-08-25T12:00:00.000Z'
       ) RETURNING id::text AS id`,
    );
    await pool.query(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id, event_hash, event_type, label_status,
         tracking_number, provider_occurred_at, received_at, sanitized_payload
       ) VALUES (
         $1::bigint, $2, 'label_observed', 'active', '1ZRECOVERYLEGACY',
         NULL, '2026-08-25T12:00:00.000Z', '{"payloadSchemaVersion":1}'::jsonb
       )`,
      [legacyLabel.rows[0].id, "a".repeat(64)],
    );
    await pool.query(
      `INSERT INTO wms.shipping_provider_label_links (
         shipping_provider_label_id, legacy_wms_shipment_id
       ) VALUES ($1::bigint, $2::integer)`,
      [legacyLabel.rows[0].id, legacyShipment.rows[0].id],
    );

    const physicalOrder = await pool.query<{ id: number }>(
      "INSERT INTO wms.orders DEFAULT VALUES RETURNING id",
    );
    const physicalOrderItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.order_items (order_id, sku, quantity)
       VALUES ($1::integer, 'LEGACY-DIFFERENT-SKU', 2)
       RETURNING id`,
      [physicalOrder.rows[0].id],
    );
    const physicalLegacyShipment = await pool.query<{ id: number }>(
      "INSERT INTO wms.outbound_shipments DEFAULT VALUES RETURNING id",
    );
    const physicalLegacyItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipment_items (
         shipment_id, order_item_id, shipment_item_purpose, qty
       ) VALUES ($1::integer, $2::integer, 'customer_fulfillment', 2)
       RETURNING id`,
      [physicalLegacyShipment.rows[0].id, physicalOrderItem.rows[0].id],
    );
    const physicalShipment = await pool.query<{ id: string }>(
      `INSERT INTO wms.physical_shipments (provider, provider_physical_shipment_id)
       VALUES ('shipstation', '44002')
       RETURNING id::text AS id`,
    );
    await pool.query(
      `INSERT INTO wms.physical_shipment_items (
         physical_shipment_id, legacy_wms_shipment_item_id, sku, quantity_shipped
       ) VALUES ($1::bigint, $2::integer, 'PHYSICAL-SKU', 2)`,
      [physicalShipment.rows[0].id, physicalLegacyItem.rows[0].id],
    );
    const physicalLabel = await pool.query<{ id: string }>(
      `INSERT INTO wms.shipping_provider_labels (
         provider, provider_label_id, tracking_number, label_status,
         label_direction, first_observed_at, last_observed_at
       ) VALUES (
         'shipstation', '44002', '1ZRECOVERYPHYSICAL', 'active',
         'outbound', '2026-08-25T12:01:00.000Z', '2026-08-25T12:01:00.000Z'
       ) RETURNING id::text AS id`,
    );
    await pool.query(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id, event_hash, event_type, label_status,
         tracking_number, provider_occurred_at, received_at, sanitized_payload
       ) VALUES (
         $1::bigint, $2, 'label_observed', 'active', '1ZRECOVERYPHYSICAL',
         NULL, '2026-08-25T12:01:00.000Z', '{"payloadSchemaVersion":1}'::jsonb
       )`,
      [physicalLabel.rows[0].id, "b".repeat(64)],
    );
    await pool.query(
      `INSERT INTO wms.shipping_provider_label_links (
         shipping_provider_label_id, physical_shipment_id, legacy_wms_shipment_id
       ) VALUES ($1::bigint, $2::bigint, $3::integer)`,
      [
        physicalLabel.rows[0].id,
        physicalShipment.rows[0].id,
        physicalLegacyShipment.rows[0].id,
      ],
    );

    const { batch, firstPage, secondPage } = await withExecutionAuditRole(pool, async (scopedPool) => {
      const client = await scopedPool.connect();
      const batch = await loadHistoricalShipStationContentsCandidates(client, { candidateLimit: 10 });
      const firstPage = await loadHistoricalShipStationContentsCandidates(
        client,
        { candidateLimit: 1 },
      );
      if (firstPage.nextBeforeLabelId === null) {
        throw new Error("Expected the first historical-content page to expose a continuation cursor");
      }
      const secondPage = await loadHistoricalShipStationContentsCandidates(client, {
        candidateLimit: 1,
        beforeLabelId: firstPage.nextBeforeLabelId,
      });
      return {
        batch,
        firstPage,
        secondPage,
      };
    });

    expect(batch).toMatchObject({
      candidateLimit: 10,
      beforeLabelId: null,
      nextBeforeLabelId: null,
      batchLimitReached: false,
      databaseTemporaryPrivilege: true,
    });
    expect(batch.candidates.map((candidate) => candidate.shippingProviderLabelId)).toEqual([
      physicalLabel.rows[0].id,
      legacyLabel.rows[0].id,
    ]);
    expect(firstPage).toMatchObject({
      candidateLimit: 1,
      beforeLabelId: null,
      nextBeforeLabelId: physicalLabel.rows[0].id,
      batchLimitReached: true,
      databaseTemporaryPrivilege: true,
    });
    expect(firstPage.candidates.map((candidate) => candidate.shippingProviderLabelId)).toEqual([
      physicalLabel.rows[0].id,
    ]);
    expect(secondPage).toMatchObject({
      candidateLimit: 1,
      beforeLabelId: physicalLabel.rows[0].id,
      nextBeforeLabelId: null,
      batchLimitReached: false,
      databaseTemporaryPrivilege: true,
    });
    expect(secondPage.candidates.map((candidate) => candidate.shippingProviderLabelId)).toEqual([
      legacyLabel.rows[0].id,
    ]);

    const byProviderShipmentId = new Map(
      batch.candidates.map((candidate) => [candidate.providerShipmentId, candidate]),
    );
    expect(byProviderShipmentId.get(44_001)).toEqual({
      shippingProviderLabelId: legacyLabel.rows[0].id,
      providerShipmentId: 44_001,
      expectedContents: {
        kind: "available",
        source: "legacy_wms_shipment",
        lines: [{
          wmsShipmentItemId: legacyItem.rows[0].id,
          sku: "LEGACY-SKU",
          quantity: 3,
        }],
      },
    });
    expect(byProviderShipmentId.get(44_002)).toEqual({
      shippingProviderLabelId: physicalLabel.rows[0].id,
      providerShipmentId: 44_002,
      expectedContents: {
        kind: "available",
        source: "physical_shipment",
        lines: [{
          wmsShipmentItemId: physicalLegacyItem.rows[0].id,
          sku: "PHYSICAL-SKU",
          quantity: 2,
        }],
      },
    });
  });

  it("persists one idempotent system recovery that the allocation readiness consumer reads", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "RECOVERY-SKU", 2);
    const shipment = await pool.query<{ id: number }>(
      "INSERT INTO wms.outbound_shipments DEFAULT VALUES RETURNING id",
    );
    await pool.query(
      `UPDATE wms.outbound_shipment_items
       SET shipment_id = $1::integer
       WHERE id = $2::integer`,
      [shipment.rows[0].id, sourceId],
    );
    const label = await pool.query<{ id: string }>(
      `INSERT INTO wms.shipping_provider_labels (
         provider, provider_label_id, tracking_number, label_status,
         label_direction, first_observed_at, last_observed_at
       ) VALUES (
         'shipstation', '56001', '1ZSYSTEMRECOVERY', 'active', 'outbound',
         '2026-08-27T12:00:00.000Z', '2026-08-27T12:00:00.000Z'
       ) RETURNING id::text AS id`,
    );
    const historicalPayload = Object.freeze({
      payloadSchemaVersion: 1,
      providerLabelId: "56001",
      trackingNumber: "1ZSYSTEMRECOVERY",
    });
    const historicalEventHash = createHash("sha256").update(canonicalJson({
      provider: "shipstation",
      ...historicalPayload,
      labelStatus: "active",
    })).digest("hex");
    const historicalEvent = await pool.query<{ id: string }>(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id, event_hash, event_type, label_status,
         tracking_number, provider_occurred_at, received_at, sanitized_payload
       ) VALUES (
         $1::bigint, $2, 'label_observed', 'active', '1ZSYSTEMRECOVERY', NULL,
         '2026-08-27T12:00:00.000Z', $3::jsonb
       ) RETURNING id::text AS id`,
      [label.rows[0].id, historicalEventHash, JSON.stringify(historicalPayload)],
    );
    await pool.query(
      `INSERT INTO wms.shipping_provider_label_links (
         shipping_provider_label_id, legacy_wms_shipment_id
       ) VALUES ($1::bigint, $2::integer)`,
      [label.rows[0].id, shipment.rows[0].id],
    );

    const expectedContents = Object.freeze({
      kind: "available" as const,
      source: "legacy_wms_shipment" as const,
      lines: Object.freeze([
        Object.freeze({
          wmsShipmentItemId: sourceId,
          sku: "RECOVERY-SKU",
          quantity: 2,
        }),
      ]),
    });
    const recoveryEvidence = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 56_001,
      providerStatus: "authoritative",
      rawProviderItems: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 2 }],
      expectedContents,
    });
    if (recoveryEvidence === null) throw new Error("Expected recoverable integration evidence");
    const client: HistoricalShipStationContentsClient = {
      async loadShipmentContents(providerShipmentId, observedExpectedContents) {
        expect(providerShipmentId).toBe(56_001);
        expect(observedExpectedContents).toEqual(expectedContents);
        return Object.freeze({
          kind: "found" as const,
          evidence: Object.freeze({
            status: "authoritative" as const,
            recoveryStatus: recoveryEvidence.recoveryStatus,
            providerItemCount: 1,
            recognizedProviderItemCount: 1,
            canonicalLineCount: 1,
            malformedItemCount: 0,
            unrecognizedItemCount: 0,
            duplicateLineItemCount: 0,
            recoveryEvidence: Object.freeze({
              contractVersion: recoveryEvidence.contractVersion,
              evidenceHash: recoveryEvidence.evidenceHash,
              attestedLineCount: recoveryEvidence.attestedContents.length,
            }),
          }),
          recoveryEvidenceDetails: recoveryEvidence,
        });
      },
    };
    const recoveryService = new HistoricalShipStationContentsSystemRecoveryService(
      new PgHistoricalShipStationContentsSystemRecoveryRepository(pool),
      client,
    );

    const previewEvidenceHash = historicalShipStationRecoverableCaseEvidenceHash({
      shippingProviderLabelId: label.rows[0].id,
      recoveryStatus: recoveryEvidence.recoveryStatus,
      providerEvidenceHash: recoveryEvidence.evidenceHash,
    });
    await expect(recoveryService.recover(label.rows[0].id, "f".repeat(64)))
      .rejects.toMatchObject({ code: "PROVIDER_EVIDENCE_CHANGED" });
    const beforeExactApply = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM wms.shipping_provider_label_events
       WHERE shipping_provider_label_id = $1::bigint
         AND event_type = 'contents_recovered'`,
      [label.rows[0].id],
    );
    expect(beforeExactApply.rows[0].count).toBe("0");

    const created = await recoveryService.recover(label.rows[0].id, previewEvidenceHash);
    const replay = await recoveryService.recover(label.rows[0].id, previewEvidenceHash);
    expect(created).toMatchObject({
      kind: "created",
      shippingProviderLabelId: label.rows[0].id,
      eventHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(replay).toEqual({ ...created, kind: "already_persisted" });

    const persisted = await pool.query<{
      id: string;
      provider_occurred_at: Date | null;
      sanitized_payload: Record<string, unknown>;
    }>(
      `SELECT id::text AS id, provider_occurred_at, sanitized_payload
       FROM wms.shipping_provider_label_events
       WHERE shipping_provider_label_id = $1::bigint
         AND event_type = 'contents_recovered'`,
      [label.rows[0].id],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      id: created.labelEventId,
      provider_occurred_at: null,
      sanitized_payload: {
        observationSource: "historical_shipstation_contents_system_recovery",
        resolvedLabelEventIds: [Number(historicalEvent.rows[0].id)],
        declaredContentsEvidence: {
          status: "authoritative",
          lines: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 2 }],
        },
      },
    });
    expect(JSON.stringify(persisted.rows[0].sanitized_payload)).not.toContain("RECOVERY-SKU");

    const labelId = positiveSafeIntegerFromPostgres(
      label.rows[0].id,
      "shipping_provider_labels.id",
    );
    const readiness = await new PackageAllocationAuthorityReadinessService(
      new PgPackageAllocationLedgerRepository(pool),
    ).assess({
      contractVersion: 1,
      authorityMode: "shadow_only",
      sourceWmsShipmentItemIds: [sourceId],
      shippingProviderLabelIds: [labelId],
    });
    expect(readiness).toMatchObject({
      authority: "none",
      outcome: "review",
      plannerInput: null,
      packageAssessments: [{
        evidenceCoverage: "historical_v1_recovered",
        authoritativeContents: [{ wmsShipmentItemId: sourceId, quantity: 2 }],
        candidateSourceStatus: "within_candidate_sources",
      }],
    });
    expect(readiness.reviews.map((review) => review.code)).toEqual([
      "allocation_role_policy_unresolved",
      "package_membership_policy_unresolved",
      "physical_consumption_authority_policy_unresolved",
    ]);
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(9).fill(0));

    const freshAudit = await withExecutionAuditRole(pool, async (scopedPool) => {
      const scopedClient = await scopedPool.connect();
      return loadHistoricalShipStationContentsCandidates(scopedClient, { candidateLimit: 10 });
    });
    expect(freshAudit.candidates).toEqual([]);

    const competingEvent = buildHistoricalShipStationContentsSystemRecoveryEvent({
      shippingProviderLabelId: label.rows[0].id,
      providerShipmentId: 56_001,
      trackingNumber: "1ZSYSTEMRECOVERY",
      labelStatus: "active",
      recoveryEvidence: {
        ...recoveryEvidence,
        evidenceHash: "f".repeat(64),
      },
      resolvedLabelEventIds: [Number(historicalEvent.rows[0].id)],
    });
    await expect(pool.query(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id, event_hash, event_type, label_status,
         tracking_number, provider_occurred_at, received_at, sanitized_payload
       ) VALUES ($1::bigint, $2, $3, $4, $5, NULL, transaction_timestamp(), $6::jsonb)`,
      [
        label.rows[0].id,
        competingEvent.eventHash,
        competingEvent.eventType,
        competingEvent.labelStatus,
        competingEvent.trackingNumber,
        JSON.stringify(competingEvent.sanitizedPayload),
      ],
    )).rejects.toMatchObject({ code: "23505" });

    const invalidLabel = await pool.query<{ id: string }>(
      `INSERT INTO wms.shipping_provider_labels (
         provider, provider_label_id, tracking_number, label_status,
         label_direction, first_observed_at, last_observed_at
       ) VALUES (
         'shipstation', '56002', '1ZINVALIDRECOVERY', 'active', 'outbound',
         transaction_timestamp(), transaction_timestamp()
       ) RETURNING id::text AS id`,
    );
    await expect(pool.query(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id, event_hash, event_type, label_status,
         tracking_number, provider_occurred_at, received_at, sanitized_payload
       ) VALUES (
         $1::bigint, $2, 'contents_recovered', 'active',
         '1ZINVALIDRECOVERY', NULL, transaction_timestamp(), '{}'::jsonb
       )`,
      [invalidLabel.rows[0].id, "0".repeat(64)],
    )).rejects.toMatchObject({
      code: "23514",
      constraint: "shipping_provider_label_events_recovery_payload_chk",
    });
  });

  it("persists one exact lead attestation, replays it, and rolls back a competing resolution", async () => {
    const leadUserId = "11111111-1111-4111-8111-111111111111";
    await pool.query(
      `INSERT INTO identity.users (id, username, password, role, active)
       VALUES ($1, 'historical-attestation-lead', 'test-only-password-hash', 'lead', 1)`,
      [leadUserId],
    );
    const order = await pool.query<{ id: number }>(
      `INSERT INTO wms.orders (order_number)
       VALUES ('#ATTEST-1001')
       RETURNING id`,
    );
    const orderItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.order_items (order_id, sku, name, quantity)
       VALUES ($1::integer, 'ATTEST-SKU', 'Attestation test item', 2)
       RETURNING id`,
      [order.rows[0].id],
    );
    const shipment = await pool.query<{ id: number }>(
      "INSERT INTO wms.outbound_shipments (order_id) VALUES ($1::integer) RETURNING id",
      [order.rows[0].id],
    );
    const shipmentItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipment_items (
         shipment_id, order_item_id, shipment_item_purpose, qty
       ) VALUES ($1::integer, $2::integer, 'customer_fulfillment', 2)
       RETURNING id`,
      [shipment.rows[0].id, orderItem.rows[0].id],
    );
    const label = await pool.query<{ id: string }>(
      `INSERT INTO wms.shipping_provider_labels (
         provider, provider_label_id, provider_order_id, tracking_number, label_status,
         label_direction, first_observed_at, last_observed_at
       ) VALUES (
          'shipstation', '55001', '77001', '1ZATTESTATION', 'active', 'outbound',
          '2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.000Z'
        ) RETURNING id::text AS id`,
    );
    const labelEvent = await pool.query<{ id: string }>(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id, event_hash, event_type, label_status,
         tracking_number, provider_occurred_at, received_at, sanitized_payload
       ) VALUES (
         $1::bigint, $2, 'label_observed', 'active', '1ZATTESTATION', NULL,
         '2026-08-26T12:00:00.000Z', '{"payloadSchemaVersion":1}'::jsonb
       ) RETURNING id::text AS id`,
      [label.rows[0].id, "d".repeat(64)],
    );
    await pool.query(
      `INSERT INTO wms.shipping_provider_label_links (
         shipping_provider_label_id, legacy_wms_shipment_id
       ) VALUES ($1::bigint, $2::integer)`,
      [label.rows[0].id, shipment.rows[0].id],
    );

    const expectedContents = Object.freeze({
      kind: "available" as const,
      source: "legacy_wms_shipment" as const,
      lines: Object.freeze([
        Object.freeze({
          wmsShipmentItemId: shipmentItem.rows[0].id,
          sku: "ATTEST-SKU",
          quantity: 2,
        }),
      ]),
    });
    const recoveryEvidence = buildHistoricalShipStationContentsRecoveryEvidence({
      providerShipmentId: 55_001,
      providerStatus: "authoritative",
      rawProviderItems: [{
        lineItemKey: `wms-item-${shipmentItem.rows[0].id}`,
        quantity: 2,
      }],
      expectedContents,
    });
    if (recoveryEvidence === null) throw new Error("Expected recoverable integration evidence");
    const client: HistoricalShipStationContentsClient = {
      async loadShipmentContents(providerShipmentId, observedExpectedContents) {
        expect(providerShipmentId).toBe(55_001);
        expect(observedExpectedContents).toEqual(expectedContents);
        return Object.freeze({
          kind: "found" as const,
          evidence: Object.freeze({
            status: "authoritative" as const,
            recoveryStatus: recoveryEvidence.recoveryStatus,
            providerItemCount: 1,
            recognizedProviderItemCount: 1,
            canonicalLineCount: 1,
            malformedItemCount: 0,
            unrecognizedItemCount: 0,
            duplicateLineItemCount: 0,
            recoveryEvidence: Object.freeze({
              contractVersion: recoveryEvidence.contractVersion,
              evidenceHash: recoveryEvidence.evidenceHash,
              attestedLineCount: recoveryEvidence.attestedContents.length,
            }),
          }),
          recoveryEvidenceDetails: recoveryEvidence,
        });
      },
    };
    const repository = new PgHistoricalShipStationContentsAttestationRepository(pool);
    const service = new HistoricalShipStationContentsAttestationService(repository, client);
    const preview = await service.preview(label.rows[0].id);
    const previewEvidenceHash = preview.previewEvidenceHash;
    expect(preview.reviewContext).toEqual({
      trackingNumber: "1ZATTESTATION",
      shipStationOrderId: "77001",
      wmsOrders: [{ wmsOrderId: order.rows[0].id, orderNumber: "#ATTEST-1001" }],
      linkedShipments: [{
        source: "legacy_wms_shipment",
        shipmentId: String(shipment.rows[0].id),
      }],
      linePresentations: [{
        wmsShipmentItemId: shipmentItem.rows[0].id,
        itemName: "Attestation test item",
      }],
    });
    const command = Object.freeze({
      shippingProviderLabelId: label.rows[0].id,
      expectedPreviewEvidenceHash: previewEvidenceHash,
      authenticatedActorUserId: leadUserId,
      reason: "Reviewed exact historical ShipStation contents against linked WMS lineage",
    });

    const created = await service.attest(command);
    expect(created).toMatchObject({
      kind: "created",
      shippingProviderLabelId: label.rows[0].id,
      previewEvidenceHash,
      resolvedEventCount: 1,
    });
    const persisted = await pool.query<{
      actor_user_id: string;
      actor_role: string;
      reason: string;
      attested_contents: unknown;
      resolved_event_id: string;
    }>(
      `SELECT
         attestation.actor_user_id,
         attestation.actor_role,
         attestation.reason,
         attestation.attested_contents,
         resolution.shipping_provider_label_event_id::text AS resolved_event_id
       FROM wms.shipping_provider_label_content_attestations AS attestation
       JOIN wms.shipping_provider_label_content_attestation_resolutions AS resolution
         ON resolution.shipping_provider_label_content_attestation_id = attestation.id
       WHERE attestation.id = $1::bigint`,
      [created.attestationId],
    );
    expect(persisted.rows).toEqual([{
      actor_user_id: leadUserId,
      actor_role: "lead",
      reason: command.reason,
      attested_contents: recoveryEvidence.attestedContents,
      resolved_event_id: labelEvent.rows[0].id,
    }]);

    await expect(service.attest(structuredClone(command))).resolves.toMatchObject({
      kind: "already_persisted",
      attestationId: created.attestationId,
      resolvedEventCount: 1,
    });
    await expect(service.attest({
      ...command,
      reason: "A different reason cannot reuse the same reviewed fingerprint",
    })).rejects.toMatchObject({ code: "ATTESTATION_CONFLICT" });

    await expect(repository.withSerializableTransaction(async (transaction) => {
      const actor = await transaction.lockAuthorizedActor(leadUserId);
      if (actor === null) throw new Error("Expected the integration lead to remain authorized");
      const resolvedLabelEventIds = await transaction.loadResolvableLabelEventIds(label.rows[0].id);
      return transaction.appendExactAttestation({
        shippingProviderLabelId: label.rows[0].id,
        recoveryEvidence: Object.freeze({
          ...recoveryEvidence,
          evidenceHash: "e".repeat(64),
        }),
        previewEvidenceHash: "f".repeat(64),
        actor,
        reason: "Competing evidence must roll back its parent row",
        attestationHash: "a".repeat(64),
        resolvedLabelEventIds,
      });
    })).rejects.toMatchObject({ code: "ATTESTATION_CONFLICT" });

    const counts = await pool.query<{ attestations: number; resolutions: number }>(
      `SELECT
         (SELECT COUNT(*)::integer FROM wms.shipping_provider_label_content_attestations)
           AS attestations,
         (SELECT COUNT(*)::integer FROM wms.shipping_provider_label_content_attestation_resolutions)
           AS resolutions`,
    );
    expect(counts.rows).toEqual([{ attestations: 1, resolutions: 1 }]);
    await expect(pool.query(
      `UPDATE wms.shipping_provider_label_content_attestations
       SET reason = 'mutation is forbidden'
       WHERE id = $1::bigint`,
      [created.attestationId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("persists and idempotently resolves a ShipStation/WMS contents conflict through lead-confirmed WMS evidence", async () => {
    const leadUserId = "22222222-2222-4222-8222-222222222222";
    await pool.query(
      `INSERT INTO identity.users (id, username, password, role, active)
       VALUES ($1, 'historical-review-lead', 'test-only-password-hash', 'lead', 1)`,
      [leadUserId],
    );
    const order = await pool.query<{ id: number }>(
      `INSERT INTO wms.orders (order_number)
       VALUES ('#REVIEW-1001')
       RETURNING id`,
    );
    const orderItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.order_items (order_id, sku, name, quantity)
       VALUES ($1::integer, 'WMS-REVIEW-SKU', 'WMS review item', 2)
       RETURNING id`,
      [order.rows[0].id],
    );
    const shipment = await pool.query<{ id: number }>(
      "INSERT INTO wms.outbound_shipments (order_id) VALUES ($1::integer) RETURNING id",
      [order.rows[0].id],
    );
    const shipmentItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipment_items (
         shipment_id, order_item_id, shipment_item_purpose, qty
       ) VALUES ($1::integer, $2::integer, 'customer_fulfillment', 2)
       RETURNING id`,
      [shipment.rows[0].id, orderItem.rows[0].id],
    );
    const label = await pool.query<{ id: string }>(
      `INSERT INTO wms.shipping_provider_labels (
         provider, provider_label_id, provider_order_id, tracking_number, label_status,
         label_direction, first_observed_at, last_observed_at
       ) VALUES (
         'shipstation', '57001', '78001', '1ZHISTORICALREVIEW', 'active', 'outbound',
         '2026-08-28T12:00:00.000Z', '2026-08-28T12:00:00.000Z'
       ) RETURNING id::text AS id`,
    );
    const historicalPayload = Object.freeze({
      payloadSchemaVersion: 1,
      providerLabelId: "57001",
      trackingNumber: "1ZHISTORICALREVIEW",
    });
    const historicalEventHash = createHash("sha256").update(canonicalJson({
      provider: "shipstation",
      ...historicalPayload,
      labelStatus: "active",
    })).digest("hex");
    const historicalEvent = await pool.query<{ id: string }>(
      `INSERT INTO wms.shipping_provider_label_events (
         shipping_provider_label_id, event_hash, event_type, label_status,
         tracking_number, provider_occurred_at, received_at, sanitized_payload
       ) VALUES (
         $1::bigint, $2, 'label_observed', 'active', '1ZHISTORICALREVIEW', NULL,
         '2026-08-28T12:00:00.000Z', $3::jsonb
       ) RETURNING id::text AS id`,
      [label.rows[0].id, historicalEventHash, JSON.stringify(historicalPayload)],
    );
    await pool.query(
      `INSERT INTO wms.shipping_provider_label_links (
         shipping_provider_label_id, legacy_wms_shipment_id
       ) VALUES ($1::bigint, $2::integer)`,
      [label.rows[0].id, shipment.rows[0].id],
    );

    const providerObservationHash = "a".repeat(64);
    const loadShipmentContents = async () => Object.freeze({
      kind: "found" as const,
      evidence: Object.freeze({
        status: "unrecognized" as const,
        recoveryStatus: "provider_wms_conflict" as const,
        providerItemCount: 1,
        recognizedProviderItemCount: 0,
        canonicalLineCount: 0,
        malformedItemCount: 0,
        unrecognizedItemCount: 1,
        duplicateLineItemCount: 0,
        recoveryEvidence: null,
      }),
      recoveryEvidenceDetails: null,
      providerObservation: Object.freeze({
        evidenceHash: providerObservationHash,
        lines: Object.freeze([
          Object.freeze({ sku: "SHIPSTATION-REVIEW-SKU", quantity: 5 }),
        ]),
      }),
    });
    const service = new HistoricalShipStationContentsReviewService(
      new PgHistoricalShipStationContentsReviewRepository(pool),
      { loadShipmentContents },
    );
    const intake = await service.intake({
      shippingProviderLabelId: label.rows[0].id,
      reason: "provider_wms_conflict",
      expectedEvidenceHash: providerObservationHash,
    });
    expect(intake).toMatchObject({ kind: "created", shippingProviderLabelId: label.rows[0].id });

    const preview = await service.preview(intake.exceptionId);
    expect(preview).toMatchObject({
      orderNumber: "#REVIEW-1001",
      trackingNumber: "1ZHISTORICALREVIEW",
      providerContents: [{ sku: "SHIPSTATION-REVIEW-SKU", quantity: 5 }],
      wmsContents: [{
        wmsShipmentItemId: shipmentItem.rows[0].id,
        sku: "WMS-REVIEW-SKU",
        itemName: "WMS review item",
        quantity: 2,
      }],
    });
    const pendingInventoryCorrection = Object.freeze({
      exceptionId: intake.exceptionId,
      expectedPreviewEvidenceHash: preview.previewEvidenceHash,
      authenticatedActorUserId: leadUserId,
      decision: "provider_confirmed_pending_inventory_correction" as const,
      reason: "The carrier package record is supported, but inventory correction is not authorized here.",
    });
    await expect(service.decide(pendingInventoryCorrection)).resolves.toEqual({
      exceptionId: intake.exceptionId,
      status: "acknowledged",
    });
    await expect(service.decide(structuredClone(pendingInventoryCorrection))).resolves.toEqual({
      exceptionId: intake.exceptionId,
      status: "acknowledged",
    });
    await expect(service.intake({
      shippingProviderLabelId: label.rows[0].id,
      reason: "provider_wms_conflict",
      expectedEvidenceHash: providerObservationHash,
    })).resolves.toMatchObject({ kind: "already_persisted", exceptionId: intake.exceptionId });
    const pending = await pool.query<{
      status: string;
      classification: string;
      details: Record<string, unknown>;
      history_count: number;
    }>(
      `SELECT status, classification, details,
              jsonb_array_length(details->'decisionHistory') AS history_count
       FROM wms.reconciliation_exceptions
       WHERE id = $1::bigint`,
      [intake.exceptionId],
    );
    expect(pending.rows).toMatchObject([{
      status: "acknowledged",
      classification: "hard_block",
      details: {
        decision: "provider_confirmed_pending_inventory_correction",
        decisionActorUserId: leadUserId,
        decisionActorRole: "lead",
        inventoryCorrectionRequired: true,
      },
      history_count: 1,
    }]);

    const correctionPreview = await new HistoricalShipStationContentsCorrectionService(
      new PgHistoricalShipStationContentsCorrectionRepository(pool),
      service,
    ).preview(intake.exceptionId);
    expect(correctionPreview).toMatchObject({
      exceptionId: intake.exceptionId,
      correctionPlanHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      evidenceComplete: false,
      packageLineChangeRequired: true,
    });
    expect(correctionPreview.lines).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sku: "SHIPSTATION-REVIEW-SKU",
        providerQuantity: 5,
        wmsQuantity: 0,
        packageQuantityDelta: 5,
      }),
      expect.objectContaining({
        sku: "WMS-REVIEW-SKU",
        providerQuantity: 0,
        wmsQuantity: 2,
        packageQuantityDelta: -2,
      }),
    ]));

    const command = Object.freeze({
      exceptionId: intake.exceptionId,
      expectedPreviewEvidenceHash: preview.previewEvidenceHash,
      authenticatedActorUserId: leadUserId,
      decision: "wms_confirmed" as const,
      reason: "The physical packing record confirms the WMS package contents.",
    });
    const created = await service.decide(command);
    const replay = await service.decide(structuredClone(command));
    expect(created).toMatchObject({
      kind: "created",
      exceptionId: intake.exceptionId,
      shippingProviderLabelId: label.rows[0].id,
      eventHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(replay).toEqual({ ...created, kind: "already_persisted" });

    const persisted = await pool.query<{
      status: string;
      classification: string;
      resolved_by: string;
      details: Record<string, unknown>;
      event_id: string;
      sanitized_payload: Record<string, unknown>;
    }>(
      `SELECT exception.status, exception.classification, exception.resolved_by,
              exception.details,
              event.id::text AS event_id, event.sanitized_payload
       FROM wms.reconciliation_exceptions AS exception
       JOIN wms.shipping_provider_label_events AS event
         ON event.id = (exception.details->>'resolutionLabelEventId')::bigint
       WHERE exception.id = $1::bigint`,
      [intake.exceptionId],
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({
      status: "resolved",
      classification: "safe_auto_repair",
      resolved_by: leadUserId,
      details: {
        decision: "wms_confirmed",
        decisionPreviewEvidenceHash: preview.previewEvidenceHash,
        decisionActorUserId: leadUserId,
        decisionReason: command.reason,
      },
      sanitized_payload: {
        observationSource: "historical_shipstation_contents_operator_resolution",
        recoveryStatus: "wms_confirmed_after_provider_conflict",
        actorUserId: leadUserId,
        actorRole: "lead",
        reason: command.reason,
        resolvedLabelEventIds: [Number(historicalEvent.rows[0].id)],
        declaredContentsEvidence: {
          status: "authoritative",
          lines: [{ lineItemKey: `wms-item-${shipmentItem.rows[0].id}`, quantity: 2 }],
        },
      },
    });
  });

  it("installs valid discovery indexes that PostgreSQL can use for the production query", async () => {
    const catalog = await pool.query<{
      index_name: string;
      indisvalid: boolean;
      indisready: boolean;
    }>(
      `SELECT index_relation.relname AS index_name,
              index_state.indisvalid,
              index_state.indisready
       FROM pg_catalog.pg_index AS index_state
       JOIN pg_catalog.pg_class AS index_relation
         ON index_relation.oid = index_state.indexrelid
       JOIN pg_catalog.pg_namespace AS namespace
         ON namespace.oid = index_relation.relnamespace
       WHERE namespace.nspname = 'wms'
         AND index_relation.relname = ANY($1::text[])
       ORDER BY index_relation.relname`,
      [[...DISCOVERY_INDEX_NAMES]],
    );
    expect(catalog.rows.map((row) => row.index_name)).toEqual(
      [...DISCOVERY_INDEX_NAMES].sort(),
    );
    expect(catalog.rows.every((row) => row.indisvalid && row.indisready)).toBe(true);

    const discoveryQuery = await captureProductionDiscoveryQuery();
    const client = await pool.connect();
    let releaseError: Error | undefined;
    let explained: unknown;
    try {
      await client.query("BEGIN TRANSACTION READ ONLY");
      await client.query("SET LOCAL statement_timeout = '15s'");
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL enable_seqscan = off");
      const result = await client.query<{ "QUERY PLAN": unknown }>(
        `EXPLAIN (FORMAT JSON, COSTS OFF) ${discoveryQuery.text}`,
        [...discoveryQuery.values],
      );
      explained = result.rows[0]?.["QUERY PLAN"];
      await client.query("ROLLBACK");
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        releaseError = rollbackError instanceof Error
          ? rollbackError
          : new Error("Discovery EXPLAIN rollback failed with a non-Error value");
        throw new AggregateError(
          [error, rollbackError],
          "Discovery EXPLAIN and rollback both failed",
        );
      }
      throw error;
    } finally {
      client.release(releaseError);
    }

    const usedIndexNames = planIndexNames(explainPlanRoot(explained));
    for (const indexName of DISCOVERY_INDEX_NAMES) {
      expect(usedIndexNames, `${indexName} was absent from the forced-index plan`)
        .toContain(indexName);
    }
  });

  it("executes the read-only plan-audit SQL contract on PostgreSQL", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-PLAN-AUDIT", 1);
    const client = await pool.connect();
    let primaryFailure: unknown;
    let relationEvidence: Record<string, unknown> | undefined;
    let catalogEvidence: readonly Record<string, unknown>[] | undefined;
    let explained: unknown;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const relations = await client.query(PACKAGE_ALLOCATION_DISCOVERY_RELATION_ASSERTION_SQL);
      relationEvidence = relations.rows[0] as Record<string, unknown> | undefined;
      const catalog = await client.query(PACKAGE_ALLOCATION_DISCOVERY_INDEX_CATALOG_SQL);
      catalogEvidence = catalog.rows as Record<string, unknown>[];
      const explain = await client.query<{ "QUERY PLAN": unknown }>(
        PACKAGE_ALLOCATION_DISCOVERY_EXPLAIN_SQL,
        [[sourceId], PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_MAX_PACKAGES + 1],
      );
      explained = explain.rows[0]?.["QUERY PLAN"];
    } catch (error) {
      primaryFailure = error;
    }

    let rollbackFailure: unknown;
    try {
      await client.query("ROLLBACK");
    } catch (error) {
      rollbackFailure = error;
    } finally {
      client.release(rollbackFailure instanceof Error ? rollbackFailure : undefined);
    }
    if (primaryFailure !== undefined && rollbackFailure !== undefined) {
      throw new AggregateError(
        [primaryFailure, rollbackFailure],
        "Plan-audit SQL and rollback both failed",
      );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (rollbackFailure !== undefined) throw rollbackFailure;

    expect(relationEvidence).toMatchObject({
      missing_required_select_count: "0",
      required_rls_count: "0",
      missing_required_schema_usage_count: "0",
    });
    expect(catalogEvidence).toHaveLength(
      PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS.length,
    );
    expect(catalogEvidence?.every((row) => (
      row.relation_schema === "wms"
      && row.indisvalid === true
      && row.indisready === true
      && row.indislive === true
    ))).toBe(true);
    expect(explainPlanRoot(explained)).toMatchObject({
      "Node Type": expect.any(String),
      "Startup Cost": expect.any(Number),
      "Total Cost": expect.any(Number),
      "Plan Rows": expect.any(Number),
    });
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(9).fill(0));
  });


  it("executes one representative discovery query under the limited read-only role", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-EXECUTION-AUDIT", 1);
    const providerOrderId = "provider-order-execution-audit-1";
    const labelId = await seedAuthorityReadinessLabel(pool, sourceId, { providerOrderId });
    await seedAuthorityDiscoveryRelations(pool, sourceId, labelId, providerOrderId);
    const countsBefore = await loadLedgerCounts(pool);
    const client = await pool.connect();
    let report: PackageAllocationDiscoveryExecutionAuditReport | undefined;
    let primaryFailure: unknown;
    let resetFailure: unknown;
    try {
      await client.query(`SET ROLE ${EXECUTION_AUDIT_ROLE}`);
      report = await auditPackageAllocationAuthorityDiscoveryExecution(client, {
        sourceWmsShipmentItemId: sourceId,
      });
    } catch (error) {
      primaryFailure = error;
    } finally {
      try {
        await client.query("RESET ROLE");
      } catch (error) {
        resetFailure = error;
      }
      client.release(resetFailure instanceof Error ? resetFailure : undefined);
    }
    if (primaryFailure !== undefined && resetFailure !== undefined) {
      throw new AggregateError(
        [primaryFailure, resetFailure],
        "Execution audit and role reset both failed",
      );
    }
    if (primaryFailure !== undefined) throw primaryFailure;
    if (resetFailure !== undefined) throw resetFailure;

    expect(report).toMatchObject({
      mode: "read_only_explain_analyze",
      queryExecuted: true,
      sourceCount: 1,
      representativeSourceVerified: true,
      readOnlyRoleVerified: true,
      expectedIndexCount: PACKAGE_ALLOCATION_AUTHORITY_DISCOVERY_INDEX_CONTRACTS.length,
      executionPlanNodeCount: expect.any(Number),
      executionRootNodeType: expect.any(String),
      actualRows: expect.any(Number),
      actualLoops: expect.any(Number),
      planningTimeMs: expect.any(Number),
      executionTimeMs: expect.any(Number),
      executionBuffers: {
        sharedHitBlocks: expect.any(Number),
        sharedReadBlocks: expect.any(Number),
        sharedDirtiedBlocks: expect.any(Number),
        sharedWrittenBlocks: expect.any(Number),
        localHitBlocks: expect.any(Number),
        localReadBlocks: expect.any(Number),
        localDirtiedBlocks: expect.any(Number),
        localWrittenBlocks: expect.any(Number),
        tempReadBlocks: expect.any(Number),
        tempWrittenBlocks: expect.any(Number),
      },
    });
    expect(report?.executionPlanNodeCount).toBeGreaterThan(0);
    expect(report?.actualLoops).toBeGreaterThan(0);
    expect(await loadLedgerCounts(pool)).toEqual(countsBefore);
  });
  it("loads locked persisted evidence and remains shadow-only without ledger writes", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-READINESS", 2);
    const labelId = await seedAuthorityReadinessLabel(pool, sourceId);
    const service = new PackageAllocationAuthorityReadinessService(
      new PgPackageAllocationLedgerRepository(pool),
    );

    const result = await service.assess({
      contractVersion: 1,
      authorityMode: "shadow_only",
      sourceWmsShipmentItemIds: [sourceId],
      shippingProviderLabelIds: [labelId],
    });

    expect(result).toMatchObject({
      authority: "none",
      outcome: "review",
      plannerInput: null,
      packageAssessments: [{
        evidenceKey: `shipping-provider-label:${labelId}`,
        lifecycleStatus: "projected",
        candidateSourceStatus: "within_candidate_sources",
        authoritativeContents: [{
          wmsShipmentItemId: sourceId,
          quantity: 2,
        }],
      }],
    });
    expect(result.reviews.map((review) => review.code)).toEqual([
      "allocation_role_policy_unresolved",
      "package_membership_policy_unresolved",
      "physical_consumption_authority_policy_unresolved",
    ]);
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(9).fill(0));
  });

  it.each(["unposted", "binding", "physical", "legacy", "pending", "retry", "success", "receipt", "unmapped_receipt", "other_store_receipt"] as const)(
    "reads exact canceled-label posting footprints under a restricted read-only role: %s", async footprint => {
      const sourceId = await seedCommercialFulfillmentAuthoritySource(pool, "VOIDED-FOOTPRINT", 2);
      await seedCanonicalRequestForSource(pool, sourceId);
      const oldId = await seedAuthorityReadinessLabel(pool, sourceId, {
        providerLabelId: "43999", trackingNumber: "VOIDED-TRACK", providerOrderId: "99001",
        voidDate: "2026-08-22T06:00:00.1234567", persistedVoidAt: "2026-08-22T13:00:00.123Z",
        receivedAt: "2026-08-22T14:00:00Z",
      });
      await pool.query(`INSERT INTO wms.shipping_provider_label_links (shipping_provider_label_id, shipment_request_id)
        SELECT $1, shipment_request_id FROM wms.shipment_request_items WHERE legacy_wms_shipment_item_id = $2`, [oldId, sourceId]);
      const liveIds = await Promise.all(["44011", "44012"].map(providerLabelId => seedAuthorityReadinessLabel(pool, sourceId, {
        providerLabelId, trackingNumber: `LIVE-${providerLabelId}`, receivedAt: "2026-08-23T14:00:00Z",
        contentsLines: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 1 }],
      })));
      const order = (await pool.query<{ id: string; channel_id: number }>("SELECT id::text, channel_id FROM oms.oms_orders")).rows[0];
      if (footprint === "binding") {
        await new PackageAllocationPlanningService(new PgPackageAllocationLedgerRepository(pool)).persist(
          commandFor(sourceId, { providerPhysicalShipmentId: "43999", trackingNumber: "VOIDED-TRACK" }),
        );
      } else if (footprint === "physical") {
        await pool.query(`INSERT INTO wms.physical_shipments (provider, provider_physical_shipment_id, tracking_number, status)
          VALUES ('shipstation', '43999', 'VOIDED-TRACK', 'shipped')`);
      } else if (footprint === "legacy") {
        await pool.query("UPDATE wms.outbound_shipments SET external_fulfillment_id = 'shipstation_shipment:43999'");
      } else if (["pending", "retry", "success"].includes(footprint)) {
        // A package record with a different identity cannot hide a command
        // for the canceled tracking number on this order.
        const physical = (await pool.query<{ id: string }>(`INSERT INTO wms.physical_shipments
          (provider, provider_physical_shipment_id, tracking_number, status)
          VALUES ('shipstation', 'other-package', 'OTHER-TRACK', 'shipped') RETURNING id::text`)).rows[0];
        await pool.query(`INSERT INTO oms.channel_fulfillment_pushes (oms_order_id, physical_shipment_id, channel_provider,
          channel_fulfillment_scope_key, command_key, request_hash, tracking_number, carrier, push_status)
          VALUES ($1, $2, 'shopify', 'order', 'voided-footprint', $3, ' voided-track ', 'ups', $4)`,
        [order.id, physical.id, "a".repeat(64), footprint]);
      } else if (["receipt", "unmapped_receipt", "other_store_receipt"].includes(footprint)) {
        const channelId = footprint === "other_store_receipt"
          ? (await pool.query<{ id: number }>("INSERT INTO channels.channels (name, provider, status) VALUES ('Other store', 'shopify', 'active') RETURNING id")).rows[0].id
          : order.channel_id;
        await pool.query(`INSERT INTO oms.channel_fulfillment_receipts (receipt_key, request_hash, source_provider,
          source_channel_id, source_order_id, source_fulfillment_id, event_kind, source, tracking_number, oms_order_id)
          VALUES ('voided-receipt', $1, 'shopify', $2, '640001', 'receipt-fulfillment', 'created', 'integration', ' voided-track ', $3)`,
        ["b".repeat(64), channelId, footprint === "receipt" ? order.id : null]);
      }
      await withExecutionAuditRole(pool, async scopedPool => {
        const repository = new PgPackageAllocationLedgerRepository(scopedPool);
        await repository.withRepeatableReadOnlyTransaction(async transaction => {
          const packages = await transaction.readAuthorityReadinessPackages([oldId, ...liveIds]);
          const old = packages.find(pkg => pkg.persistedEvidence.shippingProviderLabelId === oldId)!;
          const proof = assessVoidedLabelExclusion(old.evidenceKey, old.persistedEvidence, old.voidedLabelPostingFacts);
          const eligible = footprint === "unposted" || footprint === "other_store_receipt";
          expect(proof !== null, JSON.stringify(old.voidedLabelPostingFacts)).toBe(eligible);
          const result = resolvePackageAllocationAuthorityEvidence({ groupKey: PRIMARY_GROUP_KEY, expectedGroupVersion: 0,
            previousPlan: null, actions: [], packages, sourceFacts: await transaction.readSourceFacts([sourceId]) });
          expect(result.resolution?.outcome).toBe(eligible ? "proposed" : "review");
          expect(result.excludedVoidedLabelEvidence).toHaveLength(eligible ? 1 : 0);
        });
      });
    },
  );

  it("normalizes a stored legacy Pacific cancellation without bypassing split replacement authorization", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "DATE-SPLIT-REGRESSION", 2);
    const oldLabelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerLabelId: "458434391", trackingNumber: "9434650206217286007967",
      voidDate: "2026-09-10T09:38:29.5370000",
      persistedVoidAt: "2026-09-10T09:38:29.537Z",
      receivedAt: "2026-09-10T16:38:58.068Z",
    });
    const firstLabelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerLabelId: "459620581", trackingNumber: "1Z16D13WYW85232525",
      receivedAt: "2026-09-16T11:03:01.140Z",
      contentsLines: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 1 }],
    });
    const secondLabelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerLabelId: "459620652", trackingNumber: "1Z16D13WYW68975578",
      receivedAt: "2026-09-16T11:03:54.592Z",
      contentsLines: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 1 }],
    });
    const before = await pool.query(`SELECT event_hash, sanitized_payload, provider_occurred_at::text
      FROM wms.shipping_provider_label_events WHERE shipping_provider_label_id = $1`, [oldLabelId]);
    const service = new PackageAllocationAuthorityResolutionPreviewService(new PgPackageAllocationLedgerRepository(pool));
    const result = await service.preview({
      contractVersion: 1, authorityMode: "shadow_only", previewMode: "bootstrap_selected_scope",
      groupKey: PRIMARY_GROUP_KEY, sourceWmsShipmentItemIds: [sourceId],
      shippingProviderLabelIds: [oldLabelId, firstLabelId, secondLabelId],
    });
    expect(result.readiness.packageAssessments.every((item) => item.lifecycleStatus === "projected")).toBe(true);
    expect(result.readiness.packageAssessments.map((item) => ({
      providerId: item.providerPhysicalShipmentId, contents: item.authoritativeContents,
    }))).toEqual(expect.arrayContaining([
      { providerId: "458434391", contents: [{ wmsShipmentItemId: sourceId, quantity: 2 }] },
      { providerId: "459620581", contents: [{ wmsShipmentItemId: sourceId, quantity: 1 }] },
      { providerId: "459620652", contents: [{ wmsShipmentItemId: sourceId, quantity: 1 }] },
    ]));
    // Correcting a date must not grant the separate replacement authorization.
    // The resolver now reads all three packages instead of rejecting timestamps.
    expect(result.resolution).toMatchObject({ outcome: "review" });
    expect(result.resolution!.reviews.map((review) => review.code)).toEqual([
      "replacement_action_required", "replacement_action_required",
    ]);
    expect(result.resolution!.plannerResult.state.desiredEffectIntents.every((intent) => !intent.executable)).toBe(true);
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(9).fill(0));
    const after = await pool.query(`SELECT event_hash, sanitized_payload, provider_occurred_at::text
      FROM wms.shipping_provider_label_events WHERE shipping_provider_label_id = $1`, [oldLabelId]);
    expect(after.rows).toEqual(before.rows);
  });

  it("resolves locked bootstrap evidence without creating ledger rows", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-PREVIEW", 2);
    const labelId = await seedAuthorityReadinessLabel(pool, sourceId);
    const repository = new PgPackageAllocationLedgerRepository(pool);
    const service = new PackageAllocationAuthorityResolutionPreviewService(repository);

    const result = await service.preview({
      contractVersion: 1,
      authorityMode: "shadow_only",
      previewMode: "bootstrap_selected_scope",
      groupKey: PRIMARY_GROUP_KEY,
      sourceWmsShipmentItemIds: [sourceId],
      shippingProviderLabelIds: [labelId],
    });

    expect(result).toMatchObject({
      contractVersion: 1,
      authority: "none",
      outcome: "review",
      previewMode: "bootstrap_selected_scope",
      selectionAuthority: "caller_selected_unproven",
      groupState: "absent",
      readiness: {
        authority: "none",
        packageAssessments: [{
          lifecycleStatus: "projected",
          candidateSourceStatus: "within_candidate_sources",
        }],
      },
      resolution: {
        authority: "shadow_only",
        outcome: "proposed",
        plannerResult: {
          state: { reviews: [] },
        },
      },
    });
    expect(result.resolution?.plannerResult.state.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          allocationKind: "primary_transfer",
          targetKind: "package",
          quantity: 2,
        }),
      ]),
    );
    expect(result.resolution?.plannerResult.state.desiredEffectIntents.every(
      (intent) => intent.executable === false,
    )).toBe(true);
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(9).fill(0));
  });

  it("reads assembly package evidence under a SELECT-only role without creating allocation state", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "ASSEMBLY-REVIEW", 2);
    const providerOrderId = "assembly-review-order";
    const labelId = await seedAuthorityReadinessLabel(pool, sourceId, { providerOrderId });
    await seedAuthorityDiscoveryRelations(pool, sourceId, labelId, providerOrderId);
    const countsBefore = await loadLedgerCounts(pool);
    const result = await withExecutionAuditRole(pool, async (scopedPool) => {
      const client = await scopedPool.connect();
      try {
        await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const packages = await readObservedPackagesForSources(client, [sourceId]);
        expect((await client.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
        await client.query("COMMIT");
        return packages;
      } catch (error) { await client.query("ROLLBACK"); throw error; }
      finally { client.release(); }
    });
    expect(result).toHaveLength(1);
    expect(result[0].persistedEvidence.shippingProviderLabelId).toBe(labelId);
    expect(await loadLedgerCounts(pool)).toEqual(countsBefore);
  });

  it("discovers an empty sibling under the SELECT-only role without granting item authority", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-DISCOVERY", 2);
    const providerOrderId = "provider-order-discovery-1";
    const primaryLabelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerLabelId: "44001",
      trackingNumber: "1Z999AA10123456784",
      providerOrderId,
      contentsStatus: "authoritative",
    });
    const emptySiblingLabelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerLabelId: "44002",
      trackingNumber: "1Z999AA10123456785",
      providerOrderId,
      contentsStatus: "empty",
      receivedAt: "2026-08-23T14:05:00.000Z",
    });
    await seedAuthorityDiscoveryRelations(
      pool,
      sourceId,
      primaryLabelId,
      providerOrderId,
    );
    const countsBefore = await loadLedgerCounts(pool);
    const result = await withExecutionAuditRole(pool, async (scopedPool) => {
      const service = new PackageAllocationAuthorityResolutionPreviewService(
        new PgPackageAllocationLedgerRepository(scopedPool),
      );
      return service.previewDiscovered({
        contractVersion: 1,
        authorityMode: "shadow_only",
        previewMode: "bootstrap_relationship_discovery",
        groupKey: PRIMARY_GROUP_KEY,
        sourceWmsShipmentItemIds: [sourceId],
      });
    });

    expect(result).toMatchObject({
      contractVersion: 1,
      authority: "none",
      outcome: "review",
      previewMode: "bootstrap_relationship_discovery",
      selectionAuthority: "database_relationship_closure",
      selectionCompleteness: "unproven_outside_persisted_relationships",
      selectedShippingProviderLabelIds: [primaryLabelId, emptySiblingLabelId],
      relationshipSelectionEvidence: {
        contractVersion: 1,
        evidenceType: "package_allocation_relationship_selection",
        evidenceHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        sourceWmsShipmentItemIds: [sourceId],
        packages: [
          {
            shippingProviderLabelId: primaryLabelId,
            relationshipTypes: [
              "provider_order_id_match",
              "shipping_engine_order_link",
            ],
          },
          {
            shippingProviderLabelId: emptySiblingLabelId,
            relationshipTypes: [
              "provider_order_id_match",
            ],
          },
        ],
      },
      groupState: "absent",
      readiness: {
        authority: "none",
        packageAssessments: [
          { lifecycleStatus: "projected" },
          { lifecycleStatus: "projected" },
        ],
      },
      resolution: {
        authority: "shadow_only",
        outcome: "review",
        reviews: [{ code: "package_contents_unavailable" }],
      },
    });
    const emptyPackageKey = packageAllocationPackageKey(
      "shipstation",
      "44002",
    );
    expect(result.resolution?.plannerResult.state.packageSnapshots.some(
      (snapshot) => snapshot.packageKey === emptyPackageKey,
    )).toBe(true);
    expect(result.resolution?.plannerResult.state.allocations.some(
      (entry) => entry.packageKey === emptyPackageKey,
    )).toBe(false);
    expect(result.resolution?.plannerResult.state.desiredEffectIntents.some(
      (intent) => intent.packageKey === emptyPackageKey
        && intent.wmsShipmentItemId !== null,
    )).toBe(false);
    expect(result.resolution?.plannerResult.state.desiredEffectIntents.every(
      (intent) => intent.executable === false,
    )).toBe(true);
    expect(await loadLedgerCounts(pool)).toEqual(countsBefore);
  });

  it("discovers a full order but grants only the exact disjoint package group", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-SELECTED", 2);
    const otherId = await seedCustomerFulfillmentSource(pool, "SKU-OTHER", 2);
    const providerOrderId = "disjoint-order";
    const selectedLabel = await seedAuthorityReadinessLabel(pool, sourceId, { providerOrderId });
    const otherLabel = await seedAuthorityReadinessLabel(pool, otherId, { providerOrderId,
      providerLabelId: "44002", trackingNumber: "TRACK-OTHER", receivedAt: "2026-08-23T13:00:00.000Z" });
    await seedAuthorityDiscoveryRelations(pool, sourceId, selectedLabel, providerOrderId);
    const service = new PackageAllocationBootstrapPersistenceService(new PgPackageAllocationLedgerRepository(pool));
    const input = { contractVersion: 1 as const, authorityMode: "shadow_only" as const,
      bootstrapMode: "relationship_discovery" as const, sourceWmsShipmentItemIds: [sourceId],
      writeContext: { createdBy: "integration:order-package-scope", reason: "Disjoint order lines do not compete for source quantity" } };
    const result = await service.persistDiscovered(input);
    expect(result.outcome).toBe("persisted");
    expect(result.selectedShippingProviderLabelIds).toEqual([selectedLabel, otherLabel]);
    expect(result.resolution?.plannerInput.packages).toHaveLength(1);
    const plan = await pool.query("SELECT authority_snapshot FROM wms.package_allocation_plans WHERE id=$1", [result.persistence!.planId]);
    expect(plan.rows[0].authority_snapshot).toMatchObject({ excludedUnrelatedEvidenceKeys: [`shipping-provider-label:${otherLabel}`] });
    expect((await loadLedgerCounts(pool)).packageBindings).toBe(1);
    await expect(service.persistDiscovered(input)).resolves.toMatchObject({ persistence: { kind: "unchanged" } });
  });

  it("persists and exact-replays one relationship-discovered inert bootstrap plan", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-BOOTSTRAP", 2);
    const providerOrderId = "provider-order-bootstrap-1";
    const labelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerOrderId,
    });
    await seedAuthorityDiscoveryRelations(pool, sourceId, labelId, providerOrderId);
    const repository = new PgPackageAllocationLedgerRepository(pool);
    const service = new PackageAllocationBootstrapPersistenceService(repository);
    const bootstrapCommand = {
      contractVersion: 1 as const,
      authorityMode: "shadow_only" as const,
      bootstrapMode: "relationship_discovery" as const,
      sourceWmsShipmentItemIds: [sourceId],
      writeContext: {
        createdBy: "test:package-allocation-bootstrap",
        reason: "Prove locked relationship-discovered bootstrap persistence",
      },
    };

    const created = await service.persistDiscovered(bootstrapCommand);
    const replay = await service.persistDiscovered(bootstrapCommand);

    expect(created).toMatchObject({
      authority: "shadow_only",
      groupKey: derivePackageAllocationBootstrapGroupKey([sourceId]),
      outcome: "persisted",
      selectedShippingProviderLabelIds: [labelId],
      persistence: {
        kind: "created",
        persistedPlanVersion: 1,
      },
    });
    expect(replay).toMatchObject({
      outcome: "persisted",
      groupKey: created.groupKey,
      persistence: {
        kind: "unchanged",
        groupId: created.persistence?.groupId,
        planId: created.persistence?.planId,
        persistedPlanVersion: 1,
      },
    });
    expect(created.resolution?.plannerResult.state.desiredEffectIntents.every(
      (intent) => intent.executable === false,
    )).toBe(true);

    const persisted = await pool.query<{
      authority_snapshot: Record<string, unknown>;
      executable_count: number;
      intent_count: number;
      outbox_count: number;
    }>(
      `SELECT
         plan.authority_snapshot,
         COUNT(intent.id) FILTER (WHERE intent.executable)::integer AS executable_count,
         COUNT(intent.id)::integer AS intent_count,
         COUNT(outbox.id)::integer AS outbox_count
       FROM wms.package_allocation_plans AS plan
       LEFT JOIN wms.package_allocation_effect_intents AS intent
         ON intent.package_allocation_plan_id = plan.id
       LEFT JOIN wms.package_allocation_effect_outbox AS outbox
         ON outbox.package_allocation_effect_intent_id = intent.id
       WHERE plan.id = $1::bigint
       GROUP BY plan.id`,
      [created.persistence?.planId],
    );
    expect(persisted.rows[0]).toMatchObject({
      authority_snapshot: {
        contractVersion: 1,
        authorityMode: "shadow_only",
        selectionAuthority: "database_relationship_closure",
        selectionCompleteness: "unproven_outside_persisted_relationships",
        relationshipSelectionEvidence: {
          evidenceHash: created.relationshipSelectionEvidence.evidenceHash,
          sourceWmsShipmentItemIds: [sourceId],
          packages: [{ shippingProviderLabelId: labelId }],
        },
      },
      executable_count: 0,
      intent_count: created.resolution?.plannerResult.state.desiredEffectIntents.length,
      outbox_count: created.resolution?.plannerResult.state.desiredEffectIntents.length,
    });
    const counts = await loadLedgerCounts(pool);
    expect(counts).toMatchObject({
      groups: 1,
      sourceLines: 1,
      memberships: 1,
      packageBindings: 1,
      plans: 1,
      entries: created.resolution?.plannerResult.state.allocations.length,
      intents: created.resolution?.plannerResult.state.desiredEffectIntents.length,
      effectOutbox: created.resolution?.plannerResult.state.desiredEffectIntents.length,
    });
  });

  it("retains complete registered source closure for a subset observation and refuses group ambiguity", async () => {
    const firstId = await seedCustomerFulfillmentSource(pool, "SKU-CLOSURE-1", 2);
    const secondId = await seedCustomerFulfillmentSource(pool, "SKU-CLOSURE-2", 2);
    const thirdId = await seedCustomerFulfillmentSource(pool, "SKU-CLOSURE-3", 2);
    const labelId = await seedAuthorityReadinessLabel(pool, firstId, { providerOrderId: "closure-order",
      contentsLines: [firstId, secondId].map((id) => ({ lineItemKey: `wms-item-${id}`, quantity: 2 })) });
    const shipment = await pool.query<{ id: number }>("INSERT INTO wms.outbound_shipments DEFAULT VALUES RETURNING id");
    await pool.query("UPDATE wms.outbound_shipment_items SET shipment_id = $1 WHERE id = ANY($2::int[])", [shipment.rows[0].id, [firstId, secondId]]);
    await pool.query(`INSERT INTO wms.shipping_provider_label_links (shipping_provider_label_id, legacy_wms_shipment_id)
      VALUES ($1, $2)`, [labelId, shipment.rows[0].id]);
    const repository = new PgPackageAllocationLedgerRepository(pool);
    const service = new PackageAllocationBootstrapPersistenceService(repository);
    const command = { contractVersion: 1 as const, authorityMode: "shadow_only" as const,
      bootstrapMode: "relationship_discovery" as const, sourceWmsShipmentItemIds: [firstId, secondId],
      writeContext: { createdBy: "system:closure-test", reason: "Keep the full original group for partial label observations" } };
    const initial = await service.persistDiscovered(command);
    expect(initial).toMatchObject({ outcome: "persisted", persistence: { currentGroupVersion: 1 } });
    const partial = await service.persistDiscovered({ ...command, sourceWmsShipmentItemIds: [secondId] });
    expect(partial).toMatchObject({ groupKey: initial.groupKey, outcome: "persisted",
      persistence: { kind: "unchanged", planId: initial.persistence!.planId },
      relationshipSelectionEvidence: { sourceWmsShipmentItemIds: [firstId, secondId] } });
    expect(await repository.withSerializableTransaction((tx) => tx.lockSourceGroupClosure([secondId])))
      .toMatchObject({ group: { groupKey: initial.groupKey }, sourceWmsShipmentItemIds: [firstId, secondId] });
    const before = await loadLedgerCounts(pool);
    await expect(service.persistDiscovered({ ...command, sourceWmsShipmentItemIds: [firstId, thirdId] }))
      .rejects.toMatchObject({ code: "SOURCE_ALREADY_GROUPED" });
    expect(await loadLedgerCounts(pool)).toEqual(before);
    const other = await new PackageAllocationPlanningService(repository).persist(commandFor(thirdId, {
      groupKey: "be4ad193-2e4a-4e50-bf4b-0eb79489ff33", packageKey: "other-package", providerPhysicalShipmentId: "44122" }));
    expect(other.currentGroupVersion).toBe(1);
    const grouped = await loadLedgerCounts(pool);
    await expect(service.persistDiscovered({ ...command, sourceWmsShipmentItemIds: [firstId, thirdId] }))
      .rejects.toMatchObject({ code: "SOURCE_ALREADY_GROUPED" });
    expect(await loadLedgerCounts(pool)).toEqual(grouped);
    // A provider relationship moving to another label must not erase the old
    // registered package's history or imply that its contents transferred.
    const replacementLabelId = await seedAuthorityReadinessLabel(pool, firstId, { providerLabelId: "44123",
      contentsLines: [firstId, secondId].map((id) => ({ lineItemKey: `wms-item-${id}`, quantity: 2 })) });
    await pool.query("DELETE FROM wms.shipping_provider_label_links WHERE shipping_provider_label_id = $1", [labelId]);
    await pool.query(`INSERT INTO wms.shipping_provider_label_links (shipping_provider_label_id, legacy_wms_shipment_id)
      VALUES ($1, $2)`, [replacementLabelId, shipment.rows[0].id]);
    await expect(service.persistDiscovered(command)).resolves.toMatchObject({ outcome: "review",
      reviewReason: "persisted_package_history_missing", persistence: null });
    expect(await loadLedgerCounts(pool)).toEqual(grouped);
  });

  it("replays a persisted lead-authorized cancellation through discovered versioned history", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-PERSISTED-ACTION-HISTORY", 2);
    const labelId = await seedAuthorityReadinessLabel(pool, sourceId, { providerOrderId: "history-order" });
    await seedAuthorityDiscoveryRelations(pool, sourceId, labelId, "history-order");
    const repository = new PgPackageAllocationLedgerRepository(pool);
    const bootstrap = new PackageAllocationBootstrapPersistenceService(repository);
    const input = { contractVersion: 1 as const, authorityMode: "shadow_only" as const,
      bootstrapMode: "relationship_discovery" as const, sourceWmsShipmentItemIds: [sourceId],
      writeContext: { createdBy: "system:history-test", reason: "Observe exact persisted package history" } };
    expect(await bootstrap.persistDiscovered(input)).toMatchObject({ outcome: "persisted" });
    const observed = await pool.query<{ sanitized_payload: Record<string, unknown> }>(
      "SELECT sanitized_payload FROM wms.shipping_provider_label_events WHERE shipping_provider_label_id = $1", [labelId]);
    const voidedAt = "2026-08-23T14:02:00.000Z";
    const payload = { ...observed.rows[0].sanitized_payload, voidDate: voidedAt };
    const eventHash = createHash("sha256").update(canonicalJson({ provider: "shipstation", ...payload, labelStatus: "voided" })).digest("hex");
    await pool.query(`INSERT INTO wms.shipping_provider_label_events (shipping_provider_label_id, event_hash,
      event_type, label_status, tracking_number, provider_occurred_at, received_at, sanitized_payload)
      VALUES ($1, $2, 'label_voided', 'voided', '1Z999AA10123456784', $3, $3, $4::jsonb)`,
    [labelId, eventHash, voidedAt, JSON.stringify(payload)]);
    await pool.query("UPDATE wms.shipping_provider_labels SET label_status = 'voided', last_observed_at = $2 WHERE id = $1", [labelId, voidedAt]);
    const voided = await bootstrap.persistDiscovered(input);
    expect(voided).toMatchObject({ outcome: "persisted", persistence: { currentGroupVersion: 2 } });
    const action = { kind: "cancel_awaiting_allocation" as const, actionKey: "lead-confirmed-history-cancel",
      fromPackageKey: packageAllocationPackageKey("shipstation", "44001"), wmsShipmentItemId: sourceId, quantity: 1,
      authorization: { kind: "lead_approved" as const, actor: "shipping-lead-42", reason: "Cancel one exact pre-possession unit" } };
    const resolved = voided.resolution!.plannerInput;
    const saved = await repository.withSerializableTransaction(async (tx) => {
      const current = await tx.loadPlanByVersion(voided.persistence!.groupId, 2);
      const { previousPlan: _previousPlan, ...plannerCommand } = resolved;
      return new PackageAllocationPlanningService(repository).persistInTransaction(tx,
        { ...plannerCommand, expectedGroupVersion: 2, actions: [action], writeContext: { createdBy: "shipping-lead-42", reason: action.authorization.reason } },
        packageAllocationPlanAuthoritySnapshotSchema.parse(current!.authoritySnapshot));
    });
    expect(saved).toMatchObject({ kind: "created", currentGroupVersion: 3 });
    const before = await loadLedgerCounts(pool);
    const replay = await bootstrap.persistDiscovered(input);
    expect(replay).toMatchObject({ outcome: "persisted", persistence: { kind: "unchanged", planId: saved.planId,
      currentGroupVersion: 3, plannerResult: { state: { appliedActionKeys: [action.actionKey] } } } });
    expect(replay.persistence!.plannerResult.state.actionEvidence[0].action).toEqual(action);
    expect(await loadLedgerCounts(pool)).toEqual(before);
  });

  it("rolls back bootstrap state when discovered contents remain unresolved", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-BOOTSTRAP-REVIEW", 2);
    const providerOrderId = "provider-order-bootstrap-review-1";
    const labelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerOrderId,
      contentsStatus: "empty",
    });
    await seedAuthorityDiscoveryRelations(pool, sourceId, labelId, providerOrderId);
    const countsBefore = await loadLedgerCounts(pool);

    const result = await new PackageAllocationBootstrapPersistenceService(
      new PgPackageAllocationLedgerRepository(pool),
    ).persistDiscovered({
      contractVersion: 1,
      authorityMode: "shadow_only",
      bootstrapMode: "relationship_discovery",
      sourceWmsShipmentItemIds: [sourceId],
      writeContext: {
        createdBy: "test:package-allocation-bootstrap",
        reason: "Do not persist unresolved package contents",
      },
    });

    expect(result).toMatchObject({
      outcome: "review",
      persistence: null,
      selectedShippingProviderLabelIds: [labelId],
      resolution: {
        outcome: "review",
        reviews: [{ code: "package_contents_unavailable" }],
      },
    });
    expect(await loadLedgerCounts(pool)).toEqual(countsBefore);
  });

  it("persists one complete inert plan and exact-replays it without duplicate rows", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-ONE", 2);
    const command = commandFor(sourceId);
    const repository = new PgPackageAllocationLedgerRepository(pool);
    const service = new PackageAllocationPlanningService(repository);

    const created = await service.persist(command);
    const replay = await service.persist(command);

    expect(created).toMatchObject({
      kind: "created",
      persistedPlanVersion: 1,
      currentGroupVersion: 1,
    });
    expect(replay).toMatchObject({
      kind: "already_persisted",
      groupId: created.groupId,
      planId: created.planId,
      persistedPlanVersion: 1,
      currentGroupVersion: 1,
    });
    expect(created.planId).not.toBeNull();

    const persistedGraph = await repository.withSerializableTransaction(async (transaction) => ({
      entries: await transaction.loadPlanEntries(created.planId!),
      intents: await transaction.loadPlanIntents(created.planId!),
      effectOutbox: await transaction.loadPlanEffectOutbox(created.planId!),
    }));
    expect(persistedGraph.entries).toEqual(
      created.plannerResult.ledgerEntriesToAppend.map(expectedEntry),
    );
    expect(persistedGraph.intents).toEqual(
      created.plannerResult.effectIntentsToAppend.map(expectedIntent),
    );
    expect(persistedGraph.effectOutbox).toEqual(
      created.plannerResult.effectIntentsToAppend.map(expectedEffectOutbox),
    );

    const counts = await loadLedgerCounts(pool);
    expect(counts).toEqual({
      groups: 1,
      sourceLines: 1,
      memberships: 1,
      allocationKeys: new Set(
        created.plannerResult.ledgerEntriesToAppend.map((entry) => entry.allocationKey),
      ).size,
      packageBindings: 1,
      plans: 1,
      entries: created.plannerResult.ledgerEntriesToAppend.length,
      intents: created.plannerResult.effectIntentsToAppend.length,
      effectOutbox: created.plannerResult.effectIntentsToAppend.length,
    });

    const planEvidence = await pool.query<{
      current_version: number;
      input_hash: string;
      state_hash: string;
      state_snapshot: unknown;
      review_snapshot: unknown;
      all_intents_inert: boolean;
      all_package_targets_bound: boolean;
      all_package_intents_bound: boolean;
    }>(
      `SELECT
         package_group.current_version,
         plan.input_hash,
         plan.state_hash,
         plan.state_snapshot,
         plan.review_snapshot,
         NOT EXISTS (
           SELECT 1
           FROM wms.package_allocation_effect_intents
           WHERE executable
         ) AS all_intents_inert,
         NOT EXISTS (
           SELECT 1
           FROM wms.package_allocation_entries
           WHERE target_kind = 'package'
             AND package_allocation_package_binding_id IS NULL
         ) AS all_package_targets_bound,
         NOT EXISTS (
           SELECT 1
           FROM wms.package_allocation_effect_intents
           WHERE package_allocation_package_binding_id IS NULL
             AND payload->>'packageKey' IS NOT NULL
         ) AS all_package_intents_bound
       FROM wms.package_allocation_groups AS package_group
       JOIN wms.package_allocation_plans AS plan
         ON plan.package_allocation_group_id = package_group.id
       WHERE package_group.group_key = $1::uuid`,
      [PRIMARY_GROUP_KEY],
    );
    expect(planEvidence.rows[0]).toMatchObject({
      current_version: 1,
      input_hash: created.plannerResult.evidenceHash,
      state_hash: created.plannerResult.stateHash,
      state_snapshot: created.plannerResult.state,
      review_snapshot: {
        contractVersion: 1,
        reviews: created.plannerResult.state.reviews,
      },
      all_intents_inert: true,
      all_package_targets_bound: true,
      all_package_intents_bound: true,
    });
    await expect(pool.query(
      `UPDATE wms.package_allocation_effect_outbox
       SET state = 'ready'
       WHERE package_allocation_effect_intent_id IN (
         SELECT id
         FROM wms.package_allocation_effect_intents
         WHERE package_allocation_plan_id = $1::bigint
       )`,
      [created.planId],
    )).rejects.toMatchObject({ code: "55000" });

    const immutableEvidence = await pool.query<{
      source_quantity: number;
      shipment_item_purpose: string;
      sku: string;
      package_key: string;
      provider: string;
      provider_physical_shipment_id: string;
    }>(
      `SELECT
         source.source_quantity,
         source.shipment_item_purpose,
         source.sku,
         binding.package_key,
         binding.provider,
         binding.provider_physical_shipment_id
       FROM wms.package_allocation_group_source_lines AS membership
       JOIN wms.package_allocation_source_lines AS source
         ON source.id = membership.package_allocation_source_line_id
       JOIN wms.package_allocation_package_bindings AS binding
         ON binding.package_allocation_group_id = membership.package_allocation_group_id`,
    );
    expect(immutableEvidence.rows).toEqual([{
      source_quantity: 2,
      shipment_item_purpose: "customer_fulfillment",
      sku: "SKU-ONE",
      package_key: "package-a",
      provider: "shipstation",
      provider_physical_shipment_id: "44001",
    }]);
  });

  it("binds one exact current package allocation entry to one matching physical shipment item", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-PROVENANCE", 2);
    const repository = new PgPackageAllocationLedgerRepository(pool);
    const service = new PackageAllocationPlanningService(repository);
    const persisted = await service.persist(commandFor(sourceId));
    expect(persisted.planId).not.toBeNull();

    const provenance = await pool.query<{
      entry_id: string;
      order_item_id: number;
    }>(
      `SELECT
         entry.id::text AS entry_id,
         source.order_item_id
       FROM wms.package_allocation_entries AS entry
       JOIN wms.package_allocation_source_lines AS source
         ON source.id = entry.package_allocation_source_line_id
       WHERE entry.package_allocation_plan_id = $1::bigint
         AND entry.target_kind = 'package'`,
      [persisted.planId],
    );
    expect(provenance.rows).toHaveLength(1);

    const physical = await pool.query<{ id: string }>(
      `INSERT INTO wms.physical_shipments (
         provider,
         provider_physical_shipment_id
       ) VALUES ('shipstation', '44001')
       RETURNING id::text AS id`,
    );
    const mismatchedPhysical = await pool.query<{ id: string }>(
      `INSERT INTO wms.physical_shipments (
         provider,
         provider_physical_shipment_id
       ) VALUES ('shipstation', '99999')
       RETURNING id::text AS id`,
    );
    const values = [
      provenance.rows[0].entry_id,
      provenance.rows[0].order_item_id,
      "SKU-PROVENANCE",
    ] as const;

    await expect(pool.query(
      `INSERT INTO wms.physical_shipment_items (
         physical_shipment_id,
         package_allocation_entry_id,
         wms_order_item_id,
         sku,
         quantity_shipped
       ) VALUES ($1::bigint, $2::bigint, $3::integer, $4, 1)`,
      [physical.rows[0].id, ...values],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(
      `INSERT INTO wms.physical_shipment_items (
         physical_shipment_id,
         package_allocation_entry_id,
         wms_order_item_id,
         sku,
         quantity_shipped
       ) VALUES ($1::bigint, $2::bigint, $3::integer, $4, 2)`,
      [mismatchedPhysical.rows[0].id, ...values],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(
      `INSERT INTO wms.physical_shipment_items (
         physical_shipment_id,
         legacy_wms_shipment_item_id,
         package_allocation_entry_id,
         wms_order_item_id,
         sku,
         quantity_shipped
       ) VALUES ($1::bigint, $2::integer, $3::bigint, $4::integer, $5, 2)`,
      [physical.rows[0].id, sourceId, ...values],
    )).rejects.toMatchObject({ code: "23514" });

    const inserted = await pool.query<{
      id: string;
      package_allocation_entry_id: string;
    }>(
      `INSERT INTO wms.physical_shipment_items (
         physical_shipment_id,
         package_allocation_entry_id,
         wms_order_item_id,
         sku,
         quantity_shipped
       ) VALUES ($1::bigint, $2::bigint, $3::integer, $4, 2)
       RETURNING id::text AS id, package_allocation_entry_id::text`,
      [physical.rows[0].id, ...values],
    );
    expect(inserted.rows[0].package_allocation_entry_id).toBe(
      provenance.rows[0].entry_id,
    );

    const effective = await pool.query<{
      package_allocation_entry_id: string;
      quantity_shipped: number;
    }>(
      `SELECT package_allocation_entry_id::text, quantity_shipped
       FROM wms.effective_physical_shipment_items
       WHERE id = $1::bigint`,
      [inserted.rows[0].id],
    );
    expect(effective.rows).toEqual([{
      package_allocation_entry_id: provenance.rows[0].entry_id,
      quantity_shipped: 2,
    }]);

    await expect(pool.query(
      `INSERT INTO wms.physical_shipment_items (
         physical_shipment_id,
         package_allocation_entry_id,
         wms_order_item_id,
         sku,
         quantity_shipped
       ) VALUES ($1::bigint, $2::bigint, $3::integer, $4, 2)`,
      [physical.rows[0].id, ...values],
    )).rejects.toMatchObject({ code: "23505" });
  });

  it.each([1, 3])("reconciles omitted eBay package quantity %s without another provider write", async (quantity) => {
    const sourceId = await seedCommercialFulfillmentAuthoritySource(pool, "SKU-EBAY-OMITTED-QUANTITY", quantity);
    const source = await pool.query<{
      shipment_id: number;
      order_id: number;
      oms_order_id: string;
      oms_line_id: string;
      channel_id: number;
    }>(`SELECT si.shipment_id, oi.order_id, ol.order_id::text AS oms_order_id,
      ol.id::text AS oms_line_id, o.channel_id
      FROM wms.outbound_shipment_items si JOIN wms.order_items oi ON oi.id=si.order_item_id
      JOIN oms.oms_order_lines ol ON ol.id=oi.oms_order_line_id
      JOIN oms.oms_orders o ON o.id=ol.order_id WHERE si.id=$1`, [sourceId]);
    const lineage = source.rows[0];
    const externalOrderId = "09-10000-10001";
    const externalLineId = "10083776958108";
    const trackingNumber = "9400150106151382305802";
    await pool.query("UPDATE channels.channels SET provider='ebay' WHERE id=$1", [lineage.channel_id]);
    await pool.query("UPDATE oms.oms_orders SET external_order_id=$2 WHERE id=$1", [lineage.oms_order_id, externalOrderId]);
    await pool.query("UPDATE oms.oms_order_lines SET external_line_item_id=$2, fulfillment_provider='ebay' WHERE id=$1", [lineage.oms_line_id, externalLineId]);
    await pool.query("UPDATE wms.orders SET channel_id=$2,source='ebay',external_order_id=$3 WHERE id=$1", [lineage.order_id, lineage.channel_id, externalOrderId]);
    await pool.query("UPDATE wms.outbound_shipments SET channel_id=$2,tracking_number=$3,carrier='USPS' WHERE id=$1", [lineage.shipment_id, lineage.channel_id, trackingNumber]);
    await seedOutboundBusinessShipmentLabel(pool, {
      providerPhysicalShipmentId: "44010", trackingNumber,
      labelStatus: "active", ordinal: 44010, carrier: "stamps_com",
    });
    await pool.query(`INSERT INTO wms.physical_shipments (provider,provider_physical_shipment_id,tracking_number,carrier,status)
      VALUES ('shipstation','44010',$1,'USPS','shipped')`, [trackingNumber]);
    const planning = new PackageAllocationPlanningService(new PgPackageAllocationLedgerRepository(pool));
    const persisted = await planning.persist({
      contractVersion: 1,
      authorityMode: "shadow_only",
      groupKey: "a6e1be0d-c7d8-4c91-919f-04f5eb547f81",
      expectedGroupVersion: 0,
      sourceLines: [{ wmsShipmentItemId: sourceId, sourceQuantity: quantity,
        physicalConsumptionAuthorityQuantity: quantity, authorityVersion: 1 }],
      packages: [{
        packageKey: "A", allocationRole: "primary",
        membership: { status: "proven", evidenceKey: "membership:A" },
        lifecycle: {
          provider: "shipstation", providerPhysicalShipmentId: "44010",
          events: [{
            kind: "outbound_label_observed", eventKey: "shipstation:44010:observed",
            observedAt: "2026-08-22T14:00:00.000Z", providerOccurredAt: "2026-08-22T13:59:50.000Z", trackingNumber,
            contentsEvidence: { status: "authoritative", lines: [{ wmsShipmentItemId: sourceId, quantity }] },
          }],
        },
      }],
      actions: [],
      writeContext: { createdBy: "integration:ebay-quantity-evidence", reason: "Prove existing whole-order fulfillment readback" },
    });
    expect(persisted.planId).not.toBeNull();
    const repository = createChannelFulfillmentAuthorityRepository(getTestDb());
    const materialized = await repository.materializePackageAllocationCommercialFulfillment({
      packageAllocationPlanId: persisted.planId!, source: "integration:ebay-quantity-evidence",
    });
    expect(materialized.channelCommands).toHaveLength(1);
    const now = new Date("2026-08-22T14:06:00.000Z");
    await repository.activatePackageAllocationCommercialFulfillment({
      packageAllocationPlanId: persisted.planId!, activatedBy: "integration:ebay-quantity-evidence",
      reason: "Prove exact readback without duplicate provider fulfillment", activatedAt: now,
    });
    const commandId = materialized.channelCommands[0].id;
    let claimed = await repository.claimCommands({
      now, leaseToken: "ebay-omitted-quantity", leaseDurationMs: 60000, limit: 1, commandIds: [commandId],
    });
    expect(claimed).toHaveLength(1);
    // Reproduce the previous terminal failure through the owner, not a direct
    // status update. Review recovery must preserve this immutable first attempt.
    await repository.completeAttempt({
      commandId, leaseToken: claimed[0].leaseToken, startedAt: now, completedAt: now,
      outcome: "review_required", errorCode: "ebay_fulfillment_idempotency_conflict",
      errorMessage: "Existing matching package omitted quantity",
    });
    const reviewRetry = createChannelFulfillmentReviewRetryRepository(getTestDb());
    const scope = { commandId, omsOrderId: Number(lineage.oms_order_id) };
    const preview = await reviewRetry.preview(scope);
    expect(preview).toMatchObject({ eligibleForRecheck: true, providerValidation: "not_performed",
      snapshot: { status: "review", attemptCount: 1, items: [{ quantity }] } });
    await expect(reviewRetry.preview({ ...scope, omsOrderId: scope.omsOrderId + 999 })).rejects.toMatchObject({
      code: "REVIEW_RETRY_COMMAND_NOT_FOUND", status: 404,
    });
    const retryInput = { ...scope, expectedStateFingerprint: preview.stateFingerprint,
      actor: "integration:reviewer", reason: "Provider whole-order readback now proves the omitted quantity", requeuedAt: now };
    await expect(reviewRetry.requeue({ ...retryInput, expectedStateFingerprint: "0".repeat(64) })).rejects.toMatchObject({
      code: "REVIEW_RETRY_STATE_CHANGED", status: 409,
    });
    const countAudits = async (): Promise<number> => Number((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM oms.channel_fulfillment_push_requeues WHERE channel_fulfillment_push_id=$1", [commandId],
    )).rows[0].count);
    expect(await countAudits()).toBe(0);
    if (quantity === 3) {
      // Fail after the audit insert. PostgreSQL must roll both audit and command
      // transition back; a second request must still be able to perform recovery.
      await pool.query(`CREATE FUNCTION oms.reject_test_review_retry_pending() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF OLD.push_status='review' AND NEW.push_status='pending' THEN
          RAISE EXCEPTION 'Injected retry transition failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER reject_test_review_retry_pending BEFORE UPDATE ON oms.channel_fulfillment_pushes
          FOR EACH ROW EXECUTE FUNCTION oms.reject_test_review_retry_pending();`);
      try {
        await expect(reviewRetry.requeue(retryInput)).rejects.toMatchObject({ code: "REVIEW_RETRY_DATABASE_ERROR" });
        expect(await countAudits()).toBe(0);
        expect((await reviewRetry.preview(scope)).stateFingerprint).toBe(preview.stateFingerprint);
      } finally {
        await pool.query(`DROP TRIGGER reject_test_review_retry_pending ON oms.channel_fulfillment_pushes;
          DROP FUNCTION oms.reject_test_review_retry_pending();`);
      }
    }
    const outcomes = await Promise.all([reviewRetry.requeue(retryInput), reviewRetry.requeue(retryInput)]);
    expect(outcomes.filter((outcome) => outcome.requeued)).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.replayed)).toHaveLength(1);
    expect(await countAudits()).toBe(1);
    await expect(reviewRetry.requeue({ ...retryInput, reason: "A competing distinct operator decision" })).rejects.toMatchObject({
      code: "REVIEW_RETRY_STATE_CHANGED", status: 409,
    });
    const audit = await pool.query(`SELECT operator,previous_status,previous_attempt_count,previous_error_code,previous_request_hash
      FROM oms.channel_fulfillment_push_requeues WHERE channel_fulfillment_push_id=$1`, [commandId]);
    expect(audit.rows).toEqual([expect.objectContaining({ operator: retryInput.actor,
      previous_status: "review", previous_attempt_count: 1,
      previous_error_code: "ebay_fulfillment_idempotency_conflict", previous_request_hash: preview.snapshot.requestHash })]);
    await expect(pool.query("DELETE FROM oms.channel_fulfillment_push_requeues WHERE channel_fulfillment_push_id=$1", [commandId]))
      .rejects.toMatchObject({ code: "55000" });
    claimed = await repository.claimCommands({
      now, leaseToken: "ebay-reviewed-recovery", leaseDurationMs: 60000, limit: 1, commandIds: [commandId],
    });
    expect(claimed).toHaveLength(1);
    expect(claimed[0].attemptNumber).toBe(2);
    const fulfillmentPath = `/sell/fulfillment/v1/order/${externalOrderId}/shipping_fulfillment`;
    const providerRequest = vi.fn(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-ebay-token");
      const requested = new URL(String(url));
      expect(requested.origin).toBe("https://api.ebay.com");
      if (requested.pathname === fulfillmentPath) {
        return Response.json({ total: 1, fulfillments: [{ fulfillmentId: trackingNumber,
          shipmentTrackingNumber: trackingNumber, shippedDate: "2026-08-22T14:00:00.000Z",
          lineItems: [{ lineItemId: externalLineId }] }] });
      }
      if (requested.pathname === `/sell/fulfillment/v1/order/${externalOrderId}`) {
        return Response.json({
          orderId: externalOrderId, orderFulfillmentStatus: "FULFILLED",
          fulfillmentHrefs: [`https://api.ebay.com${fulfillmentPath}/${trackingNumber}`],
          cancelStatus: { cancelState: "NONE_REQUESTED", cancelRequests: [] },
          lineItems: [{ lineItemId: externalLineId, quantity, lineItemFulfillmentStatus: "FULFILLED" }],
        });
      }
      throw new Error(`Unexpected eBay request path ${requested.pathname}`);
    });
    const client = new EbayApiClient({
      getAccessToken: async (channelId) => {
        expect(channelId).toBe(lineage.channel_id);
        return "fixture-ebay-token";
      },
    }, lineage.channel_id, "production", { request: providerRequest, strictFulfillmentReadback: true });
    const shopify = vi.fn(async () => { throw new Error("Unexpected Shopify account resolution"); });
    const ebay = vi.fn(async (channelId: number) => {
      expect(channelId).toBe(lineage.channel_id);
      return { channelId, externalAccountId: "fixture-ebay-seller", client };
    });
    const executor = createCompatibilityChannelFulfillmentProviderExecutor(
      createFulfillmentPushService(getTestDb(), null, { providerClients: { shopify, ebay } }),
    );
    const result = await executor.execute(claimed[0]);
    expect(result.outcome).toBe("success");
    await repository.completeAttempt({ commandId, leaseToken: claimed[0].leaseToken,
      startedAt: now, completedAt: new Date("2026-08-22T14:06:01.000Z"), ...result });
    // Replaying the provider boundary must recognize the same external package,
    // not issue another fulfillment even though legacy headers have no quantity.
    await expect(executor.execute(claimed[0])).resolves.toMatchObject({ outcome: "success" });
    expect(providerRequest.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(shopify).not.toHaveBeenCalled();
    const events = await pool.query<{ details: Record<string, unknown> }>(`SELECT details FROM oms.oms_order_events
      WHERE order_id=$1 AND event_type='tracking_pushed' ORDER BY id`, [lineage.oms_order_id]);
    expect(events.rows).toHaveLength(2);
    for (const event of events.rows) expect(event.details).toMatchObject({
      channelFulfillmentCommandId: commandId, fulfillmentId: trackingNumber,
      externalAccountId: "fixture-ebay-seller", quantityEvidenceSource: "provider_fulfilled_whole_order",
      lineItems: [{ lineItemId: externalLineId, quantity }],
    });
    const completed = await pool.query(`SELECT push.push_status,item.quantity_pushed FROM oms.channel_fulfillment_pushes push
      JOIN oms.channel_fulfillment_push_items item ON item.channel_fulfillment_push_id=push.id WHERE push.id=$1`, [commandId]);
    expect(completed.rows).toEqual([{ push_status: "success", quantity_pushed: quantity }]);
    await expect(reviewRetry.requeue(retryInput)).resolves.toMatchObject({ replayed: true, requeued: false });
    expect(await countAudits()).toBe(1);
    expect((await reviewRetry.preview(scope)).snapshot).toMatchObject({ status: "success", attemptCount: 2 });
    const attempts = await pool.query(`SELECT attempt_number,outcome,error_code FROM oms.channel_fulfillment_push_attempts
      WHERE channel_fulfillment_push_id=$1 ORDER BY attempt_number`, [commandId]);
    expect(attempts.rows).toEqual([
      { attempt_number: 1, outcome: "review_required", error_code: "ebay_fulfillment_idempotency_conflict" },
      { attempt_number: 2, outcome: "success", error_code: null },
    ]);
  });

  async function seedHistoricalSplitBackfill(orderedQuantity = 2, splitProviderOrderId = "99001") {
    const sourceId = await seedCommercialFulfillmentAuthoritySource(pool, "SKU-BACKFILL-SPLIT", orderedQuantity);
    const source = (await pool.query<{
      shipment_id: number; order_id: number; order_item_id: number;
      product_variant_id: number; oms_order_line_id: string;
    }>(`SELECT item.shipment_id, shipment.order_id, item.order_item_id,
         item.product_variant_id, order_item.oms_order_line_id::text
       FROM wms.outbound_shipment_items item
       JOIN wms.outbound_shipments shipment ON shipment.id = item.shipment_id
       JOIN wms.order_items order_item ON order_item.id = item.order_item_id
       WHERE item.id = $1`, [sourceId])).rows[0];
    await pool.query("UPDATE wms.outbound_shipment_items SET qty = 1 WHERE id = $1", [sourceId]);
    await pool.query("UPDATE wms.outbound_shipments SET status = 'shipped' WHERE id = $1", [source.shipment_id]);
    const split = (await pool.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipments (
         order_id, status, shipping_engine, engine_order_ref, shipstation_order_key,
         external_fulfillment_id, tracking_number, carrier
       ) VALUES ($1, 'shipped', 'shipstation', $2, 'provider-order-key-99001',
         'shipstation_shipment:44011', '1Z0000000000044011', 'ups') RETURNING id`,
      [source.order_id, splitProviderOrderId],
    )).rows[0];
    await pool.query(`INSERT INTO wms.outbound_shipment_items (
       shipment_id, order_item_id, split_root_shipment_item_id, shipment_item_purpose,
       product_variant_id, qty
     ) VALUES ($1, $2, $3, 'customer_fulfillment', $4, 1)`,
    [split.id, source.order_item_id, sourceId, source.product_variant_id]);
    // Historical dispatch already updated WMS. Backfill must not do it again.
    await pool.query("UPDATE wms.order_items SET fulfilled_quantity = 2 WHERE id = $1", [source.order_item_id]);
    const repository = createChannelFulfillmentAuthorityRepository(getTestDb());
    const firstInput = { ...await repository.resolveLegacyPhysicalPackage(source.shipment_id), source: "historical-backfill-test" };
    const secondInput = { ...await repository.resolveLegacyPhysicalPackage(split.id), source: "historical-backfill-test" };
    return { source, split, repository, firstInput, secondInput };
  }

  async function snapshotAliasBackfillState() {
    const tables = ["wms.shipping_engine_orders", "wms.shipping_engine_order_provider_refs",
      "wms.shipping_engine_order_requests", "wms.physical_shipments", "wms.physical_shipment_items",
      "wms.fulfillment_plans", "wms.fulfillment_plan_lines", "wms.shipment_requests", "wms.shipment_request_items",
      "oms.channel_fulfillment_pushes", "oms.channel_fulfillment_push_items", "wms.order_items", "inventory.inventory_transactions"];
    const result: Record<string, unknown> = {};
    for (const table of tables) {
      result[table] = (await pool.query(`SELECT to_jsonb(record) AS data FROM ${table} record ORDER BY to_jsonb(record)::text`)).rows;
    }
    return result;
  }

  async function seedReservedSplitPackages(orderedQuantity: number, ordinal = 0, warehouseId: number | null = null) {
    const sourceId = await seedCommercialFulfillmentAuthoritySource(pool, `RESERVED-SPLIT-${ordinal}`, orderedQuantity);
    const source = (await pool.query<{
      shipment_id: number; order_id: number; order_item_id: number; product_variant_id: number;
      oms_order_id: string; oms_order_line_id: string; channel_id: number;
    }>(`SELECT item.shipment_id, shipment.order_id, item.order_item_id, item.product_variant_id,
        line.order_id::text AS oms_order_id, line.id::text AS oms_order_line_id, oms_order.channel_id
      FROM wms.outbound_shipment_items item JOIN wms.outbound_shipments shipment ON shipment.id=item.shipment_id
      JOIN wms.order_items order_item ON order_item.id=item.order_item_id
      JOIN oms.oms_order_lines line ON line.id=order_item.oms_order_line_id
      JOIN oms.oms_orders oms_order ON oms_order.id=line.order_id WHERE item.id=$1`, [sourceId])).rows[0];
    const providerOrderId = String(900000 + ordinal * 100);
    const orderKey = `reserved-split-order-${ordinal}`;
    const firstPackageId = String(800000 + ordinal * 100);
    const firstTracking = `1ZRESERVED${firstPackageId}`;
    const externalOrderId = `gid://shopify/Order/${700000 + ordinal * 100}`;
    const externalLineId = `gid://shopify/LineItem/${700001 + ordinal * 100}`;
    await pool.query("UPDATE oms.oms_orders SET external_order_id=$2 WHERE id=$1", [source.oms_order_id, externalOrderId]);
    await pool.query("UPDATE oms.oms_order_lines SET external_line_item_id=$2 WHERE id=$1", [source.oms_order_line_id, externalLineId]);
    await pool.query(`UPDATE wms.orders SET order_number=$2, channel_id=$3, external_order_id=$4, warehouse_id=$5 WHERE id=$1`,
      [source.order_id, `RESERVED-SPLIT-${ordinal}`, source.channel_id, externalOrderId, warehouseId]);
    await pool.query(`UPDATE wms.outbound_shipments SET engine_order_ref=$2, shipstation_order_key=$3,
      external_fulfillment_id=$4, tracking_number=$5, channel_id=$6 WHERE id=$1`,
    [source.shipment_id, providerOrderId, orderKey, `shipstation_shipment:${firstPackageId}`, firstTracking, source.channel_id]);
    // Use the real label/allocation materializer: the request is for the whole
    // ordered line, but the initial physical item has immutable ledger provenance
    // for just ONE unit. A smaller request fixture does not reproduce the bug.
    const labelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerLabelId: firstPackageId, providerOrderId, trackingNumber: firstTracking,
      contentsLines: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 1 }],
    });
    await pool.query("UPDATE wms.shipping_provider_labels SET carrier='ups',provider_order_key=$2 WHERE id=$1", [labelId, orderKey]);
    await pool.query(`INSERT INTO wms.shipping_provider_label_links (shipping_provider_label_id,legacy_wms_shipment_id)
      VALUES ($1,$2)`, [labelId, source.shipment_id]);
    const bootstrap = await new PackageAllocationBootstrapPersistenceService(new PgPackageAllocationLedgerRepository(pool))
      .persistDiscovered({ contractVersion: 1, authorityMode: "shadow_only", bootstrapMode: "relationship_discovery",
        sourceWmsShipmentItemIds: [sourceId], writeContext: { createdBy: "integration", reason: "Reserved split fixture" } });
    expect(bootstrap, JSON.stringify(bootstrap)).toMatchObject({ outcome: "persisted" });
    if (!bootstrap.persistence?.planId) throw new Error("Split fixture did not create a plan");
    const repository = createChannelFulfillmentAuthorityRepository(getTestDb());
    const initial = await repository.materializePackageAllocationCommercialFulfillment({
      packageAllocationPlanId: bootstrap.persistence.planId, source: "shipstation_label_observed",
    });
    expect(initial.customerFulfillmentItemCount).toBe(1);
    const request = (await pool.query<{ id: string; shipment_request_id: string; quantity_requested: number }>(
      "SELECT id,shipment_request_id,quantity_requested FROM wms.shipment_request_items WHERE legacy_wms_shipment_item_id=$1", [sourceId])).rows[0];
    expect(request.quantity_requested).toBe(orderedQuantity);
    // Historical carrier splitting reduced the legacy source row, not the paid
    // request or its original allocation evidence. Most rows lack a root pointer.
    await pool.query("UPDATE wms.outbound_shipment_items SET qty=1 WHERE id=$1", [sourceId]);
    await pool.query("UPDATE wms.outbound_shipments SET status='shipped' WHERE id=$1", [source.shipment_id]);
    const candidates: BackfillCandidate[] = [];
    for (let index = 1; index < orderedQuantity; index++) {
      const packageId = String(Number(firstPackageId) + index);
      const tracking = `1ZRESERVED${packageId}`;
      const shipmentId = (await pool.query<{ id: number }>(`INSERT INTO wms.outbound_shipments (
        order_id,status,source,shipping_engine,engine_order_ref,shipstation_order_key,
        external_fulfillment_id,tracking_number,carrier,channel_id)
        VALUES ($1,'shipped','shipstation_split','shipstation',$2,$3,$4,$5,'ups',$6) RETURNING id`,
      [source.order_id, String(Number(providerOrderId) + index), orderKey, `shipstation_shipment:${packageId}`, tracking, source.channel_id])).rows[0].id;
      await pool.query(`INSERT INTO wms.outbound_shipment_items (shipment_id,order_item_id,product_variant_id,qty,
        tracking_id,provider_membership_state,split_root_shipment_item_id)
        VALUES ($1,$2,$3,1,$4,'authoritative',$5)`,
      [shipmentId, source.order_item_id, source.product_variant_id, packageId, ordinal >= 15 ? sourceId : null]);
      candidates.push({ representativeShipmentId: shipmentId, shippingProvider: "shipstation", providerPhysicalShipmentId: packageId,
        legacyShipmentIds: [shipmentId], orderNumbers: [`RESERVED-SPLIT-${ordinal}`], trackingNumber: tracking,
        missingPhysicalShipment: true, missingCommandItemCount: 1 });
    }
    await pool.query("UPDATE wms.order_items SET fulfilled_quantity=$2 WHERE id=$1", [source.order_item_id, orderedQuantity]);
    return { sourceId, source, request, repository, candidates, externalOrderId, externalLineId, firstTracking, orderedQuantity };
  }

  it("reuses a full original request for historical packages and serializes competing consumption of its last unit", async () => {
    const fixture = await seedReservedSplitPackages(2);
    const input = { ...await fixture.repository.resolveLegacyPhysicalPackage(fixture.candidates[0].representativeShipmentId),
      source: "script:backfill-channel-fulfillment-authority", providerOrderIdentityPolicy: "stable_key_alias" as const, notifyCustomer: false };
    const before = await snapshotAliasBackfillState();
    await fixture.repository.validatePhysicalPackageIdentity(input);
    expect(await snapshotAliasBackfillState()).toEqual(before);
    const duplicate = (await pool.query<{ id: number }>(`INSERT INTO wms.outbound_shipments
      (order_id,status,shipping_engine,engine_order_ref,shipstation_order_key,external_fulfillment_id,tracking_number,carrier)
      SELECT order_id,status,shipping_engine,'900099',shipstation_order_key,'shipstation_shipment:800099','1ZRESERVED800099',carrier
      FROM wms.outbound_shipments WHERE id=$1 RETURNING id`, [input.legacyWmsShipmentIds[0]])).rows[0];
    await pool.query(`INSERT INTO wms.outbound_shipment_items (shipment_id,order_item_id,product_variant_id,qty)
      VALUES ($1,$2,$3,1)`, [duplicate.id, fixture.source.order_item_id, fixture.source.product_variant_id]);
    const other = { ...await fixture.repository.resolveLegacyPhysicalPackage(duplicate.id), source: input.source,
      providerOrderIdentityPolicy: "stable_key_alias" as const, notifyCustomer: false };
    const results = await Promise.allSettled([fixture.repository.materializePhysicalPackage(input), fixture.repository.materializePhysicalPackage(other)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({
      status: "rejected", reason: { code: "FULFILLMENT_AUTHORITY_EXCEEDED" },
    });
    expect((await pool.query("SELECT id,quantity_requested FROM wms.shipment_request_items")).rows)
      .toEqual([{ id: fixture.request.id, quantity_requested: 2 }]);
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.physical_shipments")).rows).toEqual([{ count: 2 }]);
  });

  it("rolls back split request reuse if command creation fails and succeeds on a clean retry", async () => {
    const fixture = await seedReservedSplitPackages(4);
    const input = { ...await fixture.repository.resolveLegacyPhysicalPackage(fixture.candidates[0].representativeShipmentId),
      source: "script:backfill-channel-fulfillment-authority", providerOrderIdentityPolicy: "stable_key_alias" as const, notifyCustomer: false };
    const before = await snapshotAliasBackfillState();
    await pool.query(`CREATE FUNCTION oms.reject_test_split_command() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected split command failure'; END $$;
      CREATE TRIGGER reject_test_split_command BEFORE INSERT ON oms.channel_fulfillment_push_items
      FOR EACH ROW EXECUTE FUNCTION oms.reject_test_split_command();`);
    try {
      await expect(fixture.repository.materializePhysicalPackage(input)).rejects.toThrow("Injected split command failure");
    } finally {
      await pool.query(`DROP TRIGGER reject_test_split_command ON oms.channel_fulfillment_push_items;
        DROP FUNCTION oms.reject_test_split_command();`);
    }
    expect(await snapshotAliasBackfillState()).toEqual(before);
    const first = await fixture.repository.materializePhysicalPackage(input);
    const replay = await fixture.repository.materializePhysicalPackage(input);
    expect(replay.channelCommands).toEqual(first.channelCommands.map(command => ({ ...command, replayed: true })));
    expect((await pool.query("SELECT id,quantity_requested FROM wms.shipment_request_items")).rows)
      .toEqual([{ id: fixture.request.id, quantity_requested: 4 }]);
  });

  it.each(["warehouse", "shipping_order", "quantity"])("rechecks changed %s allocation authority after preview", async change => {
    const fixture = await seedReservedSplitPackages(4);
    const input = { ...await fixture.repository.resolveLegacyPhysicalPackage(fixture.candidates[0].representativeShipmentId),
      source: "script:backfill-channel-fulfillment-authority", providerOrderIdentityPolicy: "stable_key_alias" as const, notifyCustomer: false };
    await fixture.repository.validatePhysicalPackageIdentity(input);
    if (change === "warehouse") {
      const warehouse = (await pool.query<{ id: number }>("INSERT INTO warehouse.warehouses (code,name) VALUES ('OTHER','Other warehouse') RETURNING id")).rows[0];
      await pool.query("UPDATE wms.shipment_requests SET warehouse_id=$2 WHERE id=$1", [fixture.request.shipment_request_id, warehouse.id]);
    } else if (change === "shipping_order") {
      await pool.query("DELETE FROM wms.shipping_engine_order_requests WHERE shipment_request_id=$1", [fixture.request.shipment_request_id]);
      await pool.query("UPDATE wms.shipping_engine_orders SET shipment_request_id=NULL WHERE shipment_request_id=$1", [fixture.request.shipment_request_id]);
    } else {
      await pool.query("UPDATE wms.shipment_request_items SET quantity_cancelled=3 WHERE id=$1", [fixture.request.id]);
    }
    const before = await snapshotAliasBackfillState();
    if (change === "quantity") {
      // The original request is fully consumed, but three explicitly cancelled
      // request units are unrequested again. Current paid/order authority still
      // applies, so a new, exact request is legitimate rather than forced reuse.
      const result = await fixture.repository.materializePhysicalPackage(input);
      expect(result.channelCommands).toHaveLength(1);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.shipment_request_items")).rows).toEqual([{ count: 2 }]);
    } else {
      await expect(fixture.repository.validatePhysicalPackageIdentity(input)).rejects.toMatchObject({ code: "FULFILLMENT_AUTHORITY_EXCEEDED" });
      await expect(fixture.repository.materializePhysicalPackage(input)).rejects.toMatchObject({ code: "FULFILLMENT_AUTHORITY_EXCEEDED" });
      expect(await snapshotAliasBackfillState()).toEqual(before);
    }
  });

  it("silently backfills the 44-package, 18-order, 19-line failure shape through real Shopify command execution", async () => {
    const warehouseId = (await pool.query<{ id: number }>(`INSERT INTO warehouse.warehouses (code,name,shopify_location_id)
      VALUES ('SPLIT-COHORT','Split cohort','640010') RETURNING id`)).rows[0].id;
    // Production-shaped counts, not production identifiers or SKU-specific logic.
    const quantities = [4, 2, 2, 2, 2, 2, 2, 2, 2, 2, 4, 2, 3, 20, 4, 2, 2, 3];
    const fixtures: Array<Awaited<ReturnType<typeof seedReservedSplitPackages>>> = [];
    for (const [index, quantity] of quantities.entries()) fixtures.push(await seedReservedSplitPackages(quantity, index, warehouseId));
    const mixed = fixtures[1];
    const extraLineId = "gid://shopify/LineItem/700199";
    const extraLine = (await pool.query<{ id: string }>(`INSERT INTO oms.oms_order_lines (
      order_id,external_line_item_id,fulfillment_provider,paid_quantity,authority_fulfillable_quantity)
      VALUES ($1,$2,'shopify',2,2) RETURNING id`, [mixed.source.oms_order_id, extraLineId])).rows[0];
    const extraItem = (await pool.query<{ id: number }>(`INSERT INTO wms.order_items
      (order_id,oms_order_line_id,sku,quantity,fulfilled_quantity) VALUES ($1,$2,'EXTRA-MIXED-LINE',2,2) RETURNING id`,
    [mixed.source.order_id, extraLine.id])).rows[0];
    const extraProduct = (await pool.query<{ id: number }>(`INSERT INTO catalog.products (sku,name)
      VALUES ('EXTRA-MIXED-LINE','Extra mixed line product') RETURNING id`)).rows[0];
    const extraVariant = (await pool.query<{ id: number }>(`INSERT INTO catalog.product_variants (product_id,sku,name)
      VALUES ($1,'EXTRA-MIXED-LINE','Extra mixed line variant') RETURNING id`, [extraProduct.id])).rows[0];
    await pool.query(`INSERT INTO wms.outbound_shipment_items (shipment_id,order_item_id,product_variant_id,qty)
      VALUES ($1,$2,$3,2)`, [mixed.candidates[0].representativeShipmentId, extraItem.id, extraVariant.id]);
    const candidates = fixtures.flatMap(fixture => fixture.candidates);
    expect(candidates).toHaveLength(44);
    const repository = fixtures[0].repository;
    const dependencies = { repository, loadCandidates: async () => candidates, log: vi.fn() };
    const before = await snapshotAliasBackfillState();
    const ledgerBefore = await loadLedgerCounts(pool);
    await expect(runBackfill(parseFlags(["--dry-run", "--silent"]), dependencies))
      .resolves.toMatchObject({ lineageValidated: 44, materialized: 0, reviewRequired: 0 });
    expect(await snapshotAliasBackfillState()).toEqual(before);
    const results = await Promise.all([0, 1].map(() => runBackfill(parseFlags(["--execute", "--silent"]), dependencies)));
    for (const result of results) expect(result, JSON.stringify(result.failures)).toMatchObject({ materialized: 44, reviewRequired: 0 });
    expect(results.reduce((total, result) => total + result.commandsCreated, 0)).toBe(44);
    expect(results.reduce((total, result) => total + result.commandsReplayed, 0)).toBe(44);
    expect((await pool.query("SELECT COUNT(*)::int AS count,SUM(quantity_requested)::int AS quantity FROM wms.shipment_request_items")).rows)
      .toEqual([{ count: 19, quantity: 64 }]);
    const commandRows = (await pool.query<{ id: string; next_attempt_at: Date; metadata: Record<string, unknown> }>(
      "SELECT id,next_attempt_at,metadata FROM oms.channel_fulfillment_pushes WHERE push_status='pending' ORDER BY id")).rows;
    expect(commandRows).toHaveLength(44);
    expect(commandRows.every(command => command.metadata.notifyCustomer === false)).toBe(true);
    const now = new Date(Math.max(...commandRows.map(command => command.next_attempt_at.getTime())) + 1000);
    const commands = await repository.claimCommands({ commandIds: commandRows.map(command => Number(command.id)),
      now, limit: 100, leaseDurationMs: 60000, leaseToken: "split-cohort" });
    expect(commands).toHaveLength(44);
    expect(commands.reduce((sum, command) => sum + command.items.reduce((n, item) => n + item.quantity, 0), 0)).toBe(46);

    const created: Array<{ orderId: string; tracking: string; items: Array<{ lineId: string; quantity: number }>; id: string }> = [];
    const clients = new Map(fixtures.map(fixture => {
      const lines = [{ id: fixture.externalLineId, quantity: fixture.orderedQuantity, alreadyShipped: 1 },
        ...(fixture === mixed ? [{ id: extraLineId, quantity: 2, alreadyShipped: 0 }] : [])];
      const client: ShopifyAdminGraphQLClient = { request: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => {
        const packages = created.filter(pkg => pkg.orderId === fixture.externalOrderId);
        if (query.includes("exactFulfillmentPackageForOrder")) return { order: {
          fulfillmentsCount: { count: packages.length + 1 }, fulfillments: [
            { id: `gid://shopify/Fulfillment/original-${fixture.sourceId}`, status: "SUCCESS",
              trackingInfo: [{ number: fixture.firstTracking }], fulfillmentLineItems: {
                nodes: [{ quantity: 1, lineItem: { id: fixture.externalLineId } }], pageInfo: { hasNextPage: false } } },
            ...packages.map(pkg => ({ id: pkg.id, status: "SUCCESS", trackingInfo: [{ number: pkg.tracking }],
              fulfillmentLineItems: { nodes: pkg.items.map(item => ({ quantity: item.quantity, lineItem: { id: item.lineId } })),
                pageInfo: { hasNextPage: false } } })),
          ],
        } } as T;
        if (query.includes("fulfillmentOrders(first:")) return { order: { fulfillmentOrders: { edges: [{ node: {
          id: `gid://shopify/FulfillmentOrder/${fixture.sourceId}`, status: "OPEN",
          assignedLocation: { location: { id: "gid://shopify/Location/640010" } },
          lineItems: { edges: lines.map(line => ({ node: {
            id: line.id.replace("/LineItem/", "/FulfillmentOrderLineItem/"), lineItem: { id: line.id },
            remainingQuantity: line.quantity - line.alreadyShipped - packages.flatMap(pkg => pkg.items)
              .filter(item => item.lineId === line.id).reduce((sum, item) => sum + item.quantity, 0),
          } })) },
        } }] } } } as T;
        if (query.includes("fulfillmentCreateV2")) {
          const fulfillment = variables?.fulfillment as { notifyCustomer: boolean; trackingInfo: { number: string };
            lineItemsByFulfillmentOrder: Array<{ fulfillmentOrderId: string; fulfillmentOrderLineItems: Array<{ id: string; quantity: number }> }> };
          expect(fulfillment.notifyCustomer).toBe(false);
          expect(fulfillment.lineItemsByFulfillmentOrder).toHaveLength(1);
          expect(fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderId).toBe(`gid://shopify/FulfillmentOrder/${fixture.sourceId}`);
          const items = fulfillment.lineItemsByFulfillmentOrder[0].fulfillmentOrderLineItems
            .map(item => ({ lineId: item.id.replace("/FulfillmentOrderLineItem/", "/LineItem/"), quantity: item.quantity }));
          const expected = commands.find(command => command.trackingNumber === fulfillment.trackingInfo.number);
          expect(expected).toBeDefined();
          expect(items).toEqual(expected!.items.map(item => ({ lineId: item.channelOrderLineId, quantity: item.quantity })));
          const id = `gid://shopify/Fulfillment/${990000 + created.length}`;
          created.push({ orderId: fixture.externalOrderId, tracking: fulfillment.trackingInfo.number, items, id });
          return { fulfillmentCreateV2: { fulfillment: { id }, userErrors: [] } } as T;
        }
        throw new Error(`Unexpected Shopify operation: ${query.slice(0, 100)}`);
      } };
      return [fixture.source.channel_id, { fixture, client }] as const;
    }));
    vi.stubEnv("SHOPIFY_FULFILLMENT_PUSH_ENABLED", "true");
    try {
      const executor = createCompatibilityChannelFulfillmentProviderExecutor(createFulfillmentPushService(getTestDb(), null, {
        providerClients: { shopify: async channelId => {
          const scoped = clients.get(channelId);
          if (!scoped) throw new Error(`Unexpected channel ${channelId}`);
          return { channelId, connectionId: channelId, externalAccountId: `fixture-${channelId}.myshopify.com`, client: scoped.client };
        }, ebay: async () => { throw new Error("Unexpected eBay connection"); } },
      }));
      for (const command of commands) {
        const result = await executor.execute(command);
        expect(result.outcome).toBe("success");
        await repository.completeAttempt({ commandId: command.id, leaseToken: command.leaseToken, startedAt: now, completedAt: now, ...result });
      }
      // A response lost after Shopify creation is recovered by exact tracking +
      // line quantities; even provider-boundary replay cannot send another email.
      await executor.execute(commands[0]);
      expect(created).toHaveLength(44);
    } finally { vi.unstubAllEnvs(); }
    expect((await pool.query("SELECT COUNT(*)::int AS count FROM oms.channel_fulfillment_push_attempts WHERE outcome='success'")).rows)
      .toEqual([{ count: 44 }]);
    const after = await snapshotAliasBackfillState();
    expect(after["wms.order_items"]).toEqual(before["wms.order_items"]);
    expect(after["inventory.inventory_transactions"]).toEqual(before["inventory.inventory_transactions"]);
    expect(await loadLedgerCounts(pool)).toEqual(ledgerBefore);
  }, 60_000);

  it("silently backfills a split provider-order alias with a read-only preview, concurrent replay and durable attempt audit", async () => {
    const { repository, firstInput, secondInput, split } = await seedHistoricalSplitBackfill(2, "99002");
    const first = await repository.materializePhysicalPackage(firstInput);
    // This is the deployed failure shape: the parent still has the original ID,
    // while the exact second package has a new ID under the same stable key.
    await expect(repository.validatePhysicalPackageIdentity(secondInput))
      .rejects.toMatchObject({ code: "PACKAGE_IDENTITY_CONFLICT", context: { field: "providerOrderId" } });
    const candidate: BackfillCandidate = { representativeShipmentId: split.id, shippingProvider: "shipstation",
      providerPhysicalShipmentId: secondInput.providerPhysicalShipmentId, legacyShipmentIds: [split.id],
      orderNumbers: ["PACKAGE-COMMERCIAL-640001"], trackingNumber: secondInput.trackingNumber!,
      missingPhysicalShipment: true, missingCommandItemCount: 1 };
    const dependencies = { repository, loadCandidates: async () => [candidate], log: vi.fn() };
    const before = await snapshotAliasBackfillState();
    await expect(runBackfill(parseFlags(["--dry-run", "--silent"]), dependencies))
      .resolves.toMatchObject({ lineageValidated: 1, materialized: 0, reviewRequired: 0 });
    expect(await snapshotAliasBackfillState()).toEqual(before);

    const results = await Promise.all([
      runBackfill(parseFlags(["--execute", "--silent"]), dependencies),
      runBackfill(parseFlags(["--execute", "--silent"]), dependencies),
    ]);
    expect(results.map(r => r.reviewRequired)).toEqual([0, 0]);
    expect(results.map(r => r.commandsCreated).sort()).toEqual([0, 1]);
    expect(results.map(r => r.commandsReplayed).sort()).toEqual([0, 1]);
    expect((await pool.query("SELECT id,provider_order_id,provider_order_key FROM wms.shipping_engine_orders")).rows)
      .toEqual([{ id: String(first.shippingEngineOrderId), provider_order_id: "99001", provider_order_key: "provider-order-key-99001" }]);
    const aliases = (await pool.query("SELECT provider_order_id,metadata FROM wms.shipping_engine_order_provider_refs ORDER BY provider_order_id")).rows;
    expect(aliases).toHaveLength(2);
    expect(aliases[1]).toMatchObject({ provider_order_id: "99002", metadata: {
      resolution: "stable_key_alias", inputSource: "script:backfill-channel-fulfillment-authority" } });
    const command = (await pool.query(`SELECT push.id,push.metadata,push.request_hash,push.next_attempt_at,item.quantity_pushed
      FROM oms.channel_fulfillment_pushes push JOIN wms.physical_shipments physical ON physical.id=push.physical_shipment_id
      JOIN oms.channel_fulfillment_push_items item ON item.channel_fulfillment_push_id=push.id
      WHERE physical.provider_physical_shipment_id='44011'`)).rows[0];
    expect(command).toMatchObject({ quantity_pushed: 1, metadata: { notifyCustomer: false } });
    const pushShopifyFulfillmentForCommand = vi.fn(async () => ({
      writebackComplete: true, shopifyFulfillmentId: "gid://shopify/Fulfillment/640004", alreadySatisfied: false,
    }));
    const service = createChannelFulfillmentAuthorityService({ repository,
      projector: { projectPhysicalShipment: vi.fn() },
      providerExecutor: createCompatibilityChannelFulfillmentProviderExecutor({ pushShopifyFulfillmentForCommand }),
      clock: { now: () => new Date(command.next_attempt_at.getTime() + 1_000) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await expect(service.runDueBatch({ commandIds: [Number(command.id)] })).resolves.toMatchObject({ succeeded: 1 });
    expect(pushShopifyFulfillmentForCommand).toHaveBeenCalledWith(expect.objectContaining({ notifyCustomer: false,
      items: [expect.objectContaining({ quantity: 1 })] }));
    expect((await pool.query("SELECT outcome,metadata FROM oms.channel_fulfillment_push_attempts WHERE channel_fulfillment_push_id=$1", [command.id])).rows)
      .toEqual([expect.objectContaining({ outcome: "success", metadata: expect.objectContaining({ notifyCustomer: false }) })]);
    await expect(runBackfill(parseFlags(["--execute", "--silent"]), dependencies))
      .resolves.toMatchObject({ commandsCreated: 0, commandsReplayed: 1, reviewRequired: 0 });
    expect((await pool.query("SELECT metadata,request_hash FROM oms.channel_fulfillment_pushes WHERE id=$1", [command.id])).rows[0])
      .toEqual({ metadata: command.metadata, request_hash: command.request_hash });
    const after = await snapshotAliasBackfillState();
    expect(after["wms.order_items"]).toEqual(before["wms.order_items"]);
    expect(after["inventory.inventory_transactions"]).toEqual(before["inventory.inventory_transactions"]);
  });

  it.each([
    { field: "trackingNumber", value: "OTHER-TRACKING" },
    { field: "carrier", value: "FEDEX" },
    { field: "providerPhysicalShipmentId", value: "OTHER-PACKAGE" },
    { field: "providerOrderId", value: "WRONG-HEADER-ORDER" },
    { field: "providerOrderKey", value: "WRONG-HEADER-KEY" },
  ] as const)("keeps exact package $field checks strict when parent aliases are allowed", async ({ field, value }) => {
    const { repository, firstInput, secondInput } = await seedHistoricalSplitBackfill(2, "99002");
    await repository.materializePhysicalPackage(firstInput);
    const input = { ...secondInput, providerOrderIdentityPolicy: "stable_key_alias" as const, [field]: value };
    const before = await snapshotAliasBackfillState();
    await expect(repository.validatePhysicalPackageIdentity(input)).rejects.toMatchObject({ code: "PACKAGE_IDENTITY_CONFLICT" });
    await expect(repository.materializePhysicalPackage(input)).rejects.toMatchObject({ code: "PACKAGE_IDENTITY_CONFLICT" });
    expect(await snapshotAliasBackfillState()).toEqual(before);
  });

  it("rechecks package identity at write time after a successful alias preview", async () => {
    const { repository, firstInput, secondInput, split } = await seedHistoricalSplitBackfill(2, "99002");
    await repository.materializePhysicalPackage(firstInput);
    const input = { ...secondInput, providerOrderIdentityPolicy: "stable_key_alias" as const };
    await repository.validatePhysicalPackageIdentity(input);
    await pool.query("UPDATE wms.outbound_shipments SET tracking_number='CHANGED-AFTER-PREVIEW' WHERE id=$1", [split.id]);
    const before = await snapshotAliasBackfillState();
    await expect(repository.materializePhysicalPackage(input)).rejects.toMatchObject({ code: "PACKAGE_IDENTITY_CONFLICT" });
    expect(await snapshotAliasBackfillState()).toEqual(before);
  });

  it("rejects a provider order id that also resolves to another canonical parent without inserting an alias", async () => {
    const { repository, firstInput, secondInput } = await seedHistoricalSplitBackfill(2, "99002");
    await repository.materializePhysicalPackage(firstInput);
    await pool.query(`INSERT INTO wms.shipping_engine_orders
      (provider,provider_order_id,provider_order_key,command_key,provider_status)
      VALUES ('shipstation','99002','different-key','shipping-order:v1:shipstation:id:99002','shipped')`);
    const input = { ...secondInput, providerOrderIdentityPolicy: "stable_key_alias" as const };
    const before = await snapshotAliasBackfillState();
    await expect(repository.validatePhysicalPackageIdentity(input)).rejects.toMatchObject({ code: "CANONICAL_STATE_CONFLICT" });
    await expect(repository.materializePhysicalPackage(input)).rejects.toMatchObject({ code: "CANONICAL_STATE_CONFLICT" });
    expect(await snapshotAliasBackfillState()).toEqual(before);
  });

  it.each([false, true])("persists notifyCustomer=%s across concurrent replay, lease retry and worker restart", async notifyCustomer => {
    const { repository, firstInput } = await seedHistoricalSplitBackfill();
    const input = { ...firstInput, notifyCustomer };
    const inventoryBefore = (await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows;
    const wmsBefore = (await pool.query("SELECT * FROM wms.order_items ORDER BY id")).rows;
    const results = await Promise.all([
      repository.materializePhysicalPackage(input), repository.materializePhysicalPackage(input),
    ]);
    expect(results.map(result => result.channelCommands[0].replayed).sort()).toEqual([false, true]);
    const commandId = results[0].channelCommands[0].id;
    const persisted = (await pool.query<{ metadata: Record<string, unknown>; request_hash: string; next_attempt_at: Date }>(
      "SELECT metadata, request_hash, next_attempt_at FROM oms.channel_fulfillment_pushes WHERE id=$1", [commandId],
    )).rows[0];
    expect(persisted.metadata).toMatchObject({ notifyCustomer, source: "historical-backfill-test" });
    // Ordinary webhook/sweeper replay must not turn a prior silent request into an email.
    await expect(repository.materializePhysicalPackage(firstInput)).resolves.toMatchObject({
      channelCommands: [{ id: commandId, replayed: true }],
    });
    await expect(repository.materializePhysicalPackage({ ...input, notifyCustomer: !notifyCustomer }))
      .rejects.toMatchObject({ code: "COMMAND_REQUEST_CONFLICT", context: { reason: "immutable_customer_notification_changed" } });
    const claimAt = new Date(persisted.next_attempt_at.getTime() + 1000);
    const [firstClaim] = await repository.claimCommands({ commandIds: [commandId], limit: 1,
      now: claimAt, leaseDurationMs: 60000, leaseToken: "notification-first" });
    expect(firstClaim.metadata.notifyCustomer).toBe(notifyCustomer);
    const retryAt = new Date(claimAt.getTime() + 1000);
    await repository.completeAttempt({ commandId, leaseToken: firstClaim.leaseToken,
      outcome: "retry_scheduled", startedAt: claimAt, completedAt: claimAt,
      nextAttemptAt: retryAt, errorCode: "SIMULATED_PROVIDER_TIMEOUT" });
    const restartedRepository = createChannelFulfillmentAuthorityRepository(getTestDb());
    const [retry] = await restartedRepository.claimCommands({ commandIds: [commandId], limit: 1,
      now: retryAt, leaseDurationMs: 60000, leaseToken: "notification-retry" });
    expect(retry).toMatchObject({ attemptNumber: 2, requestHash: persisted.request_hash, metadata: { notifyCustomer } });
    const pushShopifyFulfillmentForCommand = vi.fn().mockResolvedValue({
      writebackComplete: true, shopifyFulfillmentId: "gid://shopify/Fulfillment/650001",
    });
    const execution = await createCompatibilityChannelFulfillmentProviderExecutor({ pushShopifyFulfillmentForCommand }).execute(retry);
    expect(pushShopifyFulfillmentForCommand).toHaveBeenCalledWith(expect.objectContaining({ notifyCustomer }));
    await restartedRepository.completeAttempt({ commandId, leaseToken: retry.leaseToken,
      startedAt: retryAt, completedAt: retryAt, ...execution });
    expect((await pool.query(`SELECT attempt_number, outcome, metadata FROM oms.channel_fulfillment_push_attempts
      WHERE channel_fulfillment_push_id=$1 ORDER BY attempt_number`, [commandId])).rows).toEqual([
      expect.objectContaining({ attempt_number: 1, outcome: "retry_scheduled" }),
      expect.objectContaining({ attempt_number: 2, outcome: "success", metadata: expect.objectContaining({ notifyCustomer }) }),
    ]);
    expect((await pool.query("SELECT metadata, request_hash FROM oms.channel_fulfillment_pushes WHERE id=$1", [commandId])).rows)
      .toEqual([{ metadata: persisted.metadata, request_hash: persisted.request_hash }]);
    expect((await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows).toEqual(inventoryBefore);
    expect((await pool.query("SELECT * FROM wms.order_items ORDER BY id")).rows).toEqual(wmsBefore);
  });

  it.each(Object.values(CHANNEL_FULFILLMENT_REPAIR_SOURCES))(
    "silences the real %s handoff across concurrent materialization and a worker restart",
    async (source) => {
      const { repository, firstInput } = await seedHistoricalSplitBackfill();
      const inventoryBefore = (await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows;
      const wmsBefore = (await pool.query("SELECT * FROM wms.order_items ORDER BY id")).rows;
      let workerNow = new Date("2026-09-15T12:00:00Z");
      const pushShopifyFulfillmentForCommand = vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("Simulated provider timeout"), { code: "PROVIDER_TIMEOUT" }))
        .mockResolvedValue({ writebackComplete: true, shopifyFulfillmentId: "gid://shopify/Fulfillment/650002" });
      const makeService = () => createChannelFulfillmentAuthorityService({
        repository: createChannelFulfillmentAuthorityRepository(getTestDb()),
        projector: { projectPhysicalShipment: vi.fn() },
        providerExecutor: createCompatibilityChannelFulfillmentProviderExecutor({ pushShopifyFulfillmentForCommand }),
        clock: { now: () => workerNow },
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const service = makeService();
      const results = await Promise.all([0, 1].map(() => service.ensureLegacyShipment(
        firstInput.legacyWmsShipmentIds[0], { source, executeImmediately: false },
      )));
      expect(results.map(result => result.materialized.channelCommands[0].replayed).sort()).toEqual([false, true]);
      const commandId = results[0].materialized.channelCommands[0].id;
      const readCommand = async () => (await pool.query<{
        metadata: Record<string, unknown>; request_hash: string; next_attempt_at: Date; push_status: string;
      }>("SELECT metadata, request_hash, next_attempt_at, push_status FROM oms.channel_fulfillment_pushes WHERE id=$1", [commandId])).rows[0];
      const before = await readCommand();
      expect(before.metadata).toMatchObject({ source, notifyCustomer: false });
      await expect(repository.materializePhysicalPackage(firstInput)).resolves.toMatchObject({
        channelCommands: [{ id: commandId, replayed: true }],
      });
      workerNow = new Date(before.next_attempt_at.getTime() + 1000);
      await expect(service.runDueBatch({ commandIds: [commandId] })).resolves.toMatchObject({ retryScheduled: 1, succeeded: 0 });
      workerNow = new Date((await readCommand()).next_attempt_at.getTime() + 1000);
      await expect(makeService().runDueBatch({ commandIds: [commandId] })).resolves.toMatchObject({ succeeded: 1, reviewRequired: 0 });
      expect(pushShopifyFulfillmentForCommand).toHaveBeenCalledTimes(2);
      for (const [input] of pushShopifyFulfillmentForCommand.mock.calls) expect(input.notifyCustomer).toBe(false);
      expect(await readCommand()).toMatchObject({ metadata: before.metadata, request_hash: before.request_hash, push_status: "success" });
      expect((await pool.query("SELECT outcome, metadata FROM oms.channel_fulfillment_push_attempts WHERE channel_fulfillment_push_id=$1 ORDER BY attempt_number", [commandId])).rows).toEqual([
        expect.objectContaining({ outcome: "retry_scheduled" }),
        expect.objectContaining({ outcome: "success", metadata: expect.objectContaining({ notifyCustomer: false }) }),
      ]);
      expect((await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows).toEqual(inventoryBefore);
      expect((await pool.query("SELECT * FROM wms.order_items ORDER BY id")).rows).toEqual(wmsBefore);
    },
  );

  it("preserves a normal notifying shipment command when the sweeper observes it", async () => {
    const { repository, firstInput } = await seedHistoricalSplitBackfill();
    const result = await repository.materializePhysicalPackage({ ...firstInput, source: "live_shipping_event", notifyCustomer: true });
    const commandId = result.channelCommands[0].id;
    const before = (await pool.query("SELECT metadata, request_hash, next_attempt_at FROM oms.channel_fulfillment_pushes WHERE id=$1", [commandId])).rows[0];
    await expect(repository.materializePhysicalPackage({ ...firstInput, source: CHANNEL_FULFILLMENT_REPAIR_SOURCES.outboundSweep }))
      .resolves.toMatchObject({ channelCommands: [{ id: commandId, replayed: true }] });
    const [claim] = await repository.claimCommands({ commandIds: [commandId], limit: 1,
      now: new Date(before.next_attempt_at.getTime() + 1000), leaseDurationMs: 60000, leaseToken: "live-replay" });
    const pushShopifyFulfillmentForCommand = vi.fn().mockResolvedValue({ writebackComplete: true });
    await createCompatibilityChannelFulfillmentProviderExecutor({ pushShopifyFulfillmentForCommand }).execute(claim);
    expect(pushShopifyFulfillmentForCommand).toHaveBeenCalledWith(expect.objectContaining({ notifyCustomer: true }));
    expect(claim).toMatchObject({ metadata: before.metadata, requestHash: before.request_hash });
  });

  it.each([true, undefined])("holds pre-deployment repair metadata notifyCustomer=%s without a provider call or rewrite", async notifyCustomer => {
    const { repository, firstInput } = await seedHistoricalSplitBackfill();
    const result = await repository.materializePhysicalPackage({ ...firstInput, suppressChannelWriteback: true });
    const items = (await pool.query(`SELECT physical.id::int AS "physicalShipmentItemId",
      physical.shipment_request_item_id::int AS "shipmentRequestItemId", line.order_id::int AS "omsOrderId",
      line.id::int AS "omsOrderLineId", line.external_line_item_id AS "channelOrderLineId",
      'shopify' AS "channelProvider", 'order' AS "channelFulfillmentScopeKey", physical.quantity_shipped AS "quantityShipped"
      FROM wms.physical_shipment_items physical JOIN wms.fulfillment_plan_lines plan_line ON plan_line.id=physical.fulfillment_plan_line_id
      JOIN oms.oms_order_lines line ON line.id=plan_line.oms_order_line_id WHERE physical.physical_shipment_id=$1`, [result.physicalShipmentId])).rows;
    // Build the original notifying payload without the new repair-source policy,
    // then INSERT that pre-deployment shape. Keep all immutability triggers on.
    const [legacy] = planChannelFulfillmentCommands({ physicalShipmentId: result.physicalShipmentId,
      shippingProvider: firstInput.shippingProvider, providerPhysicalShipmentId: firstInput.providerPhysicalShipmentId,
      trackingNumber: firstInput.trackingNumber!, carrier: firstInput.carrier!, trackingUrl: firstInput.trackingUrl,
      shippedAt: firstInput.shippedAt?.toISOString() ?? null, items });
    expect(legacy.items).toHaveLength(1);
    const [item] = legacy.items;
    const commandId = (await pool.query<{ id: number }>(`WITH command AS (
      INSERT INTO oms.channel_fulfillment_pushes (oms_order_id, physical_shipment_id, channel_provider,
        channel_fulfillment_scope_key, command_key, request_hash, tracking_number, carrier, tracking_url,
        shipped_at, push_status, attempt_count, max_attempts, next_attempt_at, metadata)
      VALUES ($1,$2,'shopify','order',$3,$4,$5,$6,$7,$8,'retry',0,12,NOW(),$9::jsonb) RETURNING id
    ), item AS (
      INSERT INTO oms.channel_fulfillment_push_items (channel_fulfillment_push_id, physical_shipment_item_id,
        oms_order_line_id, channel_order_line_id, quantity_pushed, metadata)
      SELECT command.id,$10,$11,$12,$13,$14::jsonb FROM command RETURNING channel_fulfillment_push_id
    ) SELECT channel_fulfillment_push_id::int AS id FROM item`, [legacy.omsOrderId, legacy.physicalShipmentId,
      legacy.commandKey, legacy.requestHash, legacy.trackingNumber, legacy.carrier, legacy.trackingUrl, legacy.shippedAt,
      JSON.stringify({ contractVersion: 1, source: CHANNEL_FULFILLMENT_REPAIR_SOURCES.outboundSweep, notifyCustomer,
        legacyWmsShipmentIds: firstInput.legacyWmsShipmentIds, shippingProvider: firstInput.shippingProvider,
        providerPhysicalShipmentId: firstInput.providerPhysicalShipmentId }),
      item.physicalShipmentItemId, item.omsOrderLineId, item.channelOrderLineId, item.quantity,
      JSON.stringify({ contractVersion: 1, shipmentRequestItemId: item.shipmentRequestItemId }),
    ])).rows[0].id;
    const before = (await pool.query("SELECT metadata, request_hash, next_attempt_at FROM oms.channel_fulfillment_pushes WHERE id=$1", [commandId])).rows[0];
    const pushShopifyFulfillmentForCommand = vi.fn();
    const service = createChannelFulfillmentAuthorityService({ repository,
      projector: { projectPhysicalShipment: vi.fn() },
      providerExecutor: createCompatibilityChannelFulfillmentProviderExecutor({ pushShopifyFulfillmentForCommand }),
      clock: { now: () => new Date(before.next_attempt_at.getTime() + 1000) },
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    await expect(service.runDueBatch({ commandIds: [commandId] })).resolves.toMatchObject({ reviewRequired: 1, succeeded: 0 });
    expect(pushShopifyFulfillmentForCommand).not.toHaveBeenCalled();
    expect((await pool.query("SELECT metadata, request_hash, push_status, last_error_code FROM oms.channel_fulfillment_pushes WHERE id=$1", [commandId])).rows[0])
      .toMatchObject({ metadata: before.metadata, request_hash: before.request_hash, push_status: "review", last_error_code: "SILENT_REPAIR_NOTIFICATION_REVIEW_REQUIRED" });
    expect((await pool.query("SELECT outcome, error_code FROM oms.channel_fulfillment_push_attempts WHERE channel_fulfillment_push_id=$1", [commandId])).rows)
      .toEqual([{ outcome: "review_required", error_code: "SILENT_REPAIR_NOTIFICATION_REVIEW_REQUIRED" }]);
  });

  it.each([2, 4])("backfills a second case after Shopify records the first, preserving %i ordered units and replay safety", async (orderedQuantity) => {
    const { source, split, repository, firstInput, secondInput } = await seedHistoricalSplitBackfill(orderedQuantity);
    const first = await repository.materializePhysicalPackage(firstInput);
    expect(first.channelCommands).toHaveLength(1);
    const claimTime = (await pool.query<{ next_attempt_at: Date }>(
      "SELECT next_attempt_at FROM oms.channel_fulfillment_pushes WHERE id = $1",
      [first.channelCommands[0].id],
    )).rows[0].next_attempt_at;
    const claimed = await repository.claimCommands({
      // pg timestamps retain microseconds whereas JavaScript Dates do not.
      commandIds: [first.channelCommands[0].id], limit: 1, now: new Date(claimTime.getTime() + 1_000),
      leaseDurationMs: 60_000, leaseToken: "backfill-first-package",
    });
    expect(claimed).toHaveLength(1);
    await repository.completeAttempt({
      commandId: first.channelCommands[0].id, leaseToken: "backfill-first-package",
      outcome: "success", providerResponseId: "gid://shopify/Fulfillment/640003",
      startedAt: claimTime, completedAt: claimTime,
    });
    await pool.query("UPDATE oms.oms_order_lines SET authority_fulfillable_quantity = $1 WHERE id = $2",
      [orderedQuantity - 1, source.oms_order_line_id]);
    // Reproduce the previous defect's derived cancellation and review without
    // changing the original paid/cancellation/refund facts.
    await pool.query("UPDATE wms.fulfillment_plan_lines SET quantity_cancelled = 1");
    await pool.query(`UPDATE wms.outbound_shipments SET requires_review = true,
      review_reason = 'physical_shipment_exceeds_current_line_authority' WHERE id = $1`, [split.id]);
    const inventoryBefore = (await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows;
    const wmsBefore = (await pool.query("SELECT * FROM wms.order_items ORDER BY id")).rows;
    const results = await Promise.all([
      repository.materializePhysicalPackage(secondInput),
      repository.materializePhysicalPackage(secondInput),
    ]);
    expect(results.map((result) => result.channelCommands.length)).toEqual([1, 1]);
    expect(results.map((result) => result.channelCommands[0].replayed).sort()).toEqual([false, true]);
    expect((await pool.query(`SELECT quantity_planned, quantity_cancelled, quantity_shipped, authority_snapshot
      FROM wms.fulfillment_plan_lines`)).rows).toEqual([expect.objectContaining({
      quantity_planned: orderedQuantity, quantity_cancelled: 0, quantity_shipped: 2,
      authority_snapshot: expect.objectContaining({ contractVersion: 2, quantityAuthority: expect.objectContaining({
        paidQuantity: orderedQuantity, channelRemainingQuantity: orderedQuantity - 1,
        commercialAuthorizedQuantity: orderedQuantity,
      }) }),
    })]);
    expect((await pool.query(`SELECT physical.provider_physical_shipment_id, item.quantity_pushed
      FROM oms.channel_fulfillment_push_items item
      JOIN wms.physical_shipment_items physical_item ON physical_item.id = item.physical_shipment_item_id
      JOIN wms.physical_shipments physical ON physical.id = physical_item.physical_shipment_id
      ORDER BY physical.provider_physical_shipment_id`)).rows).toEqual([
      { provider_physical_shipment_id: "44010", quantity_pushed: 1 },
      { provider_physical_shipment_id: "44011", quantity_pushed: 1 },
    ]);
    expect((await pool.query("SELECT * FROM inventory.inventory_transactions ORDER BY id")).rows).toEqual(inventoryBefore);
    expect((await pool.query("SELECT * FROM wms.order_items ORDER BY id")).rows).toEqual(wmsBefore);
    expect((await pool.query("SELECT requires_review, review_reason FROM wms.outbound_shipments WHERE id = $1", [split.id])).rows)
      .toEqual([{ requires_review: true, review_reason: "physical_shipment_exceeds_current_line_authority" }]);
  });

  it.each(["cancel", "refund", "cancel_refund"] as const)("keeps historical backfill blocked by a real %s disposition", async (kind) => {
    const { source, repository, firstInput, secondInput } = await seedHistoricalSplitBackfill();
    await repository.materializePhysicalPackage(firstInput);
    await pool.query(`UPDATE oms.oms_order_lines SET authority_fulfillable_quantity = 1,
      cancelled_quantity = $1, refunded_quantity = $2 WHERE id = $3`,
    [kind === "refund" ? 0 : 1, kind === "cancel" ? 0 : 1, source.oms_order_line_id]);
    if (kind !== "cancel") {
      await pool.query(`INSERT INTO oms.order_line_adjustments (order_id, order_line_id, adjustment_type, restock_policy, quantity)
        SELECT order_id, id, 'refund', $1, 1 FROM oms.oms_order_lines WHERE id = $2`,
      [kind === "cancel_refund" ? "cancel" : "no_restock", source.oms_order_line_id]);
    }
    const result = await repository.materializePhysicalPackage(secondInput);
    expect(result.channelCommands).toEqual([]);
    expect((await pool.query("SELECT quantity_cancelled, quantity_shipped FROM wms.fulfillment_plan_lines")).rows)
      .toEqual([{ quantity_cancelled: 1, quantity_shipped: 2 }]);
    expect((await pool.query("SELECT id FROM oms.channel_fulfillment_pushes")).rows).toHaveLength(1);
  });

  it("rolls back a backfill with incomplete refund evidence", async () => {
    const { source, repository, firstInput } = await seedHistoricalSplitBackfill();
    await pool.query("UPDATE oms.oms_order_lines SET refunded_quantity = 1 WHERE id = $1", [source.oms_order_line_id]);
    await expect(repository.materializePhysicalPackage(firstInput)).rejects.toMatchObject({
      code: "CANONICAL_STATE_CONFLICT",
      context: { quantityAuthorityError: "INVALID_CHANNEL_FULFILLMENT_QUANTITY_AUTHORITY" },
    });
    expect((await pool.query("SELECT id FROM wms.physical_shipments")).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM wms.fulfillment_plans")).rows).toEqual([]);
    expect((await pool.query("SELECT id FROM oms.channel_fulfillment_pushes")).rows).toEqual([]);
  });

  it("materializes a normal two-package split as two fulfillments without a second inventory intent", async () => {
    const sourceId = await seedCommercialFulfillmentAuthoritySource(
      pool,
      "SKU-NORMAL-PACKAGE-SPLIT",
      2,
    );
    const source = await pool.query<{
      shipment_id: number;
      order_id: number;
      order_item_id: number;
      product_variant_id: number;
    }>(
      `SELECT item.shipment_id, shipment.order_id, item.order_item_id,
         item.product_variant_id
       FROM wms.outbound_shipment_items AS item
       JOIN wms.outbound_shipments AS shipment
         ON shipment.id = item.shipment_id
       WHERE item.id = $1::integer`,
      [sourceId],
    );
    expect(source.rows).toHaveLength(1);

    await pool.query(
      `UPDATE wms.outbound_shipment_items
       SET qty = 1
       WHERE id = $1::integer`,
      [sourceId],
    );
    const splitShipment = await pool.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipments (
         order_id, status, shipment_purpose, source, shipping_engine,
         external_fulfillment_id, tracking_number, carrier
       ) VALUES (
         $1::integer, 'shipped', 'customer_fulfillment', 'shipstation_split',
         'shipstation', 'shipstation_shipment:44011',
         '1Z0000000000044011', 'ups'
       )
       RETURNING id`,
      [source.rows[0].order_id],
    );
    const splitItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.outbound_shipment_items (
         shipment_id, order_item_id, split_root_shipment_item_id,
         shipment_item_purpose, product_variant_id, qty, tracking_id,
         provider_membership_state
       ) VALUES (
         $1::integer, $2::integer, $3::integer,
         'customer_fulfillment', $4::integer, 1, '44011', 'authoritative'
       )
       RETURNING id`,
      [
        splitShipment.rows[0].id,
        source.rows[0].order_item_id,
        sourceId,
        source.rows[0].product_variant_id,
      ],
    );

    const firstLabelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerLabelId: "44010",
      providerOrderId: "99001",
      trackingNumber: "1Z0000000000044010",
      contentsLines: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 1 }],
      receivedAt: "2026-08-22T14:00:00.000Z",
    });
    const splitLabelId = await seedAuthorityReadinessLabel(pool, sourceId, {
      providerLabelId: "44011",
      providerOrderId: "99001",
      trackingNumber: "1Z0000000000044011",
      contentsLines: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 1 }],
      receivedAt: "2026-08-22T14:01:00.000Z",
    });
    await pool.query(
      `UPDATE wms.shipping_provider_labels
       SET carrier = 'ups', service_code = 'ups_ground'
       WHERE id = ANY($1::bigint[])`,
      [[firstLabelId, splitLabelId]],
    );
    await pool.query(
      `INSERT INTO wms.shipping_provider_label_links (
         shipping_provider_label_id, legacy_wms_shipment_id, source
       ) VALUES ($1::bigint, $2::integer, 'legacy_provider_physical_identity')`,
      [splitLabelId, splitShipment.rows[0].id],
    );
    await pool.query(
      `INSERT INTO wms.physical_shipments (
         provider, provider_physical_shipment_id, tracking_number, carrier, status
       ) VALUES
         ('shipstation', '44010', '1Z0000000000044010', 'UPS', 'shipped'),
         ('shipstation', '44011', '1Z0000000000044011', 'UPS', 'shipped')`,
    );

    const repository = new PgPackageAllocationLedgerRepository(pool);
    const preview = await new PackageAllocationAuthorityResolutionPreviewService(
      repository,
    ).preview({
      contractVersion: 1,
      authorityMode: "shadow_only",
      previewMode: "bootstrap_selected_scope",
      groupKey: "b6e1be0d-c7d8-4c91-919f-04f5eb547f82",
      sourceWmsShipmentItemIds: [sourceId],
      shippingProviderLabelIds: [splitLabelId, firstLabelId],
    });
    expect(preview.resolution).not.toBeNull();
    expect(preview.resolution?.plannerInput.sourceLines).toEqual([
      expect.objectContaining({
        wmsShipmentItemId: sourceId,
        sourceQuantity: 2,
      }),
    ]);
    expect(preview.resolution?.plannerInput.packages.find(
      (pkg) => pkg.packageKey === packageAllocationPackageKey("shipstation", "44011"),
    )).toMatchObject({
      allocationRole: "additional_dispatch",
      membership: { status: "proven" },
      splitContinuation: {
        legacyWmsShipmentId: splitShipment.rows[0].id,
        lines: [{
          sourceWmsShipmentItemId: sourceId,
          splitWmsShipmentItemId: splitItem.rows[0].id,
          quantity: 1,
        }],
      },
    });
    expect(preview.resolution?.plannerResult.state.reviews).toEqual([]);

    const planning = new PackageAllocationPlanningService(repository);
    const persisted = await planning.persist({
      contractVersion: 1,
      authorityMode: "shadow_only",
      groupKey: "b6e1be0d-c7d8-4c91-919f-04f5eb547f82",
      expectedGroupVersion: 0,
      sourceLines: [{
        wmsShipmentItemId: sourceId,
        sourceQuantity: 2,
        physicalConsumptionAuthorityQuantity: 2,
        authorityVersion: 1,
      }],
      packages: [
        {
          packageKey: "A",
          allocationRole: "primary",
          membership: { status: "proven", evidenceKey: "membership:A" },
          lifecycle: {
            provider: "shipstation",
            providerPhysicalShipmentId: "44010",
            events: [{
              kind: "outbound_label_observed",
              eventKey: "shipstation:44010:observed",
              observedAt: "2026-08-22T14:00:00.000Z",
              providerOccurredAt: "2026-08-22T13:59:50.000Z",
              trackingNumber: "1Z0000000000044010",
              contentsEvidence: {
                status: "authoritative",
                lines: [{ wmsShipmentItemId: sourceId, quantity: 1 }],
              },
            }],
          },
        },
        {
          packageKey: "B",
          allocationRole: "additional_dispatch",
          membership: { status: "proven", evidenceKey: "membership:B" },
          splitContinuation: {
            evidenceKey:
              `shipstation-split-continuation:v1:44011:${splitShipment.rows[0].id}`,
            legacyWmsShipmentId: splitShipment.rows[0].id,
            lines: [{
              sourceWmsShipmentItemId: sourceId,
              splitWmsShipmentItemId: splitItem.rows[0].id,
              quantity: 1,
            }],
          },
          lifecycle: {
            provider: "shipstation",
            providerPhysicalShipmentId: "44011",
            events: [{
              kind: "outbound_label_observed",
              eventKey: "shipstation:44011:observed",
              observedAt: "2026-08-22T14:01:00.000Z",
              providerOccurredAt: "2026-08-22T14:00:50.000Z",
              trackingNumber: "1Z0000000000044011",
              contentsEvidence: {
                status: "authoritative",
                lines: [{ wmsShipmentItemId: sourceId, quantity: 1 }],
              },
            }],
          },
        },
      ],
      actions: [],
      writeContext: {
        createdBy: "normal-split-integration",
        reason: "Prove two normal packages fulfill one ordered line exactly once each",
      },
    });
    expect(persisted.planId).not.toBeNull();

    const sourceEffects = await pool.query<{
      effect_type: string;
      package_key: string | null;
      quantity: number;
    }>(
      `SELECT intent.effect_type, binding.package_key, intent.quantity
       FROM wms.package_allocation_effect_intents AS intent
       LEFT JOIN wms.package_allocation_package_bindings AS binding
         ON binding.id = intent.package_allocation_package_binding_id
       WHERE intent.package_allocation_plan_id = $1::bigint
         AND intent.package_allocation_source_line_id IS NOT NULL
       ORDER BY intent.effect_type, binding.package_key NULLS FIRST`,
      [persisted.planId],
    );
    expect(sourceEffects.rows).toEqual([
      { effect_type: "commercial_fulfillment", package_key: null, quantity: 1 },
      { effect_type: "commercial_fulfillment", package_key: "B", quantity: 1 },
      { effect_type: "inventory_consumption", package_key: null, quantity: 1 },
    ]);

    const fulfillment = createChannelFulfillmentAuthorityRepository(getTestDb());
    // The first package's Shopify update must not revoke cumulative authority
    // for the second exact package in the label-time path either.
    await pool.query("UPDATE oms.oms_order_lines SET authority_fulfillable_quantity = 1");
    const materialized = await fulfillment.materializePackageAllocationCommercialFulfillment({
      packageAllocationPlanId: persisted.planId!,
      source: "normal-split-integration",
    });
    expect(materialized).toMatchObject({
      customerFulfillmentItemCount: 2,
      replayed: false,
    });
    expect(materialized.channelCommands).toHaveLength(2);

    const pushed = await pool.query<{
      provider_physical_shipment_id: string;
      quantity_pushed: number;
      package_allocation_effect_intent_id: string;
    }>(
      `SELECT physical.provider_physical_shipment_id,
         push_item.quantity_pushed,
         push_item.package_allocation_effect_intent_id::text
       FROM oms.channel_fulfillment_push_items AS push_item
       JOIN wms.physical_shipment_items AS item
         ON item.id = push_item.physical_shipment_item_id
       JOIN wms.physical_shipments AS physical
         ON physical.id = item.physical_shipment_id
       ORDER BY physical.provider_physical_shipment_id`,
    );
    expect(pushed.rows.map((row) => ({
      providerPhysicalShipmentId: row.provider_physical_shipment_id,
      quantityPushed: row.quantity_pushed,
    }))).toEqual([
      { providerPhysicalShipmentId: "44010", quantityPushed: 1 },
      { providerPhysicalShipmentId: "44011", quantityPushed: 1 },
    ]);
    expect(new Set(
      pushed.rows.map((row) => row.package_allocation_effect_intent_id),
    ).size).toBe(2);
    await expect(pool.query(
      "SELECT id FROM inventory.inventory_transactions",
    )).resolves.toMatchObject({ rowCount: 0 });

    await expect(
      fulfillment.materializePackageAllocationCommercialFulfillment({
        packageAllocationPlanId: persisted.planId!,
        source: "normal-split-integration",
      }),
    ).resolves.toMatchObject({
      customerFulfillmentItemCount: 2,
      replayed: true,
    });
  });

  it.each(["missing_contents", "wrong_quantity", "wrong_source"] as const)(
    "rejects unproven provider label portions at the database boundary: %s",
    async (invalidEvidence) => {
      const sourceId = await seedCommercialFulfillmentAuthoritySource(pool, "SKU-LABEL-GUARD", 2);
      await seedAuthorityReadinessLabel(pool, sourceId, {
        providerLabelId: "44010", providerOrderId: "99001", trackingNumber: "1Z0000000000044010",
        contentsLines: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 1 }],
      });
      await seedAuthorityReadinessLabel(pool, sourceId, {
        providerLabelId: "44011", providerOrderId: "99001", trackingNumber: "1Z0000000000044011",
        contentsStatus: invalidEvidence === "missing_contents" ? "empty" : "authoritative",
        contentsLines: [{
          lineItemKey: `wms-item-${invalidEvidence === "wrong_source" ? sourceId + 1 : sourceId}`,
          quantity: invalidEvidence === "wrong_quantity" ? 2 : 1,
        }],
      });
      await pool.query("UPDATE wms.shipping_provider_labels SET carrier = 'ups', service_code = 'ups_ground'");
      const command = commandFor(sourceId);
      const packages = [44010, 44011].map((providerId, index) => {
        const pkg = commandFor(sourceId, {
          packageKey: `package-${index}`, providerPhysicalShipmentId: String(providerId),
          trackingNumber: `1Z00000000000${providerId}`,
        }).packages[0];
        return {
          ...pkg,
          allocationRole: index === 0 ? "primary" as const : "additional_dispatch" as const,
          splitContinuation: index === 0 ? null : {
            source: "provider_label_contents" as const,
            evidenceKey: `shipstation-label-portion:v1:${"a".repeat(64)}`,
            lines: [{ sourceWmsShipmentItemId: sourceId, quantity: 1 }],
          },
          lifecycle: { ...pkg.lifecycle, events: pkg.lifecycle.events.map((event) => (
            event.kind === "outbound_label_observed"
              ? { ...event, contentsEvidence: { status: "authoritative" as const, lines: [{ wmsShipmentItemId: sourceId, quantity: 1 }] } }
              : event
          )) },
        };
      });
      // An internally valid plan alone cannot manufacture provider evidence.
      const persisted = await new PackageAllocationPlanningService(new PgPackageAllocationLedgerRepository(pool))
        .persist({ ...command, packages });
      const fulfillment = createChannelFulfillmentAuthorityRepository(getTestDb());
      await expect(fulfillment.materializePackageAllocationCommercialFulfillment({
        packageAllocationPlanId: persisted.planId!, source: "invalid-label-portion-proof",
      })).rejects.toMatchObject({ code: "23514" });
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM oms.channel_fulfillment_pushes")).rows)
        .toEqual([{ count: 0 }]);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.physical_shipment_items")).rows)
        .toEqual([{ count: 0 }]);
    },
  );

  it.each([
    { orderedQuantity: 2, arrival: "sequential", labelIds: [44010, 44011] },
    { orderedQuantity: 4, arrival: "sequential", labelIds: [44010, 44011] },
    { orderedQuantity: 2, arrival: "reversed", labelIds: [44011, 44010] },
    { orderedQuantity: 2, arrival: "concurrent", labelIds: [44010, 44011] },
    { orderedQuantity: 2, arrival: "retry_after_rollback", labelIds: [44010, 44011] },
    { orderedQuantity: 2, arrival: "voided_conflict", labelIds: [44010, 44011] },
    { orderedQuantity: 2, arrival: "voided_conflict_concurrent", labelIds: [44010, 44011] },
    { orderedQuantity: 2, arrival: "voided_conflict_rollback", labelIds: [44010, 44011] },
    { orderedQuantity: 2, arrival: "voided_conflict_unmapped_source", labelIds: [44010, 44011] },
  ])("sends raw ShipStation labels to Shopify before carrier pickup ($arrival, $orderedQuantity ordered units)", async ({ orderedQuantity, arrival, labelIds }) => {
    // Fill in the production label-link contract missing from the minimal
    // fixture so the real observer and linker can run without database mocks.
    await pool.query(`
      ALTER TABLE wms.shipping_provider_labels
        ADD COLUMN IF NOT EXISTS last_link_reconciled_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS next_link_reconcile_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS link_reconcile_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE wms.shipping_provider_label_links
        ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}',
        ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
      CREATE UNIQUE INDEX IF NOT EXISTS uq_test_label_link_legacy
        ON wms.shipping_provider_label_links(shipping_provider_label_id, legacy_wms_shipment_id)
        WHERE legacy_wms_shipment_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_test_label_link_request
        ON wms.shipping_provider_label_links(shipping_provider_label_id, shipment_request_id)
        WHERE shipment_request_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_test_label_link_physical
        ON wms.shipping_provider_label_links(shipping_provider_label_id, physical_shipment_id)
        WHERE physical_shipment_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_test_label_link_engine
        ON wms.shipping_provider_label_links(shipping_provider_label_id, shipping_engine_order_id)
        WHERE shipping_engine_order_id IS NOT NULL;
    `);
    const sourceId = await seedCommercialFulfillmentAuthoritySource(pool, "SKU-LABEL-PORTION", orderedQuantity);
    const source = (await pool.query<{ shipment_id: number; order_id: number; channel_id: number }>(`
      SELECT item.shipment_id, order_item.order_id, oms_order.channel_id
      FROM wms.outbound_shipment_items item
      JOIN wms.order_items order_item ON order_item.id = item.order_item_id
      JOIN oms.oms_order_lines line ON line.id = order_item.oms_order_line_id
      JOIN oms.oms_orders oms_order ON oms_order.id = line.order_id
      WHERE item.id = $1`, [sourceId])).rows[0];
    const warehouse = (await pool.query<{ id: number }>(`
      INSERT INTO warehouse.warehouses (code, name, shopify_location_id)
      VALUES ('LABEL-PORTIONS', 'Label portions integration', '640010')
      RETURNING id`)).rows[0];
    await pool.query(`UPDATE wms.orders SET channel_id = $2,
      external_order_id = 'gid://shopify/Order/640001', warehouse_id = $3
      WHERE id = $1`, [source.order_id, source.channel_id, warehouse.id]);
    await pool.query(`UPDATE wms.outbound_shipments SET channel_id = $2,
      external_fulfillment_id = NULL, tracking_number = NULL WHERE id = $1`, [source.shipment_id, source.channel_id]);
    const hasVoidedConflict = arrival.startsWith("voided_conflict");
    if (hasVoidedConflict) await seedCanonicalRequestForSource(pool, sourceId);
    if (arrival === "voided_conflict_unmapped_source") {
      // Order-level canonical lineage is known, but the historical WMS item
      // itself has no canonical request-item mapping (the production shape).
      await pool.query("DELETE FROM wms.shipment_request_items WHERE legacy_wms_shipment_item_id = $1", [sourceId]);
    }

    const created: Array<{ id: string; trackingNumber: string; quantity: number }> = [];
    const providerRequest = vi.fn(async (query: string, variables?: Record<string, unknown>): Promise<unknown> => {
      if (query.includes("exactFulfillmentPackageForOrder")) return { order: {
        fulfillmentsCount: { count: created.length },
        fulfillments: created.map((pkg) => ({
          id: pkg.id, status: "SUCCESS", trackingInfo: [{ number: pkg.trackingNumber }],
          fulfillmentLineItems: { nodes: [{ quantity: pkg.quantity, lineItem: { id: "gid://shopify/LineItem/640002" } }], pageInfo: { hasNextPage: false } },
        })),
      } };
      if (query.includes("fulfillmentOrders(first:")) return { order: { fulfillmentOrders: { edges: [{ node: {
        id: "gid://shopify/FulfillmentOrder/640020", status: "OPEN",
        assignedLocation: { location: { id: "gid://shopify/Location/640010" } },
        lineItems: { edges: [{ node: {
          id: "gid://shopify/FulfillmentOrderLineItem/640021", sku: "SKU-LABEL-PORTION",
          lineItem: { id: "gid://shopify/LineItem/640002" }, remainingQuantity: orderedQuantity - created.length,
        } }] },
      } }] } } };
      if (query.includes("fulfillmentCreateV2")) {
        const fulfillment = recordValue(variables?.fulfillment, "Shopify fulfillment");
        expect(fulfillment.lineItemsByFulfillmentOrder).toEqual([{
          fulfillmentOrderId: "gid://shopify/FulfillmentOrder/640020",
          fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/640021", quantity: 1 }],
        }]);
        const tracking = recordValue(fulfillment.trackingInfo, "Shopify tracking");
        const pkg = { id: `gid://shopify/Fulfillment/${640030 + created.length}`, trackingNumber: String(tracking.number), quantity: 1 };
        created.push(pkg);
        return { fulfillmentCreateV2: { fulfillment: { id: pkg.id }, userErrors: [] } };
      }
      throw new Error(`Unexpected Shopify request: ${query.slice(0, 120)}`);
    });
    const client: ShopifyAdminGraphQLClient = {
      request: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => await providerRequest(query, variables) as T,
    };
    const providerExecutor = createCompatibilityChannelFulfillmentProviderExecutor(createFulfillmentPushService(getTestDb(), null, {
      providerClients: {
        shopify: async (channelId) => {
          expect(channelId).toBe(source.channel_id);
          return { channelId, connectionId: 640040, externalAccountId: "label-portions.myshopify.com", client };
        },
        ebay: async () => { throw new Error("Unexpected eBay connection"); },
      },
    }));
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let now = new Date("2026-08-23T14:00:00Z");
    const clock = { now: () => now };
    const observer = new CarrierTrackingService({ repository: createDrizzleCarrierTrackingRepository(getTestDb()), clock, logger });
    const fulfillment = createChannelFulfillmentAuthorityService({
      repository: createChannelFulfillmentAuthorityRepository(getTestDb()),
      projector: { projectPhysicalShipment: vi.fn().mockResolvedValue(undefined) },
      providerExecutor, logger, clock,
    });
    const recordReview = vi.fn();
    const workflow = createPackageAllocationLabelCommercialWorkflow({
      pool, clock, logger,
    });
    let failBeforeCommit = arrival === "retry_after_rollback" || arrival === "voided_conflict_rollback";
    const labelHandler = new PackageAllocationLabelCommercialFulfillmentService({
      enabled: true,
      workflow: {
        run: (work) => workflow.run(async (context) => {
          const result = await work(context);
          if (failBeforeCommit) {
            failBeforeCommit = false;
            throw new Error("Injected failure after activation before commit");
          }
          return result;
        }),
      },
      labelLinker: observer, reviewRepository: { record: recordReview }, logger,
    });
    const voidedShipment = (quantity: number) => ({
      shipmentId: 43999, orderId: 99001, orderKey: `wms-${source.shipment_id}`,
      trackingNumber: "VOIDED-UNUSED-PACKAGE", carrierCode: "ups", isReturnLabel: false,
      voidDate: "2026-08-22T06:00:00.1234567", shipDate: "2026-08-22",
      shipmentItems: [{ lineItemKey: `wms-item-${sourceId}`, quantity }],
    });
    let originalVoidEvents: unknown[] = [];
    if (hasVoidedConflict) {
      // Real observer, two authenticated contradictory snapshots of the SAME
      // canceled label. It was never allocated or sent to the sales channel.
      for (const quantity of [1, 2]) {
        await observer.observeShipStationLabel(voidedShipment(quantity));
        now = new Date(now.getTime() + 60_000);
      }
      await observer.reconcileShipStationLabel("43999");
      originalVoidEvents = (await pool.query(`SELECT event.* FROM wms.shipping_provider_label_events event
        JOIN wms.shipping_provider_labels label ON label.id = event.shipping_provider_label_id
        WHERE label.provider_label_id = '43999' ORDER BY event.id`)).rows;
      expect(originalVoidEvents).toHaveLength(2);
    }
    const recordShipment = vi.fn().mockRejectedValue(new Error("Carrier pickup has not occurred"));
    const recordReplacementShipmentFromAvailableInventory = vi.fn().mockRejectedValue(new Error("No replacement was authorized"));
    vi.stubEnv("SHIPSTATION_API_KEY", "label-test-key");
    vi.stubEnv("SHIPSTATION_API_SECRET", "label-test-secret");
    vi.stubEnv("SHOPIFY_FULFILLMENT_PUSH_ENABLED", "true");
    const fetchLabel = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("includeShipmentItems=true");
      const currentLabel = Number(new URL(String(url)).searchParams.get("labelId"));
      expect([44010, 44011, 44012]).toContain(currentLabel);
      return new Response(JSON.stringify({ shipments: [{
        shipmentId: currentLabel, orderId: 99001, orderKey: `wms-${source.shipment_id}`,
        trackingNumber: `1Z00000000000${currentLabel}`, carrierCode: "ups", serviceCode: "ups_ground",
        createDate: "2026-08-23T10:00:00.000", shipDate: "2026-08-23", isReturnLabel: false,
        shipmentItems: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 1 }],
      }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchLabel);
    try {
      const shipstation = createShipStationService(getTestDb(), { recordShipment, recordReplacementShipmentFromAvailableInventory }, {
        providerLabelObserver: observer, labelCommercialFulfillment: labelHandler,
      });
      const receiveLabel = async (labelId: number) => {
        await expect(shipstation.processShipNotify(`/shipments?labelId=${labelId}`)).resolves.toBe(1);
      };
      if (failBeforeCommit) {
        await expect(shipstation.processShipNotify("/shipments?labelId=44010"))
          .rejects.toThrow("Injected failure after activation before commit");
        for (const table of [
          "wms.package_allocation_groups", "wms.package_allocation_plans",
          "wms.physical_shipments", "oms.channel_fulfillment_pushes",
          "oms.package_allocation_commercial_fulfillment_activations",
        ]) {
          expect((await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows)
            .toEqual([{ count: 0 }]);
        }
        expect(created).toEqual([]);
        expect(await fulfillment.runDueBatch({ limit: 10 })).toMatchObject({ claimed: 0 });
      }
      const dispatchCommands = async (expectedCount: number) => {
        expect(recordReview.mock.calls, JSON.stringify(recordReview.mock.calls)).toEqual([]);
        // PostgreSQL admission timestamps, not the historical provider time,
        // determine when an otherwise immediately due command can be claimed.
        const due = (await pool.query<{ due_at: Date | null }>(
          "SELECT MAX(next_attempt_at) + INTERVAL '1 millisecond' AS due_at FROM oms.channel_fulfillment_pushes",
        )).rows[0].due_at;
        if (due && due > now) now = due;
        const batch = await fulfillment.runDueBatch({ limit: 10 });
        const commands = await pool.query("SELECT id, push_status, last_error_code, last_error FROM oms.channel_fulfillment_pushes ORDER BY id");
        expect(batch, JSON.stringify({ commands: commands.rows, errors: logger.error.mock.calls })).toMatchObject({ claimed: expectedCount, succeeded: expectedCount });
      };
      if (arrival === "concurrent" || arrival === "voided_conflict_concurrent") {
        // Drain both callbacks even if one fails so test cleanup cannot race
        // a still-running transaction from the other label.
        const outcomes = await Promise.allSettled(labelIds.map(receiveLabel));
        expect(outcomes).toEqual(labelIds.map(() => ({ status: "fulfilled", value: undefined })));
        await dispatchCommands(2);
      } else {
        for (const labelId of labelIds) {
          now = new Date(now.getTime() + 60_000);
          await receiveLabel(labelId);
          await dispatchCommands(1);
        }
      }
      expect(created.map((pkg) => [pkg.trackingNumber, pkg.quantity]).sort()).toEqual([
        ["1Z0000000000044010", 1], ["1Z0000000000044011", 1],
      ]);
      if (hasVoidedConflict) {
        const plansBefore = (await pool.query("SELECT id, authority_snapshot FROM wms.package_allocation_plans ORDER BY id")).rows;
        for (const plan of plansBefore) {
          expect(plan.authority_snapshot.excludedVoidedLabelEvidence).toEqual([expect.objectContaining({
            reason: "voided_without_posting_or_allocation",
            postingFacts: expect.objectContaining({ hasOrderScope: true, hasPhysicalPackage: false, hasChannelCommand: false }),
          })]);
        }
        // Another old-label observation changes its evidence hash without
        // changing the two current parcels or rewriting their original audit.
        now = new Date(now.getTime() + 60_000);
        await observer.observeShipStationLabel({ ...voidedShipment(2), serviceCode: "ups_ground" });
        await receiveLabel(44011);
        expect((await pool.query("SELECT id, authority_snapshot FROM wms.package_allocation_plans ORDER BY id")).rows).toEqual(plansBefore);
        expect((await pool.query(`SELECT event.* FROM wms.shipping_provider_label_events event
          JOIN wms.shipping_provider_labels label ON label.id = event.shipping_provider_label_id
          WHERE label.provider_label_id = '43999' ORDER BY event.id`)).rows.slice(0, 2)).toEqual(originalVoidEvents);
        expect((await pool.query("SELECT id FROM wms.physical_shipments WHERE provider_physical_shipment_id = '43999'")).rowCount).toBe(0);
        expect((await pool.query("SELECT id FROM wms.package_allocation_package_bindings WHERE provider_physical_shipment_id = '43999'")).rowCount).toBe(0);
      }
      for (const labelId of [44010, 44011, 44011]) {
        await receiveLabel(labelId);
      }
      expect(recordReview.mock.calls, JSON.stringify(recordReview.mock.calls)).toEqual([]);
      expect(await fulfillment.runDueBatch({ limit: 10 })).toMatchObject({ claimed: 0 });
      expect(created).toHaveLength(2);
      expect(recordShipment).not.toHaveBeenCalled();
      expect(recordReplacementShipmentFromAvailableInventory).not.toHaveBeenCalled();
      expect((await pool.query("SELECT id FROM wms.carrier_tracking_events")).rowCount).toBe(0);
      expect((await pool.query("SELECT id FROM inventory.inventory_transactions")).rowCount).toBe(0);
      expect((await pool.query("SELECT qty, split_root_shipment_item_id FROM wms.outbound_shipment_items WHERE id = $1", [sourceId])).rows)
        .toEqual([{ qty: orderedQuantity, split_root_shipment_item_id: null }]);
      expect((await pool.query("SELECT COUNT(*)::int AS count FROM wms.outbound_shipments")).rows).toEqual([{ count: 1 }]);
      expect((await pool.query(`
        SELECT order_item.fulfilled_quantity, order_item.picked_quantity,
          line.fulfillment_status AS line_status, oms_order.fulfillment_status AS order_status
        FROM wms.order_items order_item
        JOIN oms.oms_order_lines line ON line.id = order_item.oms_order_line_id
        JOIN oms.oms_orders oms_order ON oms_order.id = line.order_id
        WHERE order_item.order_id = $1`, [source.order_id])).rows).toEqual([{
        fulfilled_quantity: 2,
        picked_quantity: 2,
        line_status: orderedQuantity === 2 ? "fulfilled" : "partial",
        order_status: orderedQuantity === 2 ? "fulfilled" : "partial",
      }]);
      if (orderedQuantity === 2) {
        // An extra label is not permission to fulfill a third ordered unit.
        await receiveLabel(44012);
        expect(recordReview).toHaveBeenCalledTimes(1);
        expect(await fulfillment.runDueBatch({ limit: 10 })).toMatchObject({ claimed: 0 });
        expect(created).toHaveLength(2);
      }
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it("keeps a refunded source line while materializing only other lines in the same label", async () => {
    const validSourceId = await seedCommercialFulfillmentAuthoritySource(pool, "SKU-REFUND-OTHER-LINES", 9);
    const lineage = (await pool.query<{
      shipment_id: number;
      wms_order_id: number;
      oms_order_id: string;
    }>(`
      SELECT shipment_item.shipment_id,
        order_item.order_id AS wms_order_id,
        oms_line.order_id::text AS oms_order_id
      FROM wms.outbound_shipment_items AS shipment_item
      JOIN wms.order_items AS order_item ON order_item.id = shipment_item.order_item_id
      JOIN oms.oms_order_lines AS oms_line ON oms_line.id = order_item.oms_order_line_id
      WHERE shipment_item.id = $1::integer
    `, [validSourceId])).rows[0];
    const refundedOmsLine = await pool.query<{ id: string }>(`
      INSERT INTO oms.oms_order_lines (
        order_id, external_line_item_id, fulfillment_provider,
        paid_quantity, authority_fulfillable_quantity, refunded_quantity
      ) VALUES ($1::bigint, 'gid://shopify/LineItem/640003', 'shopify', 1, 0, 1)
      RETURNING id::text AS id
    `, [lineage.oms_order_id]);
    const refundedWmsLine = await pool.query<{ id: number }>(`
      INSERT INTO wms.order_items (order_id, oms_order_line_id, sku, quantity)
      VALUES ($1::integer, $2::bigint, 'SKU-REFUNDED', 1)
      RETURNING id
    `, [lineage.wms_order_id, refundedOmsLine.rows[0].id]);
    const refundedSource = await pool.query<{ id: number }>(`
      INSERT INTO wms.outbound_shipment_items (
        shipment_id, order_item_id, shipment_item_purpose, qty, commercial_requested_qty
      ) VALUES ($1::integer, $2::integer, 'customer_fulfillment', 1, 0)
      RETURNING id
    `, [lineage.shipment_id, refundedWmsLine.rows[0].id]);
    const refundedSourceId = refundedSource.rows[0].id;
    await seedOutboundBusinessShipmentLabel(pool, {
      providerPhysicalShipmentId: "44001",
      trackingNumber: "1Z0000000000044001",
      labelStatus: "active",
      ordinal: 44001,
    });

    const repository = new PgPackageAllocationLedgerRepository(pool);
    const facts = await repository.withSerializableTransaction((transaction) =>
      transaction.readSourceFacts([validSourceId, refundedSourceId]));
    expect(facts.map((fact) => ({ id: fact.sourceWmsShipmentItemId, cap: fact.commercialRequestedQuantity })))
      .toEqual([
        { id: validSourceId, cap: undefined },
        { id: refundedSourceId, cap: 0 },
      ].sort((left, right) => left.id - right.id));

    const base = commandFor(validSourceId);
    const persisted = await new PackageAllocationPlanningService(repository).persist({
      ...base,
      sourceLines: [
        { wmsShipmentItemId: validSourceId, sourceQuantity: 9,
          physicalConsumptionAuthorityQuantity: 9, authorityVersion: 1 },
        { wmsShipmentItemId: refundedSourceId, sourceQuantity: 1, commercialRequestedQuantity: 0,
          physicalConsumptionAuthorityQuantity: 1, authorityVersion: 1 },
      ],
      packages: [{
        ...base.packages[0],
        lifecycle: {
          provider: "shipstation",
          providerPhysicalShipmentId: "44001",
          events: [{
            kind: "outbound_label_observed",
            eventKey: "shipstation:44001:observed",
            observedAt: "2026-08-22T14:00:00.000Z",
            providerOccurredAt: "2026-08-22T13:59:50.000Z",
            trackingNumber: "1Z0000000000044001",
            contentsEvidence: { status: "authoritative", lines: [
              { wmsShipmentItemId: validSourceId, quantity: 9 },
              { wmsShipmentItemId: refundedSourceId, quantity: 1 },
            ] },
          }],
        },
      }],
    });
    expect(persisted.plannerResult.state.desiredEffectIntents.filter((intent) =>
      intent.effectType === "commercial_fulfillment").map((intent) =>
      ({ sourceId: intent.wmsShipmentItemId, quantity: intent.quantity })))
      .toEqual([{ sourceId: validSourceId, quantity: 9 }]);

    const fulfillment = createChannelFulfillmentAuthorityRepository(getTestDb());
    const materialized = await fulfillment.materializePackageAllocationCommercialFulfillment({
      packageAllocationPlanId: persisted.planId!, source: "integration:refund-line-isolation",
    });
    expect(materialized).toMatchObject({ customerFulfillmentItemCount: 1 });
    expect(materialized.channelCommands).toHaveLength(1);
    const commandItems = await pool.query<{ source_id: number; quantity_pushed: number }>(`
      SELECT source.source_wms_shipment_item_id AS source_id, push_item.quantity_pushed
      FROM oms.channel_fulfillment_push_items AS push_item
      JOIN wms.package_allocation_effect_intents AS intent
        ON intent.id = push_item.package_allocation_effect_intent_id
      JOIN wms.package_allocation_source_lines AS source
        ON source.id = intent.package_allocation_source_line_id
    `);
    expect(commandItems.rows).toEqual([{ source_id: validSourceId, quantity_pushed: 9 }]);
    expect((await pool.query("SELECT id FROM wms.outbound_shipment_items WHERE id = $1", [refundedSourceId])).rowCount).toBe(1);
  });

  it("reviews a current authoritative label with a deleted refunded source before isolating the shipped line", async () => {
    const shippedSourceId = await seedCommercialFulfillmentAuthoritySource(
      pool, "SKU-ACTUALLY-SHIPPED", 2,
    );
    const deletedRefundedSourceId = shippedSourceId + 100_000;
    const shipment = await pool.query<{ shipment_id: number }>(
      "SELECT shipment_id FROM wms.outbound_shipment_items WHERE id = $1::integer",
      [shippedSourceId],
    );
    const labelId = await seedAuthorityReadinessLabel(pool, shippedSourceId, {
      providerLabelId: "57002",
      providerOrderId: "78002",
      trackingNumber: "1ZCURRENTREFUNDREVIEW",
      contentsLines: [
        { lineItemKey: `wms-item-${shippedSourceId}`, quantity: 2 },
        { lineItemKey: `wms-item-${deletedRefundedSourceId}`, quantity: 1 },
      ],
    });
    await pool.query(
      `INSERT INTO wms.shipping_provider_label_links (
         shipping_provider_label_id, legacy_wms_shipment_id
       ) VALUES ($1::bigint, $2::integer)`,
      [labelId, shipment.rows[0].shipment_id],
    );
    const leadUserId = "22222222-2222-4222-8222-222222222223";
    await pool.query(
      `INSERT INTO identity.users (id, username, password, role, active)
       VALUES ($1, 'current-review-lead', 'test-only-password-hash', 'lead', 1)`,
      [leadUserId],
    );
    const providerObservationHash = "b".repeat(64);
    const client: HistoricalShipStationContentsClient = {
      async loadShipmentContents(providerShipmentId, expectedContents) {
        expect(providerShipmentId).toBe(57_002);
        expect(expectedContents).toMatchObject({
          kind: "available",
          lines: [{ wmsShipmentItemId: shippedSourceId, quantity: 2 }],
        });
        const providerItems = [
          { lineItemKey: `wms-item-${shippedSourceId}`, quantity: 2 },
          { lineItemKey: `wms-item-${deletedRefundedSourceId}`, quantity: 1 },
        ];
        const recovery = buildHistoricalShipStationContentsRecoveryEvidence({
          providerShipmentId,
          providerStatus: "authoritative",
          rawProviderItems: providerItems,
          expectedContents,
        });
        if (recovery === null) throw new Error("Expected authoritative provider evidence");
        return Object.freeze({
          kind: "found" as const,
          evidence: Object.freeze({
            status: "authoritative" as const,
            recoveryStatus: recovery.recoveryStatus,
            providerItemCount: 2,
            recognizedProviderItemCount: 2,
            canonicalLineCount: 2,
            malformedItemCount: 0,
            unrecognizedItemCount: 0,
            duplicateLineItemCount: 0,
            recoveryEvidence: null,
          }),
          recoveryEvidenceDetails: recovery,
          providerObservation: Object.freeze({
            evidenceHash: providerObservationHash,
            lines: Object.freeze([
              Object.freeze({ sku: "SKU-ACTUALLY-SHIPPED", quantity: 2 }),
              Object.freeze({ sku: "SKU-REFUNDED-NOT-SHIPPED", quantity: 1 }),
            ]),
          }),
        });
      },
    };
    const service = new HistoricalShipStationContentsReviewService(
      new PgHistoricalShipStationContentsReviewRepository(pool), client,
    );
    const intake = await service.intake({
      shippingProviderLabelId: String(labelId),
      reason: "provider_wms_conflict",
      expectedEvidenceHash: providerObservationHash,
    });
    const preview = await service.preview(intake.exceptionId);
    expect(preview).toMatchObject({
      trackingNumber: "1ZCURRENTREFUNDREVIEW",
      wmsContents: [{ wmsShipmentItemId: shippedSourceId, quantity: 2 }],
      providerContents: [
        { sku: "SKU-ACTUALLY-SHIPPED", quantity: 2 },
        { sku: "SKU-REFUNDED-NOT-SHIPPED", quantity: 1 },
      ],
    });
    const correction = await service.decide({
      exceptionId: intake.exceptionId,
      expectedPreviewEvidenceHash: preview.previewEvidenceHash,
      authenticatedActorUserId: leadUserId,
      decision: "wms_confirmed",
      reason: "The refunded source was not physically packed; only the linked WMS source shipped.",
    });
    expect(correction).toMatchObject({ kind: "created", shippingProviderLabelId: String(labelId) });
    const persisted = await new PgPackageAllocationLedgerRepository(pool)
      .withSerializableTransaction((transaction) =>
        transaction.lockAuthorityReadinessPackages([labelId]));
    expect(persisted).toHaveLength(1);
    const projected = projectPersistedDeclaredPackageLifecycleShadow(persisted[0].persistedEvidence);
    expect(projected).toMatchObject({
      outcome: "projected",
      projection: { authoritativeContents: [{ wmsShipmentItemId: shippedSourceId, quantity: 2 }] },
    });
    expect((await pool.query(
      "SELECT id FROM wms.outbound_shipment_items WHERE id = $1::integer",
      [deletedRefundedSourceId],
    )).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM wms.physical_shipment_items")).rowCount).toBe(0);
    expect((await pool.query("SELECT id FROM oms.channel_fulfillment_push_items")).rowCount).toBe(0);

    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handler = new PackageAllocationLabelCommercialFulfillmentService({
      enabled: true,
      logger,
      labelLinker: {
        reconcileShipStationLabel: vi.fn().mockResolvedValue({ linksInserted: 0, totalLinks: 1 }),
      },
      reviewRepository: { record: vi.fn() },
      workflow: createPackageAllocationLabelCommercialWorkflow({
        pool,
        clock: { now: () => new Date("2026-08-28T13:00:00.000Z") },
        logger,
      }),
    });
    const replay = await handler.process({
      shipmentId: 57_002,
      orderId: 78_002,
      trackingNumber: "1ZCURRENTREFUNDREVIEW",
      isReturnLabel: false,
      shipmentItems: [
        { lineItemKey: `wms-item-${shippedSourceId}`, quantity: 2 },
        { lineItemKey: `wms-item-${deletedRefundedSourceId}`, quantity: 1 },
      ],
    }, { shippingProviderLabelId: labelId } as any);
    expect(replay).toMatchObject({ outcome: "activated" });
    const channelItems = await pool.query<{ source_id: number; quantity_pushed: number }>(`
      SELECT source.source_wms_shipment_item_id AS source_id, push_item.quantity_pushed
      FROM oms.channel_fulfillment_push_items AS push_item
      JOIN wms.package_allocation_effect_intents AS intent
        ON intent.id = push_item.package_allocation_effect_intent_id
      JOIN wms.package_allocation_source_lines AS source
        ON source.id = intent.package_allocation_source_line_id
    `);
    expect(channelItems.rows).toEqual([{ source_id: shippedSourceId, quantity_pushed: 2 }]);
    expect((await pool.query<{ legacy_wms_shipment_item_id: number }>(
      "SELECT legacy_wms_shipment_item_id FROM wms.physical_shipment_items",
    )).rows).toEqual([{ legacy_wms_shipment_item_id: shippedSourceId }]);
  });

  it("materializes only the authorized portion of a partly canceled source line", async () => {
    const sourceId = await seedCommercialFulfillmentAuthoritySource(pool, "SKU-PARTIAL-COMMERCIAL", 2);
    await pool.query(
      "UPDATE wms.outbound_shipment_items SET commercial_requested_qty = 1 WHERE id = $1",
      [sourceId],
    );
    await pool.query(`
      UPDATE oms.oms_order_lines AS line
      SET authority_fulfillable_quantity = 1, cancelled_quantity = 1
      FROM wms.order_items AS order_item
      JOIN wms.outbound_shipment_items AS shipment_item ON shipment_item.order_item_id = order_item.id
      WHERE shipment_item.id = $1::integer AND line.id = order_item.oms_order_line_id
    `, [sourceId]);
    await seedOutboundBusinessShipmentLabel(pool, {
      providerPhysicalShipmentId: "44001",
      trackingNumber: "1Z0000000000044001",
      labelStatus: "active",
      ordinal: 44001,
    });
    const base = commandFor(sourceId);
    const persisted = await new PackageAllocationPlanningService(
      new PgPackageAllocationLedgerRepository(pool),
    ).persist({
      ...base,
      sourceLines: [{
        wmsShipmentItemId: sourceId,
        sourceQuantity: 2,
        commercialRequestedQuantity: 1,
        physicalConsumptionAuthorityQuantity: 2,
        authorityVersion: 1,
      }],
    });
    const materialized = await createChannelFulfillmentAuthorityRepository(getTestDb())
      .materializePackageAllocationCommercialFulfillment({
        packageAllocationPlanId: persisted.planId!, source: "integration:partial-commercial-isolation",
      });
    expect(materialized).toMatchObject({ customerFulfillmentItemCount: 1 });
    const commands = await pool.query<{
      quantity_pushed: number;
      quantity_shipped: number;
      allocation_quantity: number;
    }>(`
      SELECT push_item.quantity_pushed, physical_item.quantity_shipped,
        allocation_entry.quantity AS allocation_quantity
      FROM oms.channel_fulfillment_push_items AS push_item
      JOIN wms.physical_shipment_items AS physical_item
        ON physical_item.id = push_item.physical_shipment_item_id
      JOIN wms.package_allocation_entries AS allocation_entry
        ON allocation_entry.id = physical_item.package_allocation_entry_id
    `);
    expect(commands.rows).toEqual([{
      quantity_pushed: 1,
      quantity_shipped: 2,
      allocation_quantity: 2,
    }]);
    expect((await pool.query("SELECT qty FROM wms.outbound_shipment_items WHERE id = $1", [sourceId])).rows)
      .toEqual([{ qty: 2 }]);
  });

  it.each([false, true])("executes exact B/C split quantities and replays without duplicates (stored Shopify mapping: %s)", async (storedShopifyMapping) => {
    const sourceId = await seedCommercialFulfillmentAuthoritySource(
      pool,
      "SKU-COMMERCIAL-SPLIT",
      2,
    );
    await seedOutboundBusinessShipmentLabel(pool, {
      providerPhysicalShipmentId: "44010",
      trackingNumber: "1Z0000000000044010",
      labelStatus: "voided",
      ordinal: 44010,
    });
    await seedOutboundBusinessShipmentLabel(pool, {
      providerPhysicalShipmentId: "44011",
      trackingNumber: "1Z0000000000044011",
      labelStatus: "active",
      ordinal: 44011,
      carrier: "stamps_com",
    });
    await seedOutboundBusinessShipmentLabel(pool, {
      providerPhysicalShipmentId: "44012",
      trackingNumber: "1Z0000000000044012",
      labelStatus: "active",
      ordinal: 44012,
      carrier: "stamps_com",
    });
    await pool.query(
      `INSERT INTO wms.physical_shipments (
         provider, provider_physical_shipment_id, tracking_number, carrier, status
       ) VALUES
         ('shipstation', '44011', '1Z0000000000044011', 'USPS', 'shipped'),
         ('shipstation', '44012', '1Z0000000000044012', 'USPS', 'shipped')`,
    );
    const repository = new PgPackageAllocationLedgerRepository(pool);
    const planning = new PackageAllocationPlanningService(repository);
    const persisted = await planning.persist({
      contractVersion: 1,
      authorityMode: "shadow_only",
      groupKey: "a6e1be0d-c7d8-4c91-919f-04f5eb547f81",
      expectedGroupVersion: 0,
      sourceLines: [{
        wmsShipmentItemId: sourceId,
        sourceQuantity: 2,
        physicalConsumptionAuthorityQuantity: 2,
        authorityVersion: 1,
      }],
      packages: [
        {
          packageKey: "A",
          allocationRole: "primary",
          membership: { status: "proven", evidenceKey: "membership:A" },
          lifecycle: {
            provider: "shipstation",
            providerPhysicalShipmentId: "44010",
            events: [
              {
                kind: "outbound_label_observed",
                eventKey: "shipstation:44010:observed",
                observedAt: "2026-08-22T14:00:00.000Z",
                providerOccurredAt: "2026-08-22T13:59:50.000Z",
                trackingNumber: "1Z0000000000044010",
                contentsEvidence: {
                  status: "authoritative",
                  lines: [{ wmsShipmentItemId: sourceId, quantity: 2 }],
                },
              },
              {
                kind: "outbound_label_voided",
                eventKey: "shipstation:44010:voided",
                observedAt: "2026-08-22T14:01:00.000Z",
                providerOccurredAt: "2026-08-22T14:00:50.000Z",
              },
            ],
          },
        },
        ...[44011, 44012].map((providerPhysicalShipmentId, index) => ({
          packageKey: index === 0 ? "B" : "C",
          allocationRole: "replacement_candidate" as const,
          membership: {
            status: "proven" as const,
            evidenceKey: `membership:${index === 0 ? "B" : "C"}`,
          },
          lifecycle: {
            provider: "shipstation",
            providerPhysicalShipmentId: String(providerPhysicalShipmentId),
            events: [{
              kind: "outbound_label_observed" as const,
              eventKey: `shipstation:${providerPhysicalShipmentId}:observed`,
              observedAt: "2026-08-22T14:02:00.000Z",
              providerOccurredAt: "2026-08-22T14:01:50.000Z",
              trackingNumber: `1Z00000000000${providerPhysicalShipmentId}`,
              contentsEvidence: {
                status: "authoritative" as const,
                lines: [{ wmsShipmentItemId: sourceId, quantity: 1 }],
              },
            }],
          },
        })),
      ],
      actions: [{
        kind: "transfer_awaiting_allocation",
        actionKey: "commercial-split:A:1",
        fromPackageKey: "A",
        targets: [
          { packageKey: "B", wmsShipmentItemId: sourceId, quantity: 1 },
          { packageKey: "C", wmsShipmentItemId: sourceId, quantity: 1 },
        ],
        authorization: {
          kind: "lead_approved",
          actor: "lead:integration",
          reason: "Prove exact split commercial materialization",
        },
      }],
      writeContext: {
        createdBy: "package-allocation-commercial-integration",
        reason: "Prove exact split commercial materialization",
      },
    });
    expect(persisted.planId).not.toBeNull();

    const fulfillmentRepository = createChannelFulfillmentAuthorityRepository(getTestDb());
    const first = await fulfillmentRepository.materializePackageAllocationCommercialFulfillment({
      packageAllocationPlanId: persisted.planId!,
      source: "package-allocation-commercial-integration",
    });
    expect(first).toMatchObject({
      packageAllocationPlanId: persisted.planId,
      customerFulfillmentItemCount: 2,
      replayed: false,
    });
    expect(first.physicalShipmentIds).toHaveLength(2);
    expect(first.channelCommands).toHaveLength(2);
    expect(first.channelCommands.every((command) => command.pushStatus === "shadow")).toBe(true);

    const persistedLines = await pool.query<{
      provider_physical_shipment_id: string;
      physical_quantity: number;
      quantity_pushed: number;
      push_status: string;
      attempt_count: number;
      carrier: string;
      package_allocation_entry_id: string;
      package_allocation_effect_intent_id: string;
      legacy_wms_shipment_item_id: number | null;
    }>(
      `SELECT
         physical.provider_physical_shipment_id,
         item.quantity_shipped AS physical_quantity,
         push_item.quantity_pushed,
         push.push_status,
         push.attempt_count,
         push.carrier,
         item.package_allocation_entry_id::text,
         push_item.package_allocation_effect_intent_id::text,
         item.legacy_wms_shipment_item_id
       FROM oms.channel_fulfillment_push_items AS push_item
       JOIN oms.channel_fulfillment_pushes AS push
         ON push.id = push_item.channel_fulfillment_push_id
       JOIN wms.physical_shipment_items AS item
         ON item.id = push_item.physical_shipment_item_id
       JOIN wms.physical_shipments AS physical
         ON physical.id = item.physical_shipment_id
       ORDER BY physical.provider_physical_shipment_id`,
    );
    expect(persistedLines.rows).toEqual([
      expect.objectContaining({
        provider_physical_shipment_id: "44011",
        physical_quantity: 1,
        quantity_pushed: 1,
        push_status: "shadow",
        attempt_count: 0,
        carrier: "USPS",
        legacy_wms_shipment_item_id: null,
      }),
      expect.objectContaining({
        provider_physical_shipment_id: "44012",
        physical_quantity: 1,
        quantity_pushed: 1,
        push_status: "shadow",
        attempt_count: 0,
        carrier: "USPS",
        legacy_wms_shipment_item_id: null,
      }),
    ]);
    expect(new Set(persistedLines.rows.map((row) => row.package_allocation_entry_id)).size).toBe(2);
    expect(new Set(persistedLines.rows.map((row) => row.package_allocation_effect_intent_id)).size).toBe(1);

    await expect(fulfillmentRepository.claimCommands({
      now: new Date("2026-08-22T14:05:00.000Z"),
      leaseToken: "commercial-shadow-must-not-dispatch",
      leaseDurationMs: 60_000,
      limit: 10,
    })).resolves.toEqual([]);

    const replay = await fulfillmentRepository.materializePackageAllocationCommercialFulfillment({
      packageAllocationPlanId: persisted.planId!,
      source: "package-allocation-commercial-integration",
    });
    expect(replay).toMatchObject({
      customerFulfillmentItemCount: 2,
      replayed: true,
    });
    await expect(pool.query(
      `UPDATE oms.channel_fulfillment_pushes
       SET push_status = 'pending'
       WHERE id = $1::bigint`,
      [first.channelCommands[0].id],
    )).rejects.toMatchObject({ code: "23514" });
    const activatedAt = new Date("2026-08-22T14:06:00.000Z");
    const activation = await fulfillmentRepository
      .activatePackageAllocationCommercialFulfillment({
        packageAllocationPlanId: persisted.planId!,
        activatedBy: "system:package-allocation-commercial-integration",
        reason: "Prove audited label-time commercial activation",
        activatedAt,
        correlationId: "shipping-provider-label:44011",
        causationId: "integration:package-allocation-commercial-activation",
      });
    expect(activation).toEqual({
      packageAllocationPlanId: persisted.planId,
      commandIds: first.channelCommands.map((command) => command.id).sort((left, right) => left - right),
      activatedCommandCount: 2,
      replayed: false,
    });
    await expect(fulfillmentRepository.activatePackageAllocationCommercialFulfillment({
      packageAllocationPlanId: persisted.planId!,
      activatedBy: "system:package-allocation-commercial-integration",
      reason: "Prove audited label-time commercial activation",
      activatedAt,
      correlationId: "shipping-provider-label:44011",
      causationId: "integration:package-allocation-commercial-activation",
    })).resolves.toMatchObject({ replayed: true, activatedCommandCount: 2 });
    const claimable = await fulfillmentRepository.claimCommands({
      now: activatedAt,
      leaseToken: "commercial-activation-is-claimable",
      leaseDurationMs: 60_000,
      limit: 10,
    });
    expect(claimable).toHaveLength(2);
    expect(claimable.every((command) => command.carrier === "USPS")).toBe(true);
    expect(claimable.every((command) => command.items.every(
      (item) => item.packageAllocationEffectIntentId !== null,
    ))).toBe(true);
    const activationAudit = await pool.query<{
      package_allocation_plan_id: string;
      channel_fulfillment_push_id: string;
      activated_by: string;
    }>(
      `SELECT
         package_allocation_plan_id::text,
         channel_fulfillment_push_id::text,
         activated_by
       FROM oms.package_allocation_commercial_fulfillment_activations
       ORDER BY channel_fulfillment_push_id`,
    );
    expect(activationAudit.rows).toHaveLength(2);
    expect(activationAudit.rows.every((row) => (
      row.package_allocation_plan_id === persisted.planId
      && row.activated_by === "system:package-allocation-commercial-integration"
    ))).toBe(true);
    await expect(pool.query(
      `DELETE FROM oms.package_allocation_commercial_fulfillment_activations
       WHERE channel_fulfillment_push_id = $1::bigint`,
      [first.channelCommands[0].id],
    )).rejects.toMatchObject({ code: "23514" });
    const counts = await pool.query<{
      physical_items: number;
      pushes: number;
      push_items: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM wms.physical_shipment_items) AS physical_items,
         (SELECT COUNT(*)::int FROM oms.channel_fulfillment_pushes) AS pushes,
         (SELECT COUNT(*)::int FROM oms.channel_fulfillment_push_items) AS push_items`,
    );
    expect(counts.rows[0]).toEqual({ physical_items: 2, pushes: 2, push_items: 2 });

    const source = await pool.query<{
      shipment_id: number;
      order_id: number;
      oms_order_id: string;
      oms_order_line_id: string;
      channel_id: number;
      product_variant_id: number;
    }>(
      `SELECT si.shipment_id, oi.order_id, ol.order_id::text AS oms_order_id,
              ol.id::text AS oms_order_line_id, o.channel_id, si.product_variant_id
       FROM wms.outbound_shipment_items si
       JOIN wms.order_items oi ON oi.id = si.order_item_id
       JOIN oms.oms_order_lines ol ON ol.id = oi.oms_order_line_id
       JOIN oms.oms_orders o ON o.id = ol.order_id
       WHERE si.id = $1::integer`,
      [sourceId],
    );
    const lineage = source.rows[0];
    const warehouse = await pool.query<{ id: number }>(
      `INSERT INTO warehouse.warehouses (code, name, shopify_location_id)
       VALUES ('SPLIT-PROVIDER', 'Split provider integration', '640010')
       RETURNING id`,
    );
    await pool.query(
      `UPDATE wms.orders
       SET channel_id = $2::integer, external_order_id = 'gid://shopify/Order/640001',
           warehouse_id = $3::integer
       WHERE id = $1::integer`,
      [lineage.order_id, lineage.channel_id, warehouse.rows[0].id],
    );
    await pool.query(
      `UPDATE wms.outbound_shipments SET channel_id = $2::integer
       WHERE id = $1::integer`,
      [lineage.shipment_id, lineage.channel_id],
    );
    if (storedShopifyMapping) {
      await pool.query(
        `UPDATE oms.oms_order_lines
         SET provider_fulfillment_order_id = 'gid://shopify/FulfillmentOrder/640020',
             provider_fulfillment_order_line_item_id = 'gid://shopify/FulfillmentOrderLineItem/640021'
         WHERE id = $1::bigint`,
        [lineage.oms_order_line_id],
      );
    }

    // The legacy shipment can contain other same-SKU lines which are not in
    // either package command. Neither stored-ID nor live lookup may send them.
    const siblingLine = await pool.query<{ id: string }>(
      `INSERT INTO oms.oms_order_lines (
         order_id, external_line_item_id, fulfillment_provider,
         paid_quantity, authority_fulfillable_quantity,
         provider_fulfillment_order_id, provider_fulfillment_order_line_item_id
       ) VALUES (
         $1::bigint, 'gid://shopify/LineItem/640003', 'shopify', 3, 3,
         'gid://shopify/FulfillmentOrder/640020', 'gid://shopify/FulfillmentOrderLineItem/640022'
       ) RETURNING id::text AS id`,
      [lineage.oms_order_id],
    );
    const siblingOrderItem = await pool.query<{ id: number }>(
      `INSERT INTO wms.order_items (order_id, oms_order_line_id, sku, quantity)
       VALUES ($1::integer, $2::bigint, 'SKU-COMMERCIAL-SPLIT', 3) RETURNING id`,
      [lineage.order_id, siblingLine.rows[0].id],
    );
    await pool.query(
      `INSERT INTO wms.outbound_shipment_items (
         shipment_id, order_item_id, product_variant_id, qty
       ) VALUES ($1::integer, $2::integer, $3::integer, 3)`,
      [lineage.shipment_id, siblingOrderItem.rows[0].id, lineage.product_variant_id],
    );

    const createdPackages: Array<{ id: string; trackingNumber: string; quantity: number }> = [];
    const request = vi.fn(async (query: string, variables?: Record<string, unknown>): Promise<unknown> => {
      if (query.includes("exactFulfillmentPackageForOrder")) {
        expect(variables).toEqual({ id: "gid://shopify/Order/640001" });
        return { order: {
          fulfillmentsCount: { count: createdPackages.length },
          fulfillments: createdPackages.map((created) => ({
            id: created.id,
            status: "SUCCESS",
            trackingInfo: [{ number: created.trackingNumber }],
            fulfillmentLineItems: {
              nodes: [{ quantity: created.quantity, lineItem: { id: "gid://shopify/LineItem/640002" } }],
              pageInfo: { hasNextPage: false },
            },
          })),
        } };
      }
      if (query.includes("fulfillmentCreateV2")) {
        const fulfillment = recordValue(variables?.fulfillment, "Shopify fulfillment mutation");
        expect(fulfillment.notifyCustomer).toBe(false);
        expect(fulfillment.lineItemsByFulfillmentOrder).toEqual([{
          fulfillmentOrderId: "gid://shopify/FulfillmentOrder/640020",
          fulfillmentOrderLineItems: [{ id: "gid://shopify/FulfillmentOrderLineItem/640021", quantity: 1 }],
        }]);
        const tracking = recordValue(fulfillment.trackingInfo, "Shopify tracking input");
        expect(typeof tracking.number).toBe("string");
        const created = {
          id: `gid://shopify/Fulfillment/${640030 + createdPackages.length}`,
          trackingNumber: String(tracking.number),
          quantity: 1,
        };
        createdPackages.push(created);
        return { fulfillmentCreateV2: { fulfillment: { id: created.id }, userErrors: [] } };
      }
      if (query.includes("fulfillmentOrders(first:")) {
        expect(variables).toEqual({ id: "gid://shopify/Order/640001" });
        return { order: { fulfillmentOrders: { edges: [{ node: {
          id: "gid://shopify/FulfillmentOrder/640020",
          status: "OPEN",
          assignedLocation: { location: { id: "gid://shopify/Location/640010" } },
          lineItems: { edges: [
            { node: {
              id: "gid://shopify/FulfillmentOrderLineItem/640021",
              sku: "SKU-COMMERCIAL-SPLIT",
              lineItem: { id: "gid://shopify/LineItem/640002" },
              remainingQuantity: 2 - createdPackages.reduce((sum, item) => sum + item.quantity, 0),
            } },
            { node: {
              id: "gid://shopify/FulfillmentOrderLineItem/640022",
              sku: "SKU-COMMERCIAL-SPLIT",
              lineItem: { id: "gid://shopify/LineItem/640003" },
              remainingQuantity: 3,
            } },
          ] },
        } }] } } };
      }
      throw new Error("Unexpected Shopify query in split-package regression");
    });
    const client: ShopifyAdminGraphQLClient = {
      request: async <T>(query: string, variables?: Record<string, unknown>): Promise<T> => (
        await request(query, variables) as T
      ),
    };
    const shopify = vi.fn(async (channelId: number) => {
      expect(channelId).toBe(lineage.channel_id);
      return {
        channelId,
        connectionId: 640040,
        externalAccountId: "split-package-integration.myshopify.com",
        client,
      };
    });
    const ebay = vi.fn(async () => { throw new Error("Unexpected eBay account resolution"); });
    const provider = createCompatibilityChannelFulfillmentProviderExecutor(
      createFulfillmentPushService(getTestDb(), null, { providerClients: { shopify, ebay } }),
    );
    // A later split shrinks the compatibility source row, not the frozen grant.
    // Both immutable quantity-one packages remain valid against original two.
    await pool.query("UPDATE wms.outbound_shipment_items SET qty=1 WHERE id=$1", [sourceId]);
    for (const command of claimable) {
      expect(command.items).toHaveLength(1);
      expect(command.items[0]).toMatchObject({ legacyWmsShipmentItemId: sourceId, quantity: 1 });
      // The deployed quantity fix also needs an explicit, audited way to
      // recheck commands stopped by the old full-source equality guard.
      await fulfillmentRepository.completeAttempt({
        commandId: command.id, leaseToken: command.leaseToken,
        startedAt: activatedAt, completedAt: activatedAt,
        outcome: "review_required", errorCode: "channel_fulfillment_lineage_mismatch",
        errorMessage: "Old guard rejected package quantity one against source two",
      });
      const recovery = createChannelFulfillmentReviewRetryRepository(getTestDb());
      const scope = { commandId: command.id, omsOrderId: command.omsOrderId };
      const preview = await recovery.preview(scope);
      expect(preview.eligibleForRecheck).toBe(true);
      const retryInput = { ...scope, expectedStateFingerprint: preview.stateFingerprint, notifyCustomer: false as const,
        actor: "integration:shopify-reviewer", reason: "Recheck exact allocated quantity after provider fix", requeuedAt: activatedAt };
      const retries = await Promise.all([recovery.requeue(retryInput), recovery.requeue(retryInput)]);
      expect(retries.filter(result => result.requeued)).toHaveLength(1);
      expect(retries.filter(result => result.replayed)).toHaveLength(1);
      // An old/rolled-back worker cannot claim this retry and send an email by
      // ignoring the separately persisted suppression. The failed claim rolls back.
      await expect(pool.query(`UPDATE oms.channel_fulfillment_pushes SET push_status='processing',
        attempt_count=attempt_count+1, lease_token='old-worker', lease_expires_at=NOW()+INTERVAL '1 minute'
        WHERE id=$1`, [command.id])).rejects.toMatchObject({ code: "23514" });
      const [reclaimed] = await fulfillmentRepository.claimCommands({
        now: activatedAt, leaseToken: `shopify-reviewed-recovery:${command.id}`,
        leaseDurationMs: 60000, limit: 1, commandIds: [command.id],
      });
      expect(reclaimed.attemptNumber).toBe(2);
      expect(reclaimed.requestHash).toBe(command.requestHash);
      expect(reclaimed.metadata).toEqual(command.metadata);
      expect(reclaimed.notificationSuppression).toMatchObject({ requestHash: command.requestHash,
        notifyCustomer: false, operator: retryInput.actor });
      const executed = await provider.execute(reclaimed);
      expect(executed.outcome).toBe("success");
      await fulfillmentRepository.completeAttempt({
        commandId: command.id,
        leaseToken: reclaimed.leaseToken,
        startedAt: activatedAt,
        completedAt: new Date("2026-08-22T14:06:01.000Z"),
        ...executed,
      });
    }
    expect(createdPackages.map((item) => item.trackingNumber).sort()).toEqual([
      "1Z0000000000044011",
      "1Z0000000000044012",
    ]);
    expect(createdPackages.map((item) => item.quantity)).toEqual([1, 1]);

    // Simulate retry after provider success: the exact package readback must
    // recognize each quantity-1 package independently of the shared source2.
    for (const command of claimable) {
      await expect(provider.execute(command)).resolves.toMatchObject({ outcome: "ignored" });
    }
    expect(createdPackages).toHaveLength(2);
    expect(ebay).not.toHaveBeenCalled();
    const evidence = await pool.query<{ details: Record<string, unknown> }>(
      `SELECT details FROM oms.oms_order_events
       WHERE order_id = $1::bigint AND event_type = 'shopify_fulfillment_pushed'
       ORDER BY id`,
      [lineage.oms_order_id],
    );
    expect(evidence.rows).toHaveLength(2);
    for (const event of evidence.rows) {
      expect(event.details).toMatchObject({
        requestedQuantity: 1,
        pushedQuantity: 1,
        writebackComplete: true,
        lineEvidence: [{ shipmentItemId: sourceId, requestedQuantity: 1 }],
      });
    }
    const completed = await pool.query<{ push_status: string; quantity_pushed: number }>(
      `SELECT push.push_status, item.quantity_pushed
       FROM oms.channel_fulfillment_pushes push
       JOIN oms.channel_fulfillment_push_items item ON item.channel_fulfillment_push_id = push.id
       ORDER BY push.id`,
    );
    expect(completed.rows).toEqual([
      { push_status: "success", quantity_pushed: 1 },
      { push_status: "success", quantity_pushed: 1 },
    ]);
  });

  it.each([
    { preexistingRequest: false, conflict: null },
    { preexistingRequest: true, conflict: null },
    { preexistingRequest: false, conflict: null, splitAfterActivation: true },
    { preexistingRequest: false, conflict: "request_quantity" },
    { preexistingRequest: false, conflict: "request_relink" },
    { preexistingRequest: false, conflict: "source_sku" },
    { preexistingRequest: false, conflict: "removed_relationship" },
  ] as const)(
    "follows persisted group history through the public label handler without issuing commercial quantity twice (preexisting request: $preexistingRequest, conflict: $conflict)",
    async ({ preexistingRequest, conflict, ...scenario }) => {
      const sourceId = await seedCommercialFulfillmentAuthoritySource(
        pool,
        "SKU-PUBLIC-LABEL-CONTINUITY",
        2,
      );
      if (preexistingRequest)
        await seedCanonicalRequestForSource(pool, sourceId);
      const labelId = await seedAuthorityReadinessLabel(pool, sourceId, {
        providerLabelId: "44010",
        providerOrderId: "99001",
        trackingNumber: "1Z0000000000044010",
      });
      await pool.query(
        "UPDATE wms.shipping_provider_labels SET carrier = 'ups' WHERE id = $1",
        [labelId],
      );
      await pool.query(
        `INSERT INTO wms.shipping_provider_label_links (shipping_provider_label_id, legacy_wms_shipment_id)
      SELECT $1, shipment_id FROM wms.outbound_shipment_items WHERE id = $2`,
        [labelId, sourceId],
      );
      const ledger = new PgPackageAllocationLedgerRepository(pool);
      const bootstrap = new PackageAllocationBootstrapPersistenceService(
        ledger,
      );
      const projectPhysicalShipment = vi.fn().mockResolvedValue(undefined);
      const providerExecute = vi
        .fn()
        .mockRejectedValue(
          new Error("No external provider call is authorized by this test"),
        );
      const recordReview = vi.fn().mockResolvedValue(undefined);
      const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      const fulfillment = createChannelFulfillmentAuthorityService({
        repository: createChannelFulfillmentAuthorityRepository(getTestDb()),
        projector: { projectPhysicalShipment },
        providerExecutor: { execute: providerExecute },
        logger,
        clock: { now: () => new Date("2026-08-23T14:01:00.000Z") },
      });
      const label = new PackageAllocationLabelCommercialFulfillmentService({
        enabled: true,
        workflow: { run: async (work) => work({
          loadLabelContents: async () => ({
            authoritativeContents: [{ wmsShipmentItemId: sourceId, quantity: 2 }],
            providerObservations: [{ eventKey: "test-label", contents: [
              { wmsShipmentItemId: sourceId, quantity: 2 },
            ] }],
            leadCorrections: [],
          }),
          bootstrap,
          fulfillmentAuthority: fulfillment,
        }) },
        labelLinker: {
          reconcileShipStationLabel: async () => ({
            shippingProviderLabelId: labelId,
            linksInserted: 0,
            totalLinks: 1,
          }),
        },
        reviewRepository: { record: recordReview },
        logger,
      });
      const observation = {
        shippingProviderLabelId: labelId,
        labelInserted: true,
        eventInserted: true,
      };
      const shipment = {
        shipmentId: 44010,
        orderId: 99001,
        isReturnLabel: false,
        trackingNumber: "1Z0000000000044010",
        shipmentItems: [{ lineItemKey: `wms-item-${sourceId}`, quantity: 2 }],
      };
      const first = await label.process(shipment, observation);
      expect(first).toMatchObject({ outcome: "activated", replayed: false });
      if (first.outcome !== "activated")
        throw new Error(
          `Unexpected first label outcome: ${JSON.stringify(first)}`,
        );
      const registeredBefore = await pool.query(
        `SELECT * FROM wms.package_allocation_source_lines
      WHERE source_wms_shipment_item_id = $1`,
        [sourceId],
      );
      expect(registeredBefore.rows[0].shipment_request_item_id === null).toBe(
        !preexistingRequest,
      );
      const requestBefore = await pool.query<{
        id: string;
        shipment_request_id: string;
      }>(
        `SELECT id::text AS id, shipment_request_id::text AS shipment_request_id
       FROM wms.shipment_request_items WHERE legacy_wms_shipment_item_id = $1`,
        [sourceId],
      );
      expect(requestBefore.rows).toHaveLength(1);
      if ("splitAfterActivation" in scenario && scenario.splitAfterActivation) {
        const childShipment = await pool.query(`INSERT INTO wms.outbound_shipments (order_id)
          SELECT shipment.order_id FROM wms.outbound_shipments shipment
          JOIN wms.outbound_shipment_items item ON item.shipment_id=shipment.id WHERE item.id=$1 RETURNING id`, [sourceId]);
        await pool.query(`INSERT INTO wms.outbound_shipment_items (
          shipment_id, order_item_id, shipment_item_purpose, product_variant_id, qty, split_root_shipment_item_id)
          SELECT $2, order_item_id, shipment_item_purpose, product_variant_id, 1, id
          FROM wms.outbound_shipment_items WHERE id=$1`, [sourceId, childShipment.rows[0].id]);
        await pool.query("UPDATE wms.outbound_shipment_items SET qty=1 WHERE id=$1", [sourceId]);
      }
      const planBefore = await pool.query(
        "SELECT * FROM wms.package_allocation_plans WHERE id = $1",
        [first.planId],
      );
      const immediateReplay = await label.process(shipment, observation);
      expect(immediateReplay, JSON.stringify(immediateReplay)).toMatchObject({
        outcome: "activated",
        replayed: true,
        planId: first.planId,
        commandIds: first.commandIds,
      });
      expect(
        (
          await pool.query(
            "SELECT * FROM wms.package_allocation_plans WHERE id = $1",
            [first.planId],
          )
        ).rows,
      ).toEqual(planBefore.rows);
      projectPhysicalShipment.mockClear();
      if (conflict !== null) {
        if (conflict === "request_quantity") {
          await pool.query(
            "UPDATE wms.shipment_request_items SET quantity_requested = quantity_requested + 1 WHERE id = $1",
            [requestBefore.rows[0].id],
          );
        } else if (conflict === "request_relink") {
          // A lookalike request is insufficient even when it repeats the same
          // source/order/plan IDs: immutable physical provenance names the original.
          await pool.query(
            "UPDATE wms.shipment_request_items SET legacy_wms_shipment_item_id = NULL WHERE id = $1",
            [requestBefore.rows[0].id],
          );
          await pool.query(
            "UPDATE wms.shipment_requests SET legacy_wms_shipment_id = NULL WHERE id = $1",
            [requestBefore.rows[0].shipment_request_id],
          );
          const copiedRequest = await pool.query<{ id: string }>(
            `INSERT INTO wms.shipment_requests (
          fulfillment_plan_id, wms_order_id, warehouse_id, request_status, legacy_wms_shipment_id)
          SELECT fulfillment_plan_id, wms_order_id, warehouse_id, request_status,
            (SELECT shipment_id FROM wms.outbound_shipment_items WHERE id = $2)
          FROM wms.shipment_requests WHERE id = $1 RETURNING id::text AS id`,
            [requestBefore.rows[0].shipment_request_id, sourceId],
          );
          await pool.query(
            `INSERT INTO wms.shipment_request_items (shipment_request_id, fulfillment_plan_line_id,
          wms_order_item_id, legacy_wms_shipment_item_id, quantity_requested)
          SELECT $1, fulfillment_plan_line_id, wms_order_item_id, $2, quantity_requested
          FROM wms.shipment_request_items WHERE id = $3`,
            [copiedRequest.rows[0].id, sourceId, requestBefore.rows[0].id],
          );
        } else if (conflict === "source_sku") {
          await pool.query(
            `UPDATE wms.order_items SET sku = 'CHANGED-IMMUTABLE-SOURCE'
          WHERE id = (SELECT order_item_id FROM wms.outbound_shipment_items WHERE id = $1)`,
            [sourceId],
          );
        } else {
          await pool.query(
            `DELETE FROM wms.shipping_provider_label_links
          WHERE shipping_provider_label_id = $1 AND legacy_wms_shipment_id IS NOT NULL`,
            [labelId],
          );
        }
        const ledgerBefore = await loadLedgerCounts(pool);
        await expect(label.process(shipment, observation)).resolves.toEqual({
          outcome: "review",
          reason:
            conflict === "removed_relationship"
              ? "CURRENT_PLAN_MISSING"
              : "SOURCE_REGISTRATION_CONFLICT",
        });
        expect(await loadLedgerCounts(pool)).toEqual(ledgerBefore);
        expect(
          (
            await pool.query(
              `SELECT * FROM wms.package_allocation_source_lines
        WHERE source_wms_shipment_item_id = $1`,
              [sourceId],
            )
          ).rows,
        ).toEqual(registeredBefore.rows);
        expect(
          (
            await pool.query(
              "SELECT COUNT(*)::int AS count FROM oms.channel_fulfillment_push_items",
            )
          ).rows,
        ).toEqual([{ count: 1 }]);
        expect(projectPhysicalShipment).not.toHaveBeenCalled();
        expect(providerExecute).not.toHaveBeenCalled();
        expect(recordReview).toHaveBeenCalledTimes(1);
        return;
      }
      const carrier = await pool.query<{
        id: string;
      }>(`INSERT INTO wms.carrier_tracking_events (
      dispatch_evidence, event_occurred_at, received_at) VALUES ('confirmed', '2026-08-23T14:02:00Z', '2026-08-23T14:03:00Z') RETURNING id::text AS id`);
      const hash = "a".repeat(64);
      const match = await pool.query<{ id: string }>(
        `INSERT INTO wms.carrier_tracking_event_matches (
      carrier_tracking_event_id, shipping_provider_label_id, attempt_hash, match_status)
      VALUES ($1, $2, $3, 'matched') RETURNING id::text AS id`,
        [carrier.rows[0].id, labelId, hash],
      );
      await pool.query(
        `INSERT INTO wms.carrier_tracking_reconciliation_state (
      carrier_tracking_event_id, last_match_attempt_id, last_match_attempt_hash, last_match_status)
      VALUES ($1, $2, $3, 'matched')`,
        [carrier.rows[0].id, match.rows[0].id, hash],
      );
      const second = await label.process(shipment, {
        ...observation,
        labelInserted: false,
        eventInserted: false,
      });
      expect(second).toMatchObject({
        outcome: "activated",
        replayed: true,
        commandIds: first.commandIds,
      });
      if (second.outcome !== "activated")
        throw new Error(
          `Unexpected repeated label outcome: ${JSON.stringify(second)}`,
        );
      expect(second.planId).not.toBe(first.planId);
      await expect(label.process(shipment, observation)).resolves.toEqual(
        second,
      );
      const concurrentReplays = await Promise.all([
        label.process(shipment, observation),
        label.process(shipment, observation),
      ]);
      expect(concurrentReplays).toEqual([second, second]);
      expect(
        (
          await pool.query(
            `SELECT * FROM wms.package_allocation_source_lines
      WHERE source_wms_shipment_item_id = $1`,
            [sourceId],
          )
        ).rows,
      ).toEqual(registeredBefore.rows);
      const plans = await pool.query(
        "SELECT current_version FROM wms.package_allocation_groups",
      );
      expect(plans.rows).toEqual([{ current_version: 2 }]);
      const effects =
        await pool.query(`SELECT COUNT(*)::int AS commands, COALESCE(SUM(quantity_pushed),0)::int AS quantity
      FROM oms.channel_fulfillment_push_items`);
      expect(effects.rows[0]).toEqual({ commands: 1, quantity: 2 });
      const audit = await pool.query(
        "SELECT package_allocation_plan_id::text AS id FROM oms.package_allocation_commercial_fulfillment_activations",
      );
      expect(audit.rows).toEqual([{ id: first.planId }]);
      expect(projectPhysicalShipment).not.toHaveBeenCalled();
      expect(providerExecute).not.toHaveBeenCalled();
      expect(recordReview).not.toHaveBeenCalled();
    },
  );

  it.each(["activated", "shadow", "unmaterialized"] as const)("validates inherited commercial authority after tracking revision: %s", async (priorState) => {
    const sourceId = await seedCommercialFulfillmentAuthoritySource(pool, "SKU-INHERITED-COMMERCIAL", 2);
    await seedCanonicalRequestForSource(pool, sourceId);
    await seedOutboundBusinessShipmentLabel(pool, { providerPhysicalShipmentId: "44100",
      trackingNumber: "1Z0000000000044100", labelStatus: "active", ordinal: 44100 });
    const ledger = new PgPackageAllocationLedgerRepository(pool);
    const planning = new PackageAllocationPlanningService(ledger);
    const initial = commandFor(sourceId, { groupKey: "b6e1be0d-c7d8-4c91-919f-04f5eb547f82",
      providerPhysicalShipmentId: "44100", trackingNumber: "1Z0000000000044100" });
    const first = await planning.persist(initial);
    const fulfillment = createChannelFulfillmentAuthorityRepository(getTestDb());
    const command = { packageAllocationPlanId: first.planId!, source: "package-allocation-commercial-integration" };
    const activationInput = { packageAllocationPlanId: first.planId!, activatedBy: "system:integration",
      reason: "Prove commercial continuity without duplicate quantity", activatedAt: new Date("2026-08-22T14:06:00.000Z") };
    const materialized = priorState !== "unmaterialized"
      ? await fulfillment.materializePackageAllocationCommercialFulfillment(command) : null;
    if (priorState === "activated") await fulfillment.activatePackageAllocationCommercialFulfillment(activationInput);
    const pkg = initial.packages[0];
    const trackingCommand: PersistPackageAllocationPlanCommand = { ...initial, expectedGroupVersion: 1,
      packages: [{ ...pkg, lifecycle: { ...pkg.lifecycle, events: [...pkg.lifecycle.events, {
        kind: "carrier_possession_confirmed", eventKey: "carrier:44100:accepted", observedAt: "2026-08-22T14:07:00.000Z",
        providerOccurredAt: "2026-08-22T14:06:50.000Z", carrierTrackingEventId: 134100,
      }] } }] };
    const second = await planning.persist(trackingCommand);
    expect(second).toMatchObject({ kind: "created", currentGroupVersion: 2 });
    expect(second.plannerResult.effectIntentsToAppend.some((intent) => intent.effectType === "commercial_fulfillment")).toBe(false);
    const nextCommand = { ...command, packageAllocationPlanId: second.planId! };
    const nextActivation = { ...activationInput, packageAllocationPlanId: second.planId! };
    if (priorState === "activated") {
      const commandIds = materialized!.channelCommands.map((entry) => entry.id);
      await expect(fulfillment.materializePackageAllocationCommercialFulfillment(nextCommand)).resolves.toMatchObject({
        packageAllocationPlanId: second.planId, physicalShipmentIds: [], replayed: true,
        channelCommands: commandIds.map((id) => ({ id, replayed: true })), customerFulfillmentItemCount: 1,
      });
      await expect(fulfillment.activatePackageAllocationCommercialFulfillment(nextActivation)).resolves.toEqual({
        packageAllocationPlanId: second.planId, commandIds, activatedCommandCount: 1, replayed: true,
      });
      await expect(fulfillment.materializePackageAllocationCommercialFulfillment({ ...nextCommand, source: "another-command-source" }))
        .rejects.toMatchObject({ code: "PACKAGE_ALLOCATION_ACTIVATION_CONFLICT" });
      const third = await planning.persist({ ...trackingCommand, expectedGroupVersion: 2,
        packages: [{ ...trackingCommand.packages[0], lifecycle: { ...trackingCommand.packages[0].lifecycle,
          events: [...trackingCommand.packages[0].lifecycle.events, { kind: "outbound_label_voided",
            eventKey: "shipstation:44100:voided-after-possession", observedAt: "2026-08-22T14:08:00.000Z",
            providerOccurredAt: "2026-08-22T14:07:50.000Z" }] } }] });
      expect(third.currentGroupVersion).toBe(3);
      await expect(fulfillment.materializePackageAllocationCommercialFulfillment(nextCommand)).rejects.toMatchObject({ code: "PACKAGE_ALLOCATION_PLAN_STALE" });
      await expect(fulfillment.activatePackageAllocationCommercialFulfillment(nextActivation)).rejects.toMatchObject({ code: "PACKAGE_ALLOCATION_PLAN_STALE" });
    } else {
      await expect(fulfillment.materializePackageAllocationCommercialFulfillment(nextCommand)).rejects.toMatchObject({ code: "PACKAGE_ALLOCATION_ACTIVATION_CONFLICT" });
      await expect(fulfillment.activatePackageAllocationCommercialFulfillment(nextActivation)).rejects.toMatchObject({ code: "PACKAGE_ALLOCATION_ACTIVATION_CONFLICT" });
    }
    const counts = await pool.query(`SELECT (SELECT COUNT(*)::int FROM wms.physical_shipment_items) AS physical_items,
      (SELECT COUNT(*)::int FROM oms.channel_fulfillment_pushes) AS pushes,
      (SELECT COUNT(*)::int FROM oms.package_allocation_commercial_fulfillment_activations) AS activations,
      (SELECT COALESCE(SUM(quantity_pushed), 0)::int FROM oms.channel_fulfillment_push_items) AS quantity`);
    expect(counts.rows[0]).toEqual({ physical_items: priorState === "unmaterialized" ? 0 : 1,
      pushes: priorState === "unmaterialized" ? 0 : 1, activations: priorState === "activated" ? 1 : 0,
      quantity: priorState === "unmaterialized" ? 0 : 2 });
    const executable = await pool.query("SELECT COUNT(*)::int AS count FROM wms.package_allocation_effect_intents WHERE executable");
    expect(executable.rows[0].count).toBe(0);
  });

  it("rejects an unmaterialized commercial intent after its originating plan becomes stale", async () => {
    const sourceId = await seedCommercialFulfillmentAuthoritySource(
      pool,
      "SKU-COMMERCIAL-STALE",
      2,
    );
    await seedOutboundBusinessShipmentLabel(pool, {
      providerPhysicalShipmentId: "44100",
      trackingNumber: "1Z0000000000044100",
      labelStatus: "active",
      ordinal: 44100,
    });
    const repository = new PgPackageAllocationLedgerRepository(pool);
    const planning = new PackageAllocationPlanningService(repository);
    const initialCommand = commandFor(sourceId, {
      groupKey: "b6e1be0d-c7d8-4c91-919f-04f5eb547f82",
      providerPhysicalShipmentId: "44100",
      trackingNumber: "1Z0000000000044100",
    });
    const first = await planning.persist(initialCommand);
    expect(first.planId).not.toBeNull();
    const initialPackage = initialCommand.packages[0];
    await planning.persist({
      ...initialCommand,
      expectedGroupVersion: first.currentGroupVersion,
      packages: [{
        ...initialPackage,
        lifecycle: {
          ...initialPackage.lifecycle,
          events: [
            ...initialPackage.lifecycle.events,
            {
              kind: "carrier_possession_confirmed",
              eventKey: "carrier:44100:accepted",
              observedAt: "2026-08-22T14:05:00.000Z",
              providerOccurredAt: "2026-08-22T14:04:50.000Z",
              carrierTrackingEventId: 134_100,
            },
          ],
        },
      }],
    });

    const fulfillmentRepository = createChannelFulfillmentAuthorityRepository(getTestDb());
    await expect(
      fulfillmentRepository.materializePackageAllocationCommercialFulfillment({
        packageAllocationPlanId: first.planId!,
        source: "package-allocation-commercial-integration",
      }),
    ).rejects.toMatchObject({ code: "PACKAGE_ALLOCATION_PLAN_STALE" });
    const counts = await pool.query<{ physical_items: number; pushes: number }>(
      `SELECT
         (SELECT COUNT(*)::int FROM wms.physical_shipment_items) AS physical_items,
         (SELECT COUNT(*)::int FROM oms.channel_fulfillment_pushes) AS pushes`,
    );
    expect(counts.rows[0]).toEqual({ physical_items: 0, pushes: 0 });
  });

  it("persists a partial cancellation with exact action evidence and replays without duplicates", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-CANCEL", 2);
    const baseCommand = commandFor(sourceId);
    const sourcePackage = baseCommand.packages[0];
    const initialCommand: PersistPackageAllocationPlanCommand = {
      ...baseCommand,
      packages: [{
        ...sourcePackage,
        lifecycle: {
          ...sourcePackage.lifecycle,
          events: [
            ...sourcePackage.lifecycle.events,
            {
              kind: "outbound_label_voided",
              eventKey: "shipstation:44001:voided",
              observedAt: "2026-08-22T14:01:00.000Z",
              providerOccurredAt: "2026-08-22T14:00:30.000Z",
            },
          ],
        },
      }],
    };
    const cancellationAction = {
      kind: "cancel_awaiting_allocation" as const,
      actionKey: "fulfillment-cancellation:7001:1",
      fromPackageKey: "package-a",
      wmsShipmentItemId: sourceId,
      quantity: 1,
      authorization: {
        kind: "lead_approved" as const,
        actor: "shipping-lead-42",
        reason: "Cancel one exact unit before carrier possession",
      },
    };
    const cancellationCommand: PersistPackageAllocationPlanCommand = {
      ...initialCommand,
      expectedGroupVersion: 1,
      actions: [cancellationAction],
      writeContext: {
        createdBy: "package-allocation-postgres-integration",
        reason: "Persist exact pre-possession fulfillment cancellation evidence",
      },
    };
    const repository = new PgPackageAllocationLedgerRepository(pool);
    const service = new PackageAllocationPlanningService(repository);

    const initial = await service.persist(initialCommand);
    const cancelled = await service.persist(cancellationCommand);

    expect(initial).toMatchObject({
      kind: "created",
      persistedPlanVersion: 1,
      currentGroupVersion: 1,
    });
    expect(cancelled).toMatchObject({
      kind: "created",
      persistedPlanVersion: 2,
      currentGroupVersion: 2,
      plannerResult: {
        outcome: "proposed",
        state: {
          appliedActionKeys: [cancellationAction.actionKey],
          reviews: [],
        },
      },
    });
    expect(cancelled.planId).not.toBeNull();
    expect(cancelled.plannerResult.state.actionEvidence).toHaveLength(1);
    expect(cancelled.plannerResult.state.actionEvidence[0]).toMatchObject({
      actionKey: cancellationAction.actionKey,
      action: cancellationAction,
    });
    expect(cancelled.plannerResult.state.actionEvidence[0].actionHash).toMatch(/^[0-9a-f]{64}$/);

    const persistedGraph = await repository.withSerializableTransaction(async (transaction) => ({
      plan: await transaction.loadPlanByVersion(cancelled.groupId, 2),
      entries: await transaction.loadPlanEntries(cancelled.planId!),
      intents: await transaction.loadPlanIntents(cancelled.planId!),
      effectOutbox: await transaction.loadPlanEffectOutbox(cancelled.planId!),
    }));
    expect(persistedGraph.plan).not.toBeNull();
    expect(persistedGraph.plan?.plannerVersion).toBe(PACKAGE_ALLOCATION_PLANNER_VERSION);
    expect(persistedGraph.plan?.plannerVersion).toBe("package-allocation-group-v2");
    expect(persistedGraph.plan?.stateSnapshot).toEqual(cancelled.plannerResult.state);
    expect(persistedGraph.plan?.reviewSnapshot).toEqual({
      contractVersion: 1,
      reviews: [],
    });
    expect(persistedGraph.entries).toEqual(
      cancelled.plannerResult.ledgerEntriesToAppend.map(expectedEntry),
    );
    expect(persistedGraph.intents).toEqual(
      cancelled.plannerResult.effectIntentsToAppend.map(expectedIntent),
    );
    expect(persistedGraph.effectOutbox).toEqual(
      cancelled.plannerResult.effectIntentsToAppend.map(expectedEffectOutbox),
    );

    const conservation = await pool.query<{
      source_wms_shipment_item_id: number;
      total_primary_quantity: number;
      awaiting_relabel_quantity: number;
      held_for_unpack_quantity: number;
    }>(
      `SELECT
         source.source_wms_shipment_item_id,
         COALESCE(SUM(entry.quantity) FILTER (
           WHERE entry.allocation_kind = 'primary_transfer'
         ), 0)::integer AS total_primary_quantity,
         COALESCE(SUM(entry.quantity) FILTER (
           WHERE entry.allocation_kind = 'primary_transfer'
             AND entry.target_kind = 'awaiting_relabel'
         ), 0)::integer AS awaiting_relabel_quantity,
         COALESCE(SUM(entry.quantity) FILTER (
           WHERE entry.allocation_kind = 'primary_transfer'
             AND entry.target_kind = 'held_for_unpack'
         ), 0)::integer AS held_for_unpack_quantity
       FROM wms.package_allocation_entries AS entry
       JOIN wms.package_allocation_source_lines AS source
         ON source.id = entry.package_allocation_source_line_id
       WHERE entry.package_allocation_plan_id = $1::bigint
       GROUP BY source.source_wms_shipment_item_id`,
      [cancelled.planId],
    );
    expect(conservation.rows).toEqual([{
      source_wms_shipment_item_id: sourceId,
      total_primary_quantity: 2,
      awaiting_relabel_quantity: 1,
      held_for_unpack_quantity: 1,
    }]);

    const countsBeforeReplay = await loadLedgerCounts(pool);
    expect(countsBeforeReplay).toEqual({
      groups: 1,
      sourceLines: 1,
      memberships: 1,
      allocationKeys: 1,
      packageBindings: 1,
      plans: 2,
      entries:
        initial.plannerResult.ledgerEntriesToAppend.length
        + cancelled.plannerResult.ledgerEntriesToAppend.length,
      intents:
        initial.plannerResult.effectIntentsToAppend.length
        + cancelled.plannerResult.effectIntentsToAppend.length,
      effectOutbox:
        initial.plannerResult.effectIntentsToAppend.length
        + cancelled.plannerResult.effectIntentsToAppend.length,
    });

    const replay = await service.persist(structuredClone(cancellationCommand));

    expect(replay).toMatchObject({
      kind: "already_persisted",
      groupId: cancelled.groupId,
      planId: cancelled.planId,
      persistedPlanVersion: 2,
      currentGroupVersion: 2,
    });
    expect(replay.plannerResult.state).toEqual(cancelled.plannerResult.state);
    expect(await loadLedgerCounts(pool)).toEqual(countsBeforeReplay);
  });

  it("rolls back every ledger row when a deferred failure occurs after CAS", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-ROLLBACK", 2);
    const service = new PackageAllocationPlanningService(
      new PgPackageAllocationLedgerRepository(pool),
    );
    let observedError: unknown = null;
    try {
      await pool.query(
        `CREATE OR REPLACE FUNCTION wms.test_fail_package_allocation_deferred_check()
         RETURNS trigger
         LANGUAGE plpgsql
         AS $test$
         BEGIN
           RAISE EXCEPTION 'injected deferred package-allocation failure'
             USING ERRCODE = 'P0001';
         END;
         $test$`,
      );
      await pool.query(
        `CREATE CONSTRAINT TRIGGER trg_zz_test_package_allocation_deferred_failure
         AFTER UPDATE OF current_version ON wms.package_allocation_groups
         DEFERRABLE INITIALLY DEFERRED
         FOR EACH ROW
         EXECUTE FUNCTION wms.test_fail_package_allocation_deferred_check()`,
      );
      try {
        await service.persist(commandFor(sourceId));
      } catch (error) {
        observedError = error;
      }
    } finally {
      await pool.query(
        `DROP TRIGGER IF EXISTS trg_zz_test_package_allocation_deferred_failure
         ON wms.package_allocation_groups`,
      );
      await pool.query(
        "DROP FUNCTION IF EXISTS wms.test_fail_package_allocation_deferred_check()",
      );
    }

    expect(observedError).toMatchObject({
      name: "PackageAllocationLedgerRepositoryError",
      code: "DATABASE_ERROR",
      context: { postgresCode: "P0001" },
    });
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(9).fill(0));
  });

  it("settles identical concurrent commands as one plan and one exact replay", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-RACE-SAME", 2);
    const telemetry: RepositoryTelemetry = { beginCount: 0, postgresCodes: [] };
    const hook = firstWaveBarrier(
      "same-group first-wave snapshots",
      ({ text, values }) => (
        text.includes("pg_advisory_xact_lock(hashtextextended")
        && values[0] === `package-allocation-group:${PRIMARY_GROUP_KEY}`
      ),
      "SELECT COUNT(*) FROM wms.package_allocation_groups",
    );
    const service = new PackageAllocationPlanningService(
      new PgPackageAllocationLedgerRepository(instrumentedPool(pool, telemetry, hook)),
    );
    const command = commandFor(sourceId);

    const settled = await Promise.allSettled([
      service.persist(structuredClone(command)),
      service.persist(structuredClone(command)),
    ]);
    const fulfilled = fulfilledValues(settled);

    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    expect(fulfilled.map((result) => result.kind).sort()).toEqual([
      "already_persisted",
      "created",
    ]);
    expect(new Set(fulfilled.map((result) => result.planId)).size).toBe(1);
    expect(telemetry.beginCount).toBe(3);
    expect(telemetry.postgresCodes).toContain("40001");

    const counts = await loadLedgerCounts(pool);
    expect(counts.groups).toBe(1);
    expect(counts.plans).toBe(1);
    expect(counts.memberships).toBe(1);
    expect(counts.packageBindings).toBe(1);
    expect(counts.effectOutbox).toBe(counts.intents);
  }, CONCURRENCY_TEST_TIMEOUT_MS);

  it("allows only one group to claim a source under a controlled concurrent race", async () => {
    const sourceId = await seedCustomerFulfillmentSource(pool, "SKU-RACE-SOURCE", 2);
    const telemetry: RepositoryTelemetry = { beginCount: 0, postgresCodes: [] };
    const hook = firstWaveBarrier(
      "same-source first-wave snapshots",
      ({ text, values }) => (
        text === "SELECT pg_advisory_xact_lock($1, $2)"
        && Number(values[1]) === sourceId
      ),
      "SELECT COUNT(*) FROM wms.package_allocation_source_lines",
    );
    const service = new PackageAllocationPlanningService(
      new PgPackageAllocationLedgerRepository(instrumentedPool(pool, telemetry, hook)),
    );
    const first = commandFor(sourceId);
    const second = commandFor(sourceId, {
      groupKey: COMPETING_GROUP_KEY,
      packageKey: "package-b",
      providerPhysicalShipmentId: "44002",
      trackingNumber: "1Z0000000000044002",
    });

    const settled = await Promise.allSettled([
      service.persist(first),
      service.persist(second),
    ]);
    const fulfilled = fulfilledValues(settled);
    const rejected = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0].kind).toBe("created");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      name: "PackageAllocationLedgerRepositoryError",
      code: "LEDGER_INVARIANT_VIOLATION",
      context: {
        postgresCode: "23505",
        constraint: "uq_package_allocation_group_source_lines_source",
      },
    });
    expect(telemetry.postgresCodes).toContain("23505");

    const counts = await loadLedgerCounts(pool);
    expect(counts.groups).toBe(1);
    expect(counts.sourceLines).toBe(1);
    expect(counts.memberships).toBe(1);
    expect(counts.packageBindings).toBe(1);
    expect(counts.plans).toBe(1);
    expect(counts.entries).toBe(
      fulfilled[0].plannerResult.ledgerEntriesToAppend.length,
    );
    expect(counts.intents).toBe(
      fulfilled[0].plannerResult.effectIntentsToAppend.length,
    );
    expect(counts.effectOutbox).toBe(counts.intents);
  }, CONCURRENCY_TEST_TIMEOUT_MS);
});
