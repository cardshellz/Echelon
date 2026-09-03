import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient } from "pg";

import * as schema from "@shared/schema";
import { claimPlanSchema } from "@shared/types/inventory-availability-planner";

import { pool as defaultPool } from "../../../db";
import {
  createReservationService,
  type ChannelSync,
  type DrizzleDb,
  type RecipeBuildPromise,
  type ReservationServiceContract,
} from "../../channels/reservation.service";
import { createLegacyInventoryAtpService } from "../../inventory/atp.service";
import { InventoryAvailabilityClaimService } from "../application/inventory-availability-claim.service";
import {
  AuthorityAwareReservationService,
  InventoryAvailabilityRuntimeClaimError,
  type CanonicalClaimCursor,
  type CanonicalClaimStatus,
  type CanonicalClaimVariantMetadata,
  type InventoryAvailabilityRuntimeClaimContext,
  type InventoryAvailabilityRuntimeClaimExecutor,
} from "../application/inventory-availability-runtime-claim.service";

type ClientPool = Pick<Pool, "connect"> & {
  options?: { max?: number };
};

interface RuntimeAuthorityRow {
  authority: string;
  authority_revision: string;
  activation_run_id: string | null;
}

interface ClaimCursorRow {
  id: string;
  revision: number;
  status: string;
  plan_payload: unknown;
}

interface ValidatedRuntimeAuthority {
  authority: "legacy" | "canonical";
  authorityRevision: string;
  activationRunId: string | null;
}

/**
 * Pins legacy authority until the selected reservation operation commits and
 * binds every legacy database operation to that same connection. Once
 * canonical authority is observed, the authority transaction is released
 * before invoking the canonical serializable writer: migration 0638 makes the
 * canonical transition irreversible, so that route cannot become legacy
 * between selection and commit.
 */
export class PostgresInventoryAvailabilityRuntimeClaimExecutor
implements InventoryAvailabilityRuntimeClaimExecutor {
  private readonly routingSlots: AsyncSemaphore;

  constructor(
    private readonly legacy: ReservationServiceContract,
    private readonly canonical: InventoryAvailabilityClaimService,
    private readonly connectionPool: ClientPool = defaultPool,
  ) {
    assertNestedConnectionCapacity(connectionPool);
    this.routingSlots = new AsyncSemaphore(routingConcurrency(connectionPool));
  }

  async execute<T>(
    work: (context: InventoryAvailabilityRuntimeClaimContext) => Promise<T>,
  ): Promise<T> {
    const releaseRoutingSlot = await this.routingSlots.acquire();
    let routingSlotReleased = false;
    let client: PoolClient | null = null;
    let began = false;
    let released = false;
    try {
      const connectedClient = await this.connectionPool.connect();
      client = connectedClient;
      await connectedClient.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      began = true;
      const authority = await loadAndLockRuntimeAuthority(connectedClient);
      if (authority.authority === "canonical") {
        await connectedClient.query("COMMIT");
        began = false;
        released = true;
        connectedClient.release();
        releaseRoutingSlot();
        routingSlotReleased = true;
        return work(canonicalContext(authority, this.canonical, this.connectionPool));
      }

      const transactionDb = drizzle(connectedClient, { schema });
      const result = await work({
        authority: authority.authority,
        authorityRevision: authority.authorityRevision,
        activationRunId: authority.activationRunId,
        legacy: bindLegacyReservationToTransaction(this.legacy, transactionDb),
        canonical: this.canonical,
        getLatestClaim: (orderId) => getLatestClaim(connectedClient, orderId),
        getVariantMetadata: (productVariantIds) => getVariantMetadata(connectedClient, productVariantIds),
        getOrderIdByShopifyOrderId: (shopifyOrderId) =>
          getOrderIdByShopifyOrderId(connectedClient, shopifyOrderId),
      });
      await connectedClient.query("COMMIT");
      began = false;
      return result;
    } catch (error) {
      if (began && client) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            "Inventory reservation runtime operation and authority-lock rollback both failed.",
          );
        }
      }
      throw error;
    } finally {
      if (client && !released) client.release();
      if (!routingSlotReleased) releaseRoutingSlot();
    }
  }
}

class AsyncSemaphore {
  private inUse = 0;
  private readonly waiters: Array<(release: () => void) => void> = [];

  constructor(private readonly capacity: number) {}

  async acquire(): Promise<() => void> {
    if (this.inUse >= this.capacity) {
      return new Promise<() => void>((resolve) => this.waiters.push(resolve));
    }
    this.inUse += 1;
    return this.createRelease();
  }

  private createRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (waiter) {
        waiter(this.createRelease());
        return;
      }
      this.inUse -= 1;
    };
  }
}

function bindLegacyReservationToTransaction(
  legacy: ReservationServiceContract,
  transactionDb: DrizzleDb,
): ReservationServiceContract {
  return {
    reserveForOrder: (
      productId,
      variantId,
      orderQty,
      orderId,
      orderItemId,
      userId,
      dbOverride,
    ) => {
      rejectExternalTransaction(dbOverride);
      return legacy.reserveForOrder(
        productId,
        variantId,
        orderQty,
        orderId,
        orderItemId,
        userId,
        transactionDb,
      );
    },
    reserveOrder: (orderId, userId, dbOverride) => {
      rejectExternalTransaction(dbOverride);
      return legacy.reserveOrder(orderId, userId, transactionDb);
    },
    releaseOrderReservation: (orderId, reason, userId, options) => {
      rejectExternalTransaction(options?.dbOverride);
      return legacy.releaseOrderReservation(orderId, reason, userId, {
        ...options,
        dbOverride: transactionDb,
      });
    },
    releaseOrderItemReservation: (params) => {
      rejectExternalTransaction(params.dbOverride);
      return legacy.releaseOrderItemReservation({ ...params, dbOverride: transactionDb });
    },
    reconcileOrderDemand: (command) => {
      rejectExternalTransaction(command.dbOverride);
      return legacy.reconcileOrderDemand({ ...command, dbOverride: transactionDb });
    },
    reconcileRefundOrderDemand: (command) => {
      rejectExternalTransaction(command.dbOverride);
      return legacy.reconcileRefundOrderDemand({ ...command, dbOverride: transactionDb });
    },
    reallocateOrphaned: (
      productVariantId,
      warehouseLocationId,
      userId,
      orphanedQty,
      dbOverride,
    ) => {
      rejectExternalTransaction(dbOverride);
      return legacy.reallocateOrphaned(
        productVariantId,
        warehouseLocationId,
        userId,
        orphanedQty,
        transactionDb,
      );
    },
    getOrderReservationStatus: (orderId, dbOverride) => {
      rejectExternalTransaction(dbOverride);
      return legacy.getOrderReservationStatus(orderId, transactionDb);
    },
    autoReserveOnSync: (shopifyOrderId, userId, dbOverride) => {
      rejectExternalTransaction(dbOverride);
      return legacy.autoReserveOnSync(shopifyOrderId, userId, transactionDb);
    },
  };
}

function canonicalContext(
  authority: ValidatedRuntimeAuthority,
  canonical: InventoryAvailabilityClaimService,
  connectionPool: ClientPool,
): InventoryAvailabilityRuntimeClaimContext {
  return {
    authority: authority.authority,
    authorityRevision: authority.authorityRevision,
    activationRunId: authority.activationRunId,
    legacy: unavailableLegacyService(),
    canonical,
    getLatestClaim: (orderId) => withClient(
      connectionPool,
      (client) => getLatestClaim(client, orderId),
    ),
    getVariantMetadata: (productVariantIds) => withClient(
      connectionPool,
      (client) => getVariantMetadata(client, productVariantIds),
    ),
    getOrderIdByShopifyOrderId: (shopifyOrderId) => withClient(
      connectionPool,
      (client) => getOrderIdByShopifyOrderId(client, shopifyOrderId),
    ),
  };
}

async function withClient<T>(
  connectionPool: ClientPool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await connectionPool.connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

function rejectExternalTransaction(dbOverride: unknown): void {
  if (dbOverride == null) return;
  throw new InventoryAvailabilityRuntimeClaimError(
    "LEGACY_EXTERNAL_RESERVATION_TRANSACTION_UNSUPPORTED",
    "The authority-aware reservation boundary owns its transaction and cannot join a caller-owned transaction.",
  );
}

function unavailableLegacyService(): ReservationServiceContract {
  return new Proxy({} as ReservationServiceContract, {
    get() {
      throw new InventoryAvailabilityRuntimeClaimError(
        "LEGACY_RESERVATION_AUTHORITY_INACTIVE",
        "Legacy reservation operations are unavailable after canonical authority is active.",
      );
    },
  });
}

function assertNestedConnectionCapacity(connectionPool: ClientPool): void {
  const max = connectionPool.options?.max;
  if (max !== 1) return;
  throw new InventoryAvailabilityRuntimeClaimError(
    "INVENTORY_CLAIM_RUNTIME_POOL_TOO_SMALL",
    "Inventory claim routing requires at least two database connections for post-commit side effects.",
    { configuredPoolMax: max },
  );
}

function routingConcurrency(connectionPool: ClientPool): number {
  const max = connectionPool.options?.max;
  if (!Number.isInteger(max) || Number(max) <= 1) return 1;
  return Math.max(1, Math.floor(Number(max) / 2));
}

export function createAuthorityAwareReservationService(
  dependencies: {
    db: DrizzleDb;
    inventoryCore: any;
    channelSync: ChannelSync;
    recipeBuildPromise?: RecipeBuildPromise;
    canonical: InventoryAvailabilityClaimService;
  },
  connectionPool: ClientPool = defaultPool,
): AuthorityAwareReservationService {
  // This calculator is reachable only after the executor has pinned legacy
  // authority. It avoids nesting a second authority transaction (and pool
  // connection) inside one reservation operation.
  const legacyAtp = createLegacyInventoryAtpService(dependencies.db);
  const legacy = createReservationService(
    dependencies.db,
    dependencies.inventoryCore,
    dependencies.channelSync,
    legacyAtp,
    dependencies.recipeBuildPromise,
  );
  return new AuthorityAwareReservationService(
    new PostgresInventoryAvailabilityRuntimeClaimExecutor(
      legacy,
      dependencies.canonical,
      connectionPool,
    ),
  );
}

async function loadAndLockRuntimeAuthority(client: PoolClient): Promise<{
  authority: "legacy" | "canonical";
  authorityRevision: string;
  activationRunId: string | null;
}> {
  const result = await client.query<RuntimeAuthorityRow>(
    `SELECT authority,
            revision::text AS authority_revision,
            activation_run_id::text AS activation_run_id
     FROM inventory.availability_runtime_authority
     WHERE singleton_key = true
     FOR SHARE`,
  );
  const row = result.rows[0];
  if (!row || (row.authority !== "legacy" && row.authority !== "canonical")) {
    throw invalidAuthority(row);
  }
  const authorityRevision = String(row.authority_revision);
  if (!/^[1-9][0-9]*$/.test(authorityRevision)) throw invalidAuthority(row);
  const activationRunId = row.activation_run_id == null ? null : String(row.activation_run_id);
  if ((row.authority === "legacy" && activationRunId !== null)
    || (row.authority === "canonical"
      && (activationRunId === null || !/^[1-9][0-9]*$/.test(activationRunId)))) {
    throw invalidAuthority(row);
  }
  return { authority: row.authority, authorityRevision, activationRunId };
}

async function getLatestClaim(
  client: PoolClient,
  orderId: number,
): Promise<CanonicalClaimCursor | null> {
  const result = await client.query<ClaimCursorRow>(
    `SELECT id::text AS id, revision, status, plan_payload
     FROM inventory.availability_claims
     WHERE order_id = $1
     ORDER BY revision DESC, id DESC
     LIMIT 1`,
    [orderId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const claimId = String(row.id);
  const revision = Number(row.revision);
  const status = String(row.status);
  if (!/^[1-9][0-9]*$/.test(claimId)
    || !Number.isSafeInteger(revision)
    || revision <= 0
    || !isClaimStatus(status)) {
    throw new InventoryAvailabilityRuntimeClaimError(
      "CANONICAL_CLAIM_CURSOR_INVALID",
      "The latest canonical claim cursor contains invalid database evidence.",
      { orderId, claimId, revision: row.revision, status },
    );
  }
  const parsedPlan = claimPlanSchema.safeParse(row.plan_payload);
  if (!parsedPlan.success) {
    throw new InventoryAvailabilityRuntimeClaimError(
      "CANONICAL_CLAIM_CURSOR_INVALID",
      "The latest canonical claim cursor contains an invalid planner payload.",
      { orderId, claimId, issues: parsedPlan.error.issues.map((issue) => issue.message) },
    );
  }
  return { claimId, revision, status, plan: parsedPlan.data };
}

async function getVariantMetadata(
  client: PoolClient,
  productVariantIds: readonly number[],
): Promise<Map<number, CanonicalClaimVariantMetadata>> {
  if (productVariantIds.length === 0) return new Map();
  const result = await client.query<{
    id: number;
    sku: string;
    units_per_variant: number;
  }>(
    `SELECT id, sku, units_per_variant
     FROM catalog.product_variants
     WHERE id = ANY($1::integer[])
     ORDER BY id`,
    [productVariantIds],
  );
  const metadata = new Map<number, CanonicalClaimVariantMetadata>();
  for (const row of result.rows) {
    const productVariantId = positiveInteger(row.id, "productVariant.id");
    const unitsPerVariant = positiveInteger(row.units_per_variant, "productVariant.unitsPerVariant");
    const sku = String(row.sku ?? "").trim();
    if (!sku) {
      throw new InventoryAvailabilityRuntimeClaimError(
        "CANONICAL_CLAIM_VARIANT_METADATA_INVALID",
        "Canonical claim variant metadata contains a blank SKU.",
        { productVariantId },
      );
    }
    metadata.set(productVariantId, { productVariantId, sku, unitsPerVariant });
  }
  return metadata;
}

async function getOrderIdByShopifyOrderId(
  client: PoolClient,
  shopifyOrderId: string,
): Promise<number | null> {
  const result = await client.query<{ id: number }>(
    `SELECT id
     FROM wms.orders
     WHERE shopify_order_id = $1
       AND warehouse_status NOT IN ('cancelled', 'shipped')
     ORDER BY id
     LIMIT 1`,
    [shopifyOrderId],
  );
  return result.rows[0] ? positiveInteger(result.rows[0].id, "order.id") : null;
}

function isClaimStatus(value: string): value is CanonicalClaimStatus {
  return ["active", "released", "cancelled", "superseded", "failed"].includes(value);
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new InventoryAvailabilityRuntimeClaimError(
      "CANONICAL_CLAIM_RUNTIME_DATABASE_EVIDENCE_INVALID",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return parsed;
}

function invalidAuthority(row: RuntimeAuthorityRow | undefined): InventoryAvailabilityRuntimeClaimError {
  return new InventoryAvailabilityRuntimeClaimError(
    "INVENTORY_CLAIM_RUNTIME_AUTHORITY_INVALID",
    "The inventory claim runtime authority singleton is missing or invalid.",
    {
      authority: row?.authority ?? null,
      authorityRevision: row?.authority_revision ?? null,
      activationRunId: row?.activation_run_id ?? null,
    },
  );
}
