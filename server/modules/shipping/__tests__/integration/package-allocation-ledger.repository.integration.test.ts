import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  it,
} from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";

import {
  closeTestDb,
  describeWithDisposableDb,
  getTestPool,
  runMigrations,
  truncateTestData,
} from "../../../../../test/setup-integration";
import type {
  PackageAllocationEffectIntentV1,
  PackageAllocationEntryV1,
} from "../../package-allocation-group.domain";
import { packageAllocationPackageKey } from "../../package-allocation-authority-resolution.domain";
import { PackageAllocationAuthorityReadinessService } from "../../package-allocation-authority-readiness.service";
import { PackageAllocationAuthorityResolutionPreviewService } from "../../package-allocation-authority-resolution.service";
import {
  PgPackageAllocationLedgerRepository,
  type PersistedPackageAllocationEntry,
  type PersistedPackageAllocationIntent,
} from "../../package-allocation-ledger.repository";
import {
  PACKAGE_ALLOCATION_PLANNER_VERSION,
  PackageAllocationPlanningService,
  type PersistPackageAllocationPlanCommand,
  type PersistPackageAllocationPlanResult,
} from "../../package-allocation-planning.service";

const PRIMARY_GROUP_KEY = "86e1be0d-c7d8-4c91-919f-04f5eb547f79";
const COMPETING_GROUP_KEY = "96e1be0d-c7d8-4c91-919f-04f5eb547f80";
const CONCURRENCY_TEST_TIMEOUT_MS = 20_000;
const BARRIER_TIMEOUT_MS = 5_000;

interface LedgerCounts {
  readonly groups: number;
  readonly sourceLines: number;
  readonly memberships: number;
  readonly allocationKeys: number;
  readonly packageBindings: number;
  readonly plans: number;
  readonly entries: number;
  readonly intents: number;
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

async function installAuthorityReadinessTestRelations(pool: Pool): Promise<void> {
  await pool.query(`
    ALTER TABLE wms.shipping_provider_labels
      ADD COLUMN provider varchar(40) NOT NULL,
      ADD COLUMN provider_label_id varchar(200) NOT NULL,
      ADD COLUMN provider_order_id varchar(200),
      ADD COLUMN provider_order_key varchar(200),
      ADD COLUMN tracking_number varchar(200) NOT NULL,
      ADD COLUMN label_status varchar(30) NOT NULL,
      ADD COLUMN label_direction varchar(20) NOT NULL,
      ADD COLUMN first_observed_at timestamptz NOT NULL,
      ADD COLUMN last_observed_at timestamptz NOT NULL;

    CREATE TABLE wms.shipping_provider_label_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      shipping_provider_label_id bigint NOT NULL
        REFERENCES wms.shipping_provider_labels(id) ON DELETE RESTRICT,
      event_hash varchar(64) NOT NULL,
      event_type varchar(40) NOT NULL,
      label_status varchar(30) NOT NULL,
      tracking_number varchar(200) NOT NULL,
      provider_occurred_at timestamptz,
      received_at timestamptz NOT NULL,
      sanitized_payload jsonb NOT NULL
    );

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

async function seedAuthorityReadinessLabel(
  pool: Pool,
  sourceId: number,
  options: {
    readonly providerLabelId?: string;
    readonly trackingNumber?: string;
    readonly providerOrderId?: string;
    readonly contentsStatus?: "authoritative" | "empty";
  } = {},
): Promise<number> {
  const trackingNumber = options.trackingNumber ?? "1Z999AA10123456784";
  const providerLabelId = options.providerLabelId ?? "44001";
  const receivedAt = "2026-08-23T14:00:00.000Z";
  const hasAuthoritativeContents = (options.contentsStatus ?? "authoritative") === "authoritative";
  const payload = {
    payloadSchemaVersion: 2,
    providerLabelId,
    trackingNumber,
    observationSource: "shipstation_shipment_observation",
    sourceObservationHash: "f".repeat(64),
    createDate: null,
    shipDate: null,
    voidDate: null,
    isReturnLabel: false,
    declaredContentsEvidence: {
      evidenceSchemaVersion: 1,
      status: hasAuthoritativeContents ? "authoritative" : "empty",
      providerItemCount: hasAuthoritativeContents ? 1 : 0,
      recognizedProviderItemCount: hasAuthoritativeContents ? 1 : 0,
      canonicalLineCount: hasAuthoritativeContents ? 1 : 0,
      malformedItemCount: 0,
      unrecognizedItemCount: 0,
      duplicateLineItemCount: 0,
      rejectedItemCount: 0,
      reviewRequired: !hasAuthoritativeContents,
      lines: hasAuthoritativeContents
        ? [{ lineItemKey: `wms-item-${sourceId}`, quantity: 2 }]
        : [],
    },
  };
  const label = await pool.query<{ id: string }>(
    `INSERT INTO wms.shipping_provider_labels (
       provider, provider_label_id, provider_order_id, tracking_number,
       label_status, label_direction, first_observed_at, last_observed_at
     ) VALUES ('shipstation', $1, $2, $3, 'active', 'outbound', $4, $4)
     RETURNING id::text AS id`,
    [providerLabelId, options.providerOrderId ?? null, trackingNumber, receivedAt],
  );
  const labelId = positiveSafeIntegerFromPostgres(
    label.rows[0].id,
    "shipping_provider_labels.id",
  );
  const eventHash = createHash("sha256").update(canonicalJson({
    provider: "shipstation",
    ...payload,
    labelStatus: "active",
  })).digest("hex");
  await pool.query(
    `INSERT INTO wms.shipping_provider_label_events (
       shipping_provider_label_id, event_hash, event_type, label_status,
       tracking_number, provider_occurred_at, received_at, sanitized_payload
     ) VALUES ($1, $2, 'label_observed', 'active', $3, NULL, $4, $5::jsonb)`,
    [labelId, eventHash, trackingNumber, receivedAt, JSON.stringify(payload)],
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
       (SELECT COUNT(*)::integer FROM wms.package_allocation_effect_intents) AS "intents"`,
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

function fulfilledValues(
  results: readonly PromiseSettledResult<PersistPackageAllocationPlanResult>[],
): PersistPackageAllocationPlanResult[] {
  return results.flatMap((result) => (
    result.status === "fulfilled" ? [result.value] : []
  ));
}

describeWithDisposableDb("Package allocation ledger PostgreSQL guarantees", () => {
  let pool: Pool;

  beforeAll(async () => {
    await runMigrations();
    pool = getTestPool();
    await installAuthorityReadinessTestRelations(pool);
  }, 30_000);

  beforeEach(async () => {
    await truncateTestData();
  });

  afterAll(async () => {
    await closeTestDb();
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
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(8).fill(0));
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
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(8).fill(0));
  });

  it("discovers a related empty sibling package without granting it item authority", async () => {
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
    });
    await seedAuthorityDiscoveryRelations(
      pool,
      sourceId,
      primaryLabelId,
      providerOrderId,
    );
    const service = new PackageAllocationAuthorityResolutionPreviewService(
      new PgPackageAllocationLedgerRepository(pool),
    );

    const result = await service.previewDiscovered({
      contractVersion: 1,
      authorityMode: "shadow_only",
      previewMode: "bootstrap_relationship_discovery",
      groupKey: PRIMARY_GROUP_KEY,
      sourceWmsShipmentItemIds: [sourceId],
    });

    expect(result).toMatchObject({
      contractVersion: 1,
      authority: "none",
      outcome: "review",
      previewMode: "bootstrap_relationship_discovery",
      selectionAuthority: "database_relationship_closure",
      selectionCompleteness: "unproven_outside_persisted_relationships",
      selectedShippingProviderLabelIds: [primaryLabelId, emptySiblingLabelId],
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
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(8).fill(0));
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
    }));
    expect(persistedGraph.entries).toEqual(
      created.plannerResult.ledgerEntriesToAppend.map(expectedEntry),
    );
    expect(persistedGraph.intents).toEqual(
      created.plannerResult.effectIntentsToAppend.map(expectedIntent),
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
    expect(Object.values(await loadLedgerCounts(pool))).toEqual(Array(8).fill(0));
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
  }, CONCURRENCY_TEST_TIMEOUT_MS);
});
