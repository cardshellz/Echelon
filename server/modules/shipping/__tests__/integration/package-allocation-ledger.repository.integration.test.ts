import type { Pool, PoolClient } from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  expect,
  it,
} from "vitest";

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
import {
  PgPackageAllocationLedgerRepository,
  type PersistedPackageAllocationEntry,
  type PersistedPackageAllocationIntent,
} from "../../package-allocation-ledger.repository";
import {
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
  }, 30_000);

  beforeEach(async () => {
    await truncateTestData();
  });

  afterAll(async () => {
    await closeTestDb();
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
