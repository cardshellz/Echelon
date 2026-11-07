import type { Pool, PoolClient } from "pg";

import {
  SALES_STATUS_LIST_LIMIT,
  salesStatusChangeResultSchema,
  salesStatusListSchema,
  salesStatusProductViewSchema,
  type SalesStatus,
  type SalesStatusChangeResult,
  type SalesStatusList,
  type SalesStatusProductView,
  type SalesStatusScope,
} from "@shared/types/inventory-sales-status";

import { pool as defaultPool } from "../../../db";
import { InventoryAvailabilityRuntimePublicationError } from "../application/inventory-availability-runtime-publication.service";
import { InventoryChannelExposureRuntimeError } from "../application/inventory-channel-exposure-runtime.service";
import type { SalesStatusCommand, SalesStatusStore } from "../application/inventory-sales-status.service";
import {
  affectedSalesStatusProductIds,
  planSalesStatusChanges,
  SalesStatusError,
  type CurrentSalesStatus,
  type SalesStatusOperation,
} from "../domain/inventory-sales-status";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";
import { loadSalesStatusEntriesForProduct, salesStatusEntryFromRow, type SalesStatusRow } from "./inventory-sales-status.reader";
import { markPublicationProductChanged } from "./publication-product-change";

/**
 * Writes sales status changes (shared/types/inventory-sales-status.ts).
 *
 * One SERIALIZABLE transaction claims the idempotency key, checks every scope
 * against the revision its operator saw, writes the settings and one
 * append-only history row per changed scope, and republishes the affected
 * products, so a change and the stock updates it causes commit together or
 * not at all. SERIALIZABLE because the transaction-scoped publisher requires
 * it. The status rows are this command's own; it never touches another
 * holder's hold, which is how Dropship and Walmart holds stay independent.
 */

const RECEIPT_PREFIX = "inventory-sales-status:";
const COMMAND_TYPE = "inventory_sales_status_change";
const PRODUCT_SAVEPOINT = "sales_status_product";

/**
 * Up to this many products are republished inside the command, so their stock
 * updates are queued the moment it commits and the operator sees which
 * destinations were skipped. A larger change marks its products for the
 * stock-update worker instead (inventory.publication_selection_work), which
 * plans each product in its own transaction, 25 products per 15-second tick:
 * one long serializable transaction across many products would collide with
 * every pick, receipt and count that touches them.
 */
export const SALES_STATUS_INLINE_REPUBLISH_MAX_PRODUCTS = 10;

/**
 * SQLSTATEs that mean "nothing was saved; the same command can be retried":
 * serialization failure, deadlock, lock timeout, a concurrent insert of the
 * same key or scope, and a statement timeout.
 */
const RETRYABLE_SQLSTATES: ReadonlySet<string> = new Set(["40001", "40P01", "55P03", "23505", "57014"]);

type Outcome = {
  scopeKey: string;
  scope: SalesStatusScope;
  before: { status: SalesStatus; revision: string } | null;
  after: { status: SalesStatus; revision: string } | null;
  changed: boolean;
};

type Republication = Pick<SalesStatusChangeResult, "republished" | "queued">;

interface StoredSetting extends CurrentSalesStatus {
  id: number;
}

export class PostgresSalesStatusStore implements SalesStatusStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = defaultPool) {}

  async change(command: SalesStatusCommand): Promise<SalesStatusChangeResult> {
    const client = await this.connectionPool.connect();
    let inTransaction = false;
    let discard: Error | undefined;
    try {
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE");
      inTransaction = true;
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '60s'");
      const receiptKey = `${RECEIPT_PREFIX}${command.idempotencyKey}`;
      const replay = await loadReplay(client, receiptKey, command.requestHash);
      if (replay) {
        await client.query("COMMIT");
        inTransaction = false;
        return replay;
      }
      // Claimed before any write: a concurrent retry of the same key blocks on
      // this row and then fails retryably, so one key never writes twice.
      await client.query(
        `INSERT INTO public.idempotency_keys(key, request_hash, response_body, created_at, expires_at)
         VALUES ($1, $2, NULL, $3, NULL)`,
        [receiptKey, command.requestHash, command.occurredAt],
      );
      await requireCanonicalAuthority(client);
      const scopes = command.changes.map((change) => change.scope);
      await validateScopes(client, scopes);
      const current = await lockCurrentSettings(client, scopes);
      const plan = planSalesStatusChanges(current, command.changes);
      if (!plan.ok) {
        throw new SalesStatusError(409, "SALES_STATUS_CHANGED",
          "Someone changed this sales status first. Nothing was saved; reload to see the current status.", "permanent",
          { conflicts: plan.conflicts });
      }
      const outcomes: Outcome[] = [];
      for (const operation of plan.operations) {
        outcomes.push(await applyOperation(client, operation, current, command));
      }
      const affectedProductIds = affectedSalesStatusProductIds(
        outcomes.filter((outcome) => outcome.changed).map((outcome) => outcome.scope),
      );
      const republication = await republishProducts(client, affectedProductIds);
      const result = salesStatusChangeResultSchema.parse({
        changes: outcomes,
        affectedProductIds,
        ...republication,
        alreadyApplied: false,
        providerWriteAttempted: false,
      });
      await client.query(
        "UPDATE public.idempotency_keys SET response_body = $2::jsonb WHERE key = $1",
        [receiptKey, JSON.stringify({ commandType: COMMAND_TYPE, result })],
      );
      await client.query("COMMIT");
      inTransaction = false;
      return result;
    } catch (error) {
      if (inTransaction) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        }
      }
      throw classifyFailure(error);
    } finally {
      client.release(discard);
    }
  }

  readProduct(productId: number): Promise<SalesStatusProductView> {
    return this.readOnly(async (client) => {
      const product = (await client.query<{ id: number; sku: string | null; name: string }>(
        "SELECT id, sku, name FROM catalog.products WHERE id = $1",
        [productId],
      )).rows[0];
      if (!product) {
        throw new SalesStatusError(404, "SALES_STATUS_PRODUCT_NOT_FOUND", "Product not found.", "permanent", { productId });
      }
      const authority = await readAuthority(client);
      const variants = (await client.query<{
        id: number; sku: string | null; name: string; units_per_variant: number; sellable: boolean;
      }>(
        `SELECT id, sku, name, units_per_variant,
                (is_active AND requires_shipping AND COALESCE(track_inventory, true)
                  AND sales_eligibility = 'sellable') IS TRUE AS sellable
         FROM catalog.product_variants
         WHERE product_id = $1
         ORDER BY units_per_variant, id`,
        [productId],
      )).rows;
      const channels = (await client.query<{
        id: number; name: string; provider: string; status: string; publishes_stock: boolean;
      }>(
        `SELECT channel.id, channel.name, channel.provider, channel.status,
                EXISTS (
                  SELECT 1 FROM inventory.inventory_publication_targets AS target
                  WHERE target.channel_id = channel.id AND target.state = 'live'
                    AND target.publication_authority = 'echelon'
                ) AS publishes_stock
         FROM channels.channels AS channel
         ORDER BY channel.id`,
      )).rows;
      const entries = await loadSalesStatusEntriesForProduct(client, productId);
      const holds = (await client.query<{
        publication_target_id: number; channel_id: number; product_variant_id: number | null;
        reason: string; held_by: string; held_at: Date;
      }>(
        `SELECT target.id AS publication_target_id, target.channel_id, NULL::integer AS product_variant_id,
                target.hold_reason AS reason, target.held_by, target.held_at
         FROM inventory.inventory_publication_targets AS target
         WHERE target.state = 'live' AND target.publication_authority = 'echelon' AND target.held_at IS NOT NULL
         UNION ALL
         SELECT hold.publication_target_id, target.channel_id, hold.product_variant_id,
                hold.hold_reason AS reason, hold.held_by, hold.held_at
         FROM inventory.inventory_publication_target_variant_holds AS hold
         JOIN inventory.inventory_publication_targets AS target ON target.id = hold.publication_target_id
         JOIN catalog.product_variants AS variant ON variant.id = hold.product_variant_id
         WHERE variant.product_id = $1 AND target.state = 'live' AND target.publication_authority = 'echelon'
         ORDER BY publication_target_id, product_variant_id NULLS FIRST`,
        [productId],
      )).rows;
      return salesStatusProductViewSchema.parse({
        runtimeAuthority: authority,
        product: { id: Number(product.id), sku: product.sku, name: product.name },
        variants: variants.map((variant) => ({
          id: Number(variant.id),
          sku: variant.sku,
          name: variant.name,
          unitsPerVariant: Number(variant.units_per_variant),
          sellable: variant.sellable === true,
        })),
        channels: channels.map((channel) => ({
          id: Number(channel.id),
          name: channel.name,
          provider: channel.provider,
          status: channel.status,
          publishesStock: channel.publishes_stock === true,
        })),
        entries,
        otherHolds: holds.map((hold) => ({
          publicationTargetId: Number(hold.publication_target_id),
          channelId: Number(hold.channel_id),
          productVariantId: hold.product_variant_id == null ? null : Number(hold.product_variant_id),
          reason: hold.reason,
          heldBy: hold.held_by,
          heldAt: new Date(hold.held_at).toISOString(),
        })),
      });
    });
  }

  list(status: SalesStatus): Promise<SalesStatusList> {
    return this.readOnly(async (client) => {
      const rows = (await client.query<SalesStatusRow & {
        product_name: string; product_sku: string | null; variant_sku: string | null; channel_name: string | null;
      }>(
        `SELECT setting.id, setting.channel_id, COALESCE(setting.product_id, variant.product_id) AS item_product_id,
                setting.product_variant_id, setting.status, setting.note, setting.revision::text AS revision,
                setting.updated_by, setting.updated_at,
                product.name AS product_name, product.sku AS product_sku, variant.sku AS variant_sku,
                channel.name AS channel_name
         FROM inventory.sales_statuses AS setting
         LEFT JOIN catalog.product_variants AS variant ON variant.id = setting.product_variant_id
         JOIN catalog.products AS product ON product.id = COALESCE(setting.product_id, variant.product_id)
         LEFT JOIN channels.channels AS channel ON channel.id = setting.channel_id
         WHERE setting.status = $1
         ORDER BY setting.updated_at DESC, setting.id DESC
         LIMIT $2`,
        // One extra row tells the caller the list was cut, without a second count query.
        [status, SALES_STATUS_LIST_LIMIT + 1],
      )).rows;
      return salesStatusListSchema.parse({
        entries: rows.slice(0, SALES_STATUS_LIST_LIMIT).map((row) => ({
          entry: salesStatusEntryFromRow(row),
          productName: row.product_name,
          productSku: row.product_sku,
          variantSku: row.variant_sku,
          channelName: row.channel_name,
        })),
        truncated: rows.length > SALES_STATUS_LIST_LIMIT,
      });
    });
  }

  private async readOnly<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.connectionPool.connect();
    let discard: Error | undefined;
    try {
      // One snapshot, so settings, holds and catalog rows agree with each other.
      await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await client.query("SET LOCAL statement_timeout = '30s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        discard = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
      }
      throw classifyFailure(error);
    } finally {
      client.release(discard);
    }
  }
}

async function loadReplay(client: PoolClient, receiptKey: string, requestHash: string): Promise<SalesStatusChangeResult | null> {
  const receipt = (await client.query<{ request_hash: string; response_body: unknown }>(
    "SELECT request_hash, response_body FROM public.idempotency_keys WHERE key = $1",
    [receiptKey],
  )).rows[0];
  if (!receipt) return null;
  if (receipt.request_hash !== requestHash) {
    throw new SalesStatusError(409, "SALES_STATUS_IDEMPOTENCY_CONFLICT",
      "This retry key was already used for a different change. Nothing was changed.", "permanent");
  }
  const body = receipt.response_body as { commandType?: unknown; result?: unknown } | null;
  const parsed = body?.commandType === COMMAND_TYPE ? salesStatusChangeResultSchema.safeParse(body.result) : null;
  if (!parsed?.success) {
    throw new SalesStatusError(500, "SALES_STATUS_RECEIPT_INVALID",
      "The earlier change with this retry key has an incomplete receipt. Nothing was changed.", "permanent");
  }
  return { ...parsed.data, alreadyApplied: true };
}

async function readAuthority(client: PoolClient, lock = false): Promise<"legacy" | "canonical"> {
  const row = (await client.query<{ authority: string }>(
    `SELECT authority FROM inventory.availability_runtime_authority WHERE singleton_key = true${lock ? " FOR SHARE" : ""}`,
  )).rows[0];
  if (row?.authority !== "legacy" && row?.authority !== "canonical") {
    throw new SalesStatusError(503, "SALES_STATUS_AUTHORITY_UNAVAILABLE",
      "The live inventory authority could not be confirmed. Nothing was changed.", "transient");
  }
  return row.authority;
}

/**
 * The legacy allocator does not read sales statuses, so a status saved while
 * it publishes would claim a stop that is not happening. Refuse instead.
 * FOR SHARE keeps the authority from flipping until this command commits.
 */
async function requireCanonicalAuthority(client: PoolClient): Promise<void> {
  if (await readAuthority(client, true) !== "canonical") {
    throw new SalesStatusError(409, "SALES_STATUS_CANONICAL_REQUIRED",
      "Sales status takes effect only after inventory cutover. Nothing was changed.", "permanent");
  }
}

/** Every product, SKU and channel named exists, and every SKU belongs to the product named with it. */
async function validateScopes(client: PoolClient, scopes: readonly SalesStatusScope[]): Promise<void> {
  const productIds = unique(scopes.map((scope) => scope.productId));
  const variantIds = unique(scopes.flatMap((scope) => scope.productVariantId === null ? [] : [scope.productVariantId]));
  const channelIds = unique(scopes.flatMap((scope) => scope.channelId === null ? [] : [scope.channelId]));
  const products = new Set((await client.query<{ id: number }>(
    "SELECT id FROM catalog.products WHERE id = ANY($1::integer[])", [productIds],
  )).rows.map((row) => Number(row.id)));
  const variants = new Map(variantIds.length === 0 ? [] : (await client.query<{ id: number; product_id: number }>(
    "SELECT id, product_id FROM catalog.product_variants WHERE id = ANY($1::integer[])", [variantIds],
  )).rows.map((row) => [Number(row.id), Number(row.product_id)] as const));
  const channels = new Set(channelIds.length === 0 ? [] : (await client.query<{ id: number }>(
    "SELECT id FROM channels.channels WHERE id = ANY($1::integer[])", [channelIds],
  )).rows.map((row) => Number(row.id)));
  const missing = {
    productIds: productIds.filter((id) => !products.has(id)),
    productVariantIds: variantIds.filter((id) => !variants.has(id)),
    channelIds: channelIds.filter((id) => !channels.has(id)),
  };
  if (missing.productIds.length + missing.productVariantIds.length + missing.channelIds.length > 0) {
    throw new SalesStatusError(404, "SALES_STATUS_SCOPE_NOT_FOUND",
      "A product, SKU or channel in this change no longer exists. Nothing was changed.", "permanent", missing);
  }
  const mismatched = scopes.filter((scope) => scope.productVariantId !== null
    && variants.get(scope.productVariantId) !== scope.productId);
  if (mismatched.length > 0) {
    throw new SalesStatusError(400, "SALES_STATUS_SCOPE_MISMATCH",
      "A SKU in this change belongs to a different product. Nothing was changed.", "permanent",
      { productVariantIds: mismatched.map((scope) => scope.productVariantId) });
  }
}

/**
 * The current settings of every product and SKU named (their all-channels
 * setting and every channel exception), locked until commit, in id order so
 * two commands on the same items lock in the same order. A product-level
 * change does not lock its SKUs' own settings: it never writes them.
 */
async function lockCurrentSettings(
  client: PoolClient,
  scopes: readonly SalesStatusScope[],
): Promise<Map<string, StoredSetting>> {
  const productIds = unique(scopes.filter((scope) => scope.productVariantId === null).map((scope) => scope.productId));
  const variantIds = unique(scopes.flatMap((scope) => scope.productVariantId === null ? [] : [scope.productVariantId]));
  const rows = (await client.query<SalesStatusRow>(
    `SELECT setting.id, setting.channel_id, COALESCE(setting.product_id, variant.product_id) AS item_product_id,
            setting.product_variant_id, setting.status, setting.note, setting.revision::text AS revision,
            setting.updated_by, setting.updated_at
     FROM inventory.sales_statuses AS setting
     LEFT JOIN catalog.product_variants AS variant ON variant.id = setting.product_variant_id
     WHERE setting.product_id = ANY($1::integer[]) OR setting.product_variant_id = ANY($2::integer[])
     ORDER BY setting.id
     FOR UPDATE OF setting`,
    [productIds, variantIds],
  )).rows;
  return new Map(rows.map((row) => {
    const entry = salesStatusEntryFromRow(row);
    return [entry.scopeKey, {
      id: Number(row.id),
      scopeKey: entry.scopeKey,
      scope: entry.scope,
      status: entry.status,
      revision: entry.revision,
    }] as const;
  }));
}

async function applyOperation(
  client: PoolClient,
  operation: SalesStatusOperation,
  current: ReadonlyMap<string, StoredSetting>,
  command: SalesStatusCommand,
): Promise<Outcome> {
  const before = operation.before ? { status: operation.before.status, revision: operation.before.revision } : null;
  const base = { scopeKey: operation.scopeKey, scope: operation.scope, before };
  if (operation.kind === "none") return { ...base, after: before, changed: false };
  let after: Outcome["after"];
  if (operation.kind === "insert") {
    const scope = operation.scope;
    const inserted = (await client.query<{ revision: string }>(
      `INSERT INTO inventory.sales_statuses
         (channel_id, product_id, product_variant_id, status, note, revision, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, nextval('inventory.sales_status_revision_seq'), $6, $7)
       RETURNING revision::text AS revision`,
      [scope.channelId, scope.productVariantId === null ? scope.productId : null, scope.productVariantId,
        operation.status, command.note, command.actorId, command.occurredAt],
    )).rows[0]!;
    after = { status: operation.status, revision: inserted.revision };
  } else {
    const stored = current.get(operation.scopeKey);
    if (!stored) throw concurrentChange();
    if (operation.kind === "update") {
      const updated = await client.query<{ revision: string }>(
        `UPDATE inventory.sales_statuses
         SET status = $3, note = $4, revision = nextval('inventory.sales_status_revision_seq'),
             updated_by = $5, updated_at = $6
         WHERE id = $1 AND revision = $2::bigint
         RETURNING revision::text AS revision`,
        [stored.id, stored.revision, operation.status, command.note, command.actorId, command.occurredAt],
      );
      if (updated.rowCount !== 1) throw concurrentChange();
      after = { status: operation.status, revision: updated.rows[0]!.revision };
    } else {
      const deleted = await client.query(
        "DELETE FROM inventory.sales_statuses WHERE id = $1 AND revision = $2::bigint",
        [stored.id, stored.revision],
      );
      if (deleted.rowCount !== 1) throw concurrentChange();
      after = null;
    }
  }
  await client.query(
    `INSERT INTO inventory.sales_status_events
       (idempotency_key, request_hash, channel_id, product_id, product_variant_id, before_status, after_status,
        before_revision, after_revision, note, actor, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint, $9::bigint, $10, $11, $12)`,
    [command.idempotencyKey, command.requestHash, operation.scope.channelId, operation.scope.productId,
      operation.scope.productVariantId, before?.status ?? null, after?.status ?? null, before?.revision ?? null,
      after?.revision ?? null, command.note, command.actorId, command.occurredAt],
  );
  return { ...base, after, changed: true };
}

/**
 * Republishes the products a change affects. Small changes plan here, each
 * product under its own savepoint with broken destinations isolated, exactly
 * as a stock change fans out; a product the planner refuses is handed to the
 * stock-update worker, which retries it, instead of failing the change: a
 * stop is a safety action and its setting must still land. Large changes go
 * to the worker directly.
 */
async function republishProducts(client: PoolClient, productIds: readonly number[]): Promise<Republication> {
  const outcome: Republication = { republished: [], queued: [] };
  if (productIds.length > SALES_STATUS_INLINE_REPUBLISH_MAX_PRODUCTS) {
    for (const productId of productIds) {
      await markPublicationProductChanged(client, productId);
      outcome.queued.push({ productId, reason: "large_change", errorCode: null });
    }
    return outcome;
  }
  const publisher = createTransactionScopedInventoryPublicationService(client);
  for (const productId of productIds) {
    await client.query(`SAVEPOINT ${PRODUCT_SAVEPOINT}`);
    try {
      const routed = await publisher.publishProduct({
        productId,
        dryRun: false,
        triggeredBy: "sales_status_change",
        blockedTargets: "isolate",
      }, async () => {
        throw new SalesStatusError(409, "SALES_STATUS_CANONICAL_REQUIRED",
          "Sales status takes effect only after inventory cutover. Nothing was changed.", "permanent");
      });
      await client.query(`RELEASE SAVEPOINT ${PRODUCT_SAVEPOINT}`);
      if (routed.authority !== "canonical") {
        throw new SalesStatusError(409, "SALES_STATUS_CANONICAL_REQUIRED",
          "Sales status takes effect only after inventory cutover. Nothing was changed.", "permanent");
      }
      outcome.republished.push({
        productId,
        publicationRows: routed.publication.enqueuedRows,
        skippedDestinations: (routed.publication.blockedTargets ?? []).map((target) => ({
          publicationTargetId: target.publicationTargetId,
          channelId: target.channelId,
          channelName: target.channelName,
          errorCode: target.errorCode,
        })),
      });
    } catch (error) {
      if (!isPlanningRefusal(error)) throw error;
      await client.query(`ROLLBACK TO SAVEPOINT ${PRODUCT_SAVEPOINT}`);
      await markPublicationProductChanged(client, productId);
      outcome.queued.push({ productId, reason: "could_not_republish", errorCode: error.code });
    }
  }
  return outcome;
}

/**
 * A refusal about this product's planning evidence, raised by the planner or
 * publisher before anything else in the transaction failed. Database errors
 * (serialization, locks, timeouts) are not refusals: the whole command retries.
 */
function isPlanningRefusal(error: unknown): error is { code: string } {
  return error instanceof InventoryAvailabilityRuntimePublicationError
    || error instanceof InventoryChannelExposureRuntimeError
    || (error instanceof SalesStatusError && error.code === "SALES_STATUS_EVIDENCE_INVALID");
}

function concurrentChange(): SalesStatusError {
  return new SalesStatusError(409, "SALES_STATUS_BUSY",
    "Another change to this sales status was saving at the same time. Nothing was saved; retry.", "transient");
}

function classifyFailure(error: unknown): unknown {
  if (error instanceof SalesStatusError) return error;
  const code = error && typeof error === "object" && "code" in error ? String((error as { code: unknown }).code) : "";
  if (RETRYABLE_SQLSTATES.has(code)) {
    return new SalesStatusError(409, "SALES_STATUS_BUSY",
      "Stock or settings changed while saving. Nothing was saved; retry the same change.", "transient", { sqlstate: code });
  }
  return error;
}

function unique(values: readonly number[]): number[] {
  return [...new Set(values)].sort((left, right) => left - right);
}
