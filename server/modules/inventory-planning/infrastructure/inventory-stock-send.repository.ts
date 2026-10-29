import type { Pool, PoolClient } from "pg";
import {
  inventoryStockSendReceiptSchema, inventoryStockSendContextSchema, inventoryStockSendReviewSchema, inventoryStockSendProgressSchema,
  STOCK_SEND_MAX_PRODUCT_VARIANTS, STOCK_SEND_MAX_TARGETS,
  type InventoryStockSendContextRequest, type InventoryStockSendSelection, type InventoryStockSendRequest,
  type InventoryStockSendReview, type InventoryStockSendReceipt,
} from "@shared/types/inventory-stock-send";
import { pool } from "../../../db";
import { InventoryStockSendError, type InventoryStockSendStore } from "../application/inventory-stock-send.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { InventoryAvailabilityRuntimePublicationError } from "../application/inventory-availability-runtime-publication.service";
import { createTransactionScopedInventoryPublicationService } from "./inventory-availability-runtime-publication.repository";
import { loadAndLockRuntimeAuthority } from "./inventory-availability-runtime-atp.repository";
import { loadManagedSellableVariantIds } from "./inventory-channel-exposure-runtime.repository";

const RECEIPT_PREFIX = "inventory-stock-send:";
const MAX_TRANSACTION_ATTEMPTS = 3;
type Target = {
  id: number; channelId: number; channelName: string; externalScopeId: string; revision: string;
  state: string; publicationAuthority: string; heldAt: Date | null; channelStatus: string; connectionValid: boolean;
};
type OutboxRow = { productVariantId: number; outboxId: string; revision: string; quantity: string; externalInventoryItemId: string; state: string };

/** Local command, receipt and desired stock commit atomically. Provider calls
 * belong exclusively to the existing admitted outbox worker. */
export class PostgresInventoryStockSendStore implements InventoryStockSendStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}

  context(input: InventoryStockSendContextRequest) {
    return this.transaction(async client => (await readContext(client, input)).view);
  }
  review(selection: InventoryStockSendSelection) {
    return this.transaction(async client => (await captureReview(client, selection)).review);
  }
  send(command: InventoryStockSendRequest, actor: string, requestHash: string, now: Date) {
    return this.transaction(async client => {
      const receiptKey = RECEIPT_PREFIX + command.idempotencyKey;
      // A namespaced string key avoids consuming another owner's numeric lock
      // namespace. SERIALIZABLE retries below refresh snapshots after lock waits.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [receiptKey]);
      const previous = (await client.query<{ request_hash: string; response_body: unknown }>(
        "SELECT request_hash,response_body FROM public.idempotency_keys WHERE key=$1", [receiptKey])).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash) throw failure("COMMAND_CONFLICT", "This send key belongs to a different selection or user.");
        return { receipt: inventoryStockSendReceiptSchema.parse(previous.response_body), replayed: true };
      }
      const selection = { productId: command.productId, publicationTargetId: command.publicationTargetId, productVariantIds: command.productVariantIds };
      const { review, target } = await captureReview(client, selection);
      if (review.reviewHash !== command.expectedReviewHash) throw failure("REVIEW_STALE", "Stock, listing links or settings changed. Check the current quantities before sending.");
      if (!review.ready || !target) throw failure("BLOCKED", review.blockers.join(" ") || "This stock update is not ready.");
      const before = await readOutboxRows(client, selection);
      const publisher = createTransactionScopedInventoryPublicationService(client, {
        refreshVerifiedPublications: command.productVariantIds.map(productVariantId => ({ publicationTargetId: target.id, productVariantId })),
      });
      const publication = await publisher.publishProduct({ ...selection, channelId: target.channelId, dryRun: false,
        triggeredBy: "manual_selected_stock_send" }, async () => { throw failure("CANONICAL_REQUIRED", "Complete Channel Inventory setup before sending stock."); });
      if (publication.authority !== "canonical" || publication.publication.rows.length !== command.productVariantIds.length
        || publication.publication.enqueuedRows + publication.publication.coalescedRows !== command.productVariantIds.length)
        throw failure("INCOMPLETE", "The complete selected stock update could not be queued.", 500);
      const after = await readOutboxRows(client, selection);
      if (after.length !== review.rows.length || after.some(row => !review.rows.some(expected =>
        expected.productVariantId === row.productVariantId && expected.quantity === row.quantity && expected.externalInventoryItemId === row.externalInventoryItemId)))
        throw failure("INCOMPLETE", "The queued stock does not match the reviewed selection.", 500);
      const receipt = inventoryStockSendReceiptSchema.parse({ ...selection, idempotencyKey: command.idempotencyKey,
        reviewHash: review.reviewHash, requestedAt: now.toISOString(), requestedBy: actor,
        channelId: target.channelId, channelName: target.channelName, location: target.externalScopeId,
        rows: after.map(row => ({ ...review.rows.find(expected => expected.productVariantId === row.productVariantId)!,
          outboxId: row.outboxId, revision: row.revision })),
      });
      await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
        VALUES($1,'AUDIT',$2,'inventory_availability.stock.sent',$3,$4::jsonb,$5::jsonb)`,
      [now, actor, `inventory.inventory_publication_target:${target.id}`,
        JSON.stringify({ before: { rows: before }, after: { rows: after } }),
        JSON.stringify({ commandKey: command.idempotencyKey, requestHash, review, productId: command.productId, providerWriteAttempted: false })]);
      await client.query("INSERT INTO public.idempotency_keys(key,request_hash,response_body,created_at,expires_at) VALUES($1,$2,$3::jsonb,$4,NULL)",
        [receiptKey, requestHash, JSON.stringify(receipt), now]);
      return { receipt, replayed: false };
    });
  }
  progress(commandKey: string) {
    return this.transaction(async client => {
      const record = (await client.query<{ response_body: unknown }>(
        "SELECT response_body FROM public.idempotency_keys WHERE key=$1", [RECEIPT_PREFIX + commandKey])).rows[0];
      if (!record) throw failure("NOT_FOUND", "This stock-send command has not been recorded.", 404);
      const receipt = inventoryStockSendReceiptSchema.parse(record.response_body);
      const rows = (await client.query(`SELECT outbox.product_variant_id AS "productVariantId",outbox.id::text AS "outboxId",outbox.state,
        outbox.last_error_class AS "errorCode",outbox.last_error_message AS "errorMessage",
        observed.observed_quantity::text AS "observedQuantity",observed.observed_at AS "observedAt"
        FROM inventory.inventory_publication_outbox outbox
        LEFT JOIN LATERAL (SELECT observed_quantity,observed_at FROM inventory.inventory_publication_readbacks
          WHERE outbox_id=outbox.id AND publication_target_id=outbox.publication_target_id AND product_variant_id=outbox.product_variant_id
          ORDER BY observed_at DESC,id DESC LIMIT 1) observed ON true
        WHERE outbox.id=ANY($1::bigint[]) AND outbox.publication_target_id=$2 ORDER BY outbox.product_variant_id`,
      [receipt.rows.map(row => row.outboxId), receipt.publicationTargetId])).rows;
      if (rows.length !== receipt.rows.length) throw failure("EVIDENCE_INCOMPLETE", "Some delivery evidence is unavailable; completion cannot be confirmed.", 500);
      return inventoryStockSendProgressSchema.parse({ receipt, rows: rows.map(row => ({ ...row,
        observedAt: row.observedAt instanceof Date ? row.observedAt.toISOString() : row.observedAt })) });
    });
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const client = await this.connectionPool.connect();
      let discard: Error | undefined;
      try {
        await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
        await client.query("SET LOCAL lock_timeout='5s'");
        await client.query("SET LOCAL statement_timeout='60s'");
        const result = await work(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try { await client.query("ROLLBACK"); }
        catch (rollback) { discard = rollback instanceof Error ? rollback : new Error(String(rollback));
          throw new AggregateError([error, rollback], "Stock-send rollback failed; retry the same command key."); }
        const code = error && typeof error === "object" && "code" in error ? error.code : null;
        if (attempt < MAX_TRANSACTION_ATTEMPTS && (code === "40001" || code === "40P01")) continue;
        throw error;
      } finally { client.release(discard); }
    }
  }
}

async function readContext(client: PoolClient, input: InventoryStockSendContextRequest, publicationTargetId?: number) {
  const authority = await loadAndLockRuntimeAuthority(client);
  const global = (await client.query<{ global_enabled: boolean; revision: string }>(
    "SELECT global_enabled,revision::text FROM channels.sync_settings WHERE singleton_key=true FOR SHARE")).rows[0];
  const product = (await client.query<{ name: string; is_active: boolean }>(
    "SELECT name,is_active FROM catalog.products WHERE id=$1 FOR SHARE", [input.productId])).rows[0];
  if (!product) throw failure("PRODUCT_NOT_FOUND", "This catalog product no longer exists.", 404);
  const variants = (await client.query<{ id: number; sku: string | null; name: string }>(
    "SELECT id,sku,name FROM catalog.product_variants WHERE product_id=$1 AND is_active ORDER BY id LIMIT $2 FOR SHARE",
    [input.productId, STOCK_SEND_MAX_PRODUCT_VARIANTS + 1])).rows;
  if (variants.length > STOCK_SEND_MAX_PRODUCT_VARIANTS) throw failure("PRODUCT_TOO_LARGE", "This product exceeds the supported 1,000-variant stock-selection view.", 422);
  const managed = new Set(await loadManagedSellableVariantIds(client, input.productId));
  const targets = (await client.query<Target>(`SELECT target.id,target.channel_id AS "channelId",channel.name AS "channelName",
    target.external_scope_id AS "externalScopeId",target.revision::text,target.state,target.publication_authority AS "publicationAuthority",
    target.held_at AS "heldAt",channel.status AS "channelStatus",connection.id IS NOT NULL AS "connectionValid"
    FROM inventory.inventory_publication_targets target JOIN channels.channels channel ON channel.id=target.channel_id
    LEFT JOIN channels.channel_connections connection ON connection.id=target.channel_connection_id AND connection.channel_id=target.channel_id
    WHERE lower(channel.provider)='shopify' AND target.destination_kind='channel_connection' AND target.provider_scope_type='location'
      AND ($1::integer IS NULL OR target.channel_id=$1) AND ($3::integer IS NULL OR target.id=$3)
    ORDER BY target.id LIMIT $2 FOR SHARE OF target,channel`,
    [input.channelId ?? null, STOCK_SEND_MAX_TARGETS + 1, publicationTargetId ?? null])).rows;
  if (targets.length > STOCK_SEND_MAX_TARGETS) throw failure("TOO_MANY_TARGETS", "Choose one Shopify channel to narrow the available stock destinations.", 422);
  const blockers: string[] = [];
  if (authority.authority !== "canonical") blockers.push("Complete Channel Inventory setup before sending selected stock.");
  if (!global?.global_enabled) blockers.push("All-channel stock updates are paused. Enable them in Channel Inventory before sending.");
  if (!product.is_active) blockers.push("This catalog product is archived.");
  if (!variants.some(variant => managed.has(variant.id))) blockers.push("This product has no inventory-managed sellable variants.");
  const view = inventoryStockSendContextSchema.parse({ productId: input.productId, productName: product.name,
    variants: variants.map(variant => ({ ...variant, eligible: managed.has(variant.id) })),
    targets: targets.map(target => ({ id: target.id, channelId: target.channelId, channelName: target.channelName,
      externalScopeId: target.externalScopeId, label: `${target.channelName} · Shopify location ${target.externalScopeId}`,
      blockers: targetBlockers(target) })), blockers });
  return { view, targets, authority, global };
}

async function captureReview(client: PoolClient, selection: InventoryStockSendSelection): Promise<{ review: InventoryStockSendReview; target: Target | undefined }> {
  const context = await readContext(client, { productId: selection.productId }, selection.publicationTargetId);
  const target = context.targets.find(candidate => candidate.id === selection.publicationTargetId);
  const blockers = [...context.view.blockers];
  if (!target) blockers.push("Choose a Shopify location configured in Channel Inventory.");
  else blockers.push(...targetBlockers(target));
  if (selection.productVariantIds.some(id => !context.view.variants.some(variant => variant.id === id && variant.eligible)))
    blockers.push("Every selected SKU must be an active inventory-managed variant of this product.");
  let rows: InventoryStockSendReview["rows"] = [];
  let planIdentity: unknown = null;
  if (blockers.length === 0 && target) {
    try {
      const result = await createTransactionScopedInventoryPublicationService(client).publishProduct({ ...selection,
        channelId: target.channelId, dryRun: true, triggeredBy: "manual_selected_stock_review" }, async () => {
        throw failure("CANONICAL_REQUIRED", "Complete Channel Inventory setup before sending stock.");
      });
      if (result.authority !== "canonical") throw failure("CANONICAL_REQUIRED", "Canonical inventory is required.");
      planIdentity = { authorityRevision: result.publication.authorityRevision, activationRunId: result.publication.activationRunId,
        rows: result.publication.rows };
      rows = result.publication.rows.map(row => ({ productVariantId: row.productVariantId, sku: row.sku,
        quantity: row.desiredQuantity, externalInventoryItemId: row.externalInventoryItemId }));
      if (rows.length !== selection.productVariantIds.length || result.publication.rows.some(row => row.blockerCodes.length > 0))
        blockers.push("The selected stock has unresolved publication blockers. Check its stock preview in Channel Inventory.");
    } catch (error) {
      if (!(error instanceof InventoryAvailabilityRuntimePublicationError)) throw error;
      blockers.push(error.message);
    }
  }
  return { target, review: inventoryStockSendReviewSchema.parse({ ...selection, ready: blockers.length === 0, blockers, rows,
    reviewHash: inventoryCutoverEvidenceHash({ selection, authority: context.authority, global: context.global, target, planIdentity, blockers }) }) };
}

function targetBlockers(target: Target): string[] {
  const blockers: string[] = [];
  if (target.publicationAuthority !== "echelon") blockers.push("Inventory for this Shopify location is managed outside Echelon.");
  if (target.state !== "live") blockers.push("Stock updates for this Shopify location are off. Enable them in Channel Inventory.");
  if (target.heldAt !== null) blockers.push("This Shopify location has a stock-update hold. Resolve it in Channel Inventory.");
  if (target.channelStatus !== "active" || !target.connectionValid) blockers.push("This Shopify connection is inactive or no longer matches its destination.");
  return blockers;
}
async function readOutboxRows(client: PoolClient, selection: InventoryStockSendSelection): Promise<OutboxRow[]> {
  return (await client.query<OutboxRow>(`SELECT DISTINCT ON (product_variant_id) product_variant_id AS "productVariantId",
    id::text AS "outboxId",desired_revision::text AS revision,desired_quantity::text AS quantity,
    external_inventory_item_id_snapshot AS "externalInventoryItemId",state
    FROM inventory.inventory_publication_outbox WHERE publication_target_id=$1 AND product_variant_id=ANY($2::integer[])
    ORDER BY product_variant_id,desired_revision DESC`, [selection.publicationTargetId, selection.productVariantIds])).rows;
}
function failure(code: string, message: string, status = 409): InventoryStockSendError {
  return new InventoryStockSendError(`STOCK_SEND_${code}`, message, status);
}
