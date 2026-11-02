import type { Pool, PoolClient } from "pg";
import {
  inventoryProductSyncReviewSchema, inventoryProductSyncReceiptSchema, inventoryProductSyncProgressSchema,
  PRODUCT_SYNC_MAX_VARIANTS, PRODUCT_SYNC_MAX_TARGETS, PRODUCT_SYNC_MAX_ROWS,
  type InventoryProductSyncReviewRequest, type InventoryProductSyncRequest, type InventoryProductSyncReview,
} from "@shared/types/inventory-product-sync";
import type { InventoryChannelExposureRuntimePlan } from "@shared/types/inventory-channel-exposure";
import { pool } from "../../../db";
import { InventoryProductSyncError, type InventoryProductSyncStore } from "../application/inventory-product-sync.service";
import { AuthorityAwareInventoryPublicationService, InventoryAvailabilityRuntimePublicationError,
  type CanonicalInventoryPublicationResult } from "../application/inventory-availability-runtime-publication.service";
import { InventoryChannelExposureRuntimeError } from "../application/inventory-channel-exposure-runtime.service";
import { inventoryCutoverEvidenceHash } from "../domain/inventory-cutover-manifest";
import { createTransactionScopedInventoryPublicationService, PostgresTransactionScopedInventoryPublicationExecutor } from "./inventory-availability-runtime-publication.repository";
import { loadAndLockRuntimeAuthority } from "./inventory-availability-runtime-atp.repository";
import { loadManagedSellableVariantIds } from "./inventory-channel-exposure-runtime.repository";
import { executeInventoryPublicationCommand } from "./inventory-publication-command-transaction";

const RECEIPT_PREFIX = "inventory-product-sync:";
type Target = { publicationTargetId: number; channelId: number; channelName: string; providerKey: string;
  externalScopeId: string; state: string; publicationAuthority: string; revision: string };
type Scope = { publicationTargetId: number; productVariantId: number };
type OutboxRow = Scope & { outboxId: string; revision: string; quantity: string; externalInventoryItemId: string;
  channelId: number; providerKey: string; externalScopeId: string; state: string };
const scopeKey = (row: Scope) => `${row.publicationTargetId}:${row.productVariantId}`;

/** One product is planned across ATP's existing destinations. Review, enqueue,
 * audit and immutable receipt share one serializable transaction; provider I/O
 * remains exclusively with the admitted publication outbox worker. */
export class PostgresInventoryProductSyncStore implements InventoryProductSyncStore {
  constructor(private readonly connectionPool: Pick<Pool, "connect"> = pool) {}
  review(input: InventoryProductSyncReviewRequest) {
    return executeInventoryPublicationCommand(this.connectionPool, client => captureReview(client, input.productId));
  }
  sync(command: InventoryProductSyncRequest, actor: string, requestHash: string, now: Date) {
    return executeInventoryPublicationCommand(this.connectionPool, async client => {
      const receiptKey = RECEIPT_PREFIX + command.idempotencyKey;
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [receiptKey]);
      const previous = (await client.query<{ request_hash: string; response_body: unknown }>(
        "SELECT request_hash,response_body FROM public.idempotency_keys WHERE key=$1", [receiptKey])).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash) throw failure("COMMAND_CONFLICT", "This sync key belongs to another product, review or user.");
        return { receipt: inventoryProductSyncReceiptSchema.parse(previous.response_body), replayed: true };
      }
      const review = await captureReview(client, command.productId);
      if (review.reviewHash !== command.expectedReviewHash) throw failure("REVIEW_STALE", "Stock, listing links or ATP settings changed. Review the current quantities before syncing.");
      if (!review.ready) throw failure("BLOCKED", review.blockers.join(" ") || "No destination is ready for this product's inventory sync.");
      const ready = review.rows.filter(row => row.status === "ready");
      const before = await readOutboxRows(client, ready);
      const publisher = createTransactionScopedInventoryPublicationService(client, { refreshVerifiedPublications: ready });
      const result = await publisher.publishProduct({ productId: command.productId, dryRun: false,
        blockedTargets: "isolate", triggeredBy: "manual_product_atp_sync" }, async () => { throw canonicalRequired(); });
      if (result.authority !== "canonical" || result.publication.rows.length !== ready.length
        || result.publication.enqueuedRows + result.publication.coalescedRows !== ready.length
        || result.publication.rows.some(row => !ready.some(expected => scopeKey(expected) === scopeKey(row)
          && expected.quantity === row.desiredQuantity && expected.externalInventoryItemId === row.externalInventoryItemId)))
        throw failure("INCOMPLETE", "The complete reviewed ATP publication could not be queued.", 500);
      const after = await readOutboxRows(client, ready);
      if (after.length !== ready.length || after.some(row => !ready.some(expected => scopeKey(expected) === scopeKey(row)
        && expected.quantity === row.quantity && expected.externalInventoryItemId === row.externalInventoryItemId
        && expected.channelId === row.channelId && expected.providerKey === row.providerKey && expected.externalScopeId === row.externalScopeId)))
        throw failure("INCOMPLETE", "The queued stock does not match the reviewed destinations and quantities.", 500);
      const receipt = inventoryProductSyncReceiptSchema.parse({ productId: review.productId, productName: review.productName,
        sku: review.sku, idempotencyKey: command.idempotencyKey, reviewHash: review.reviewHash,
        requestedAt: now.toISOString(), requestedBy: actor, targets: review.targets,
        rows: after.map(row => ({ ...ready.find(expected => scopeKey(expected) === scopeKey(row))!, outboxId: row.outboxId, revision: row.revision })),
        blockedRows: review.rows.filter(row => row.status === "blocked"),
      });
      await client.query(`INSERT INTO public.audit_events(timestamp,level,actor,action,target,changes,context)
        VALUES($1,'AUDIT',$2,'inventory_availability.product.synced',$3,$4::jsonb,$5::jsonb)`,
      [now, actor, `catalog.product:${command.productId}`, JSON.stringify({ before: { rows: before }, after: { rows: after } }),
        JSON.stringify({ commandKey: command.idempotencyKey, requestHash, review, productId: command.productId, providerWriteAttempted: false })]);
      await client.query("INSERT INTO public.idempotency_keys(key,request_hash,response_body,created_at,expires_at) VALUES($1,$2,$3::jsonb,$4,NULL)",
        [receiptKey, requestHash, JSON.stringify(receipt), now]);
      return { receipt, replayed: false };
    });
  }
  progress(commandKey: string) {
    return executeInventoryPublicationCommand(this.connectionPool, async client => {
      const record = (await client.query<{ response_body: unknown }>(
        "SELECT response_body FROM public.idempotency_keys WHERE key=$1", [RECEIPT_PREFIX + commandKey])).rows[0];
      if (!record) throw failure("NOT_FOUND", "This ATP sync command has not been recorded.", 404);
      const receipt = inventoryProductSyncReceiptSchema.parse(record.response_body);
      const rows = (await client.query(`SELECT outbox.publication_target_id AS "publicationTargetId",
        outbox.product_variant_id AS "productVariantId",outbox.id::text AS "outboxId",outbox.state,
        outbox.last_error_class AS "errorCode",outbox.last_error_message AS "errorMessage",
        observed.observed_quantity::text AS "observedQuantity",observed.observed_at AS "observedAt"
        FROM inventory.inventory_publication_outbox outbox
        LEFT JOIN LATERAL (SELECT observed_quantity,observed_at FROM inventory.inventory_publication_readbacks
          WHERE outbox_id=outbox.id AND publication_target_id=outbox.publication_target_id AND product_variant_id=outbox.product_variant_id
          ORDER BY observed_at DESC,id DESC LIMIT 1) observed ON true
        WHERE outbox.id=ANY($1::bigint[]) ORDER BY outbox.publication_target_id,outbox.product_variant_id`,
      [receipt.rows.map(row => row.outboxId)])).rows;
      return inventoryProductSyncProgressSchema.parse({ receipt, rows: rows.map(row => ({ ...row,
        observedAt: row.observedAt instanceof Date ? row.observedAt.toISOString() : row.observedAt })) });
    });
  }
}

export async function captureReview(client: PoolClient, productId: number): Promise<InventoryProductSyncReview> {
  const authority = await loadAndLockRuntimeAuthority(client);
  const global = (await client.query<{ global_enabled: boolean; revision: string }>(
    "SELECT global_enabled,revision::text FROM channels.sync_settings WHERE singleton_key=true FOR SHARE")).rows[0];
  const product = (await client.query<{ name: string; sku: string | null; is_active: boolean }>(
    "SELECT name,sku,is_active FROM catalog.products WHERE id=$1 FOR SHARE", [productId])).rows[0];
  if (!product) throw failure("PRODUCT_NOT_FOUND", "This catalog product no longer exists.", 404);
  const variants = (await client.query<{ id: number; sku: string | null; name: string }>(
    "SELECT id,sku,name FROM catalog.product_variants WHERE product_id=$1 ORDER BY id LIMIT $2 FOR SHARE",
    [productId, PRODUCT_SYNC_MAX_VARIANTS + 1])).rows;
  if (variants.length > PRODUCT_SYNC_MAX_VARIANTS) throw failure("PRODUCT_TOO_LARGE", "This product exceeds the supported 1,000-variant sync review.", 422);
  const managedIds = await loadManagedSellableVariantIds(client, productId);
  const metadata = (await client.query<Target>(`SELECT target.id AS "publicationTargetId",target.channel_id AS "channelId",
    channel.name AS "channelName",CASE target.destination_kind WHEN 'channel_connection' THEN lower(channel.provider)
      ELSE lower(connection.platform) END AS "providerKey",target.external_scope_id AS "externalScopeId",
    target.state,target.publication_authority AS "publicationAuthority",target.revision::text
    FROM inventory.inventory_publication_targets target JOIN channels.channels channel ON channel.id=target.channel_id
    LEFT JOIN dropship.dropship_store_connections connection ON connection.id=target.dropship_store_connection_id
    ORDER BY target.id LIMIT $1 FOR SHARE OF target,channel`, [PRODUCT_SYNC_MAX_TARGETS + 1])).rows;
  if (metadata.length > PRODUCT_SYNC_MAX_TARGETS) throw failure("TOO_MANY_TARGETS", "This product sync exceeds the supported destination review size.", 422);
  const blockers: string[] = [];
  if (authority.authority !== "canonical") blockers.push("Complete ATP setup before syncing this product.");
  if (!global?.global_enabled) blockers.push("All-channel stock updates are paused. Enable them in Channel Inventory before syncing.");
  let publication: CanonicalInventoryPublicationResult | null = null;
  let capturedPlan: InventoryChannelExposureRuntimePlan | null = null;
  // Capture the exact planner output while using the canonical dry-run command.
  // Rule/source changes invalidate the review even if rounded quantities match.
  if (authority.authority === "canonical") {
    const executor = new PostgresTransactionScopedInventoryPublicationExecutor(client);
    const publisher = new AuthorityAwareInventoryPublicationService({ execute: work => executor.execute(context => work({
      ...context, planProduct: async (...args) => {
        const plan = await context.planProduct(...args); capturedPlan = plan; return plan;
      },
    })) });
    try {
      const result = await publisher.publishProduct({ productId, dryRun: true, blockedTargets: "isolate",
        triggeredBy: "manual_product_atp_review" }, async () => { throw canonicalRequired(); });
      if (result.authority !== "canonical") throw canonicalRequired();
      publication = result.publication;
    } catch (error) {
      if (!(error instanceof InventoryAvailabilityRuntimePublicationError) && !(error instanceof InventoryChannelExposureRuntimeError)) throw error;
      blockers.push(`${error.code}: ${error.message}`);
    }
  }
  const rows: InventoryProductSyncReview["rows"] = (publication?.rows ?? []).map(row => ({
    ...destination(row), productVariantId: row.productVariantId, sku: row.sku, quantity: row.desiredQuantity,
    externalInventoryItemId: row.externalInventoryItemId, status: "ready", blockers: [], warnings: row.blockerCodes,
  }));
  for (const blocked of publication?.blockedTargets ?? []) {
    const target = metadata.find(candidate => candidate.publicationTargetId === blocked.publicationTargetId);
    if (!target) throw failure("EVIDENCE_INCOMPLETE", "A planned destination is missing from this ATP review.", 500);
    // Whole-target isolation withholds clean siblings too. Show those members
    // instead of silently dropping them from the operator's product review.
    const plannedTarget = (capturedPlan as InventoryChannelExposureRuntimePlan | null)?.targets
      .find(candidate => candidate.publicationTargetId === blocked.publicationTargetId);
    const withheldIds = blocked.isolation === "target"
      ? [...new Set([...blocked.productVariantIds, ...(plannedTarget?.rows.map(row => row.productVariantId) ?? [])])]
      : blocked.productVariantIds;
    for (const productVariantId of withheldIds) rows.push({ ...destination(target), productVariantId,
      sku: variants.find(variant => variant.id === productVariantId)?.sku ?? null, quantity: null, externalInventoryItemId: null,
      status: "blocked", blockers: blocked.blockerCodes });
  }
  if (rows.length > PRODUCT_SYNC_MAX_ROWS) throw failure("TOO_MANY_ROWS", "This product exceeds the supported 10,000-row destination review.", 422);
  rows.sort((a, b) => a.publicationTargetId - b.publicationTargetId || a.productVariantId - b.productVariantId);
  // Archiving must not prohibit clearing retained listings. Positive publication
  // still requires an active product; the canonical owner supplies every zero.
  if (!product.is_active && rows.some(row => row.status === "ready" && row.quantity !== "0"))
    blockers.push("This catalog product is archived and cannot publish positive inventory.");
  const targets: InventoryProductSyncReview["targets"] = metadata.map(target => {
    const ready = rows.some(row => row.publicationTargetId === target.publicationTargetId && row.status === "ready");
    const blocked = publication?.blockedTargets?.find(candidate => candidate.publicationTargetId === target.publicationTargetId);
    const reasons = blocked?.blockerCodes ?? (ready ? [] : target.publicationAuthority !== "echelon"
      ? ["Inventory at this destination is managed outside Echelon."] : target.state !== "live"
        ? ["Stock updates for this destination are off."] : ["This product has no eligible listing selected for this destination."]);
    return { ...destination(target), status: ready ? "ready" : blocked ? "blocked" : "skipped", blockers: reasons };
  });
  const ready = blockers.length === 0 && rows.some(row => row.status === "ready");
  // The snapshot timestamp/fingerprint changes on every capture. Resolved target
  // plans contain the stable rules, sources, mappings and calculated quantities.
  const planIdentity = capturedPlan as InventoryChannelExposureRuntimePlan | null;
  const reviewHash = inventoryCutoverEvidenceHash({ contract: "inventory_product_sync_review_v1", productId, product, variants, managedIds,
    authority, global, metadata, targets: planIdentity?.targets ?? null, rows, blockers });
  // Saved stock-link diagnostics explain a missing mapping. They are historical
  // observations, never provider-read proof or authority to publish. A diagnostic
  // scheduler timestamp changing cannot invalidate an otherwise identical plan.
  const diagnostics = await readMissingLinkDiagnostics(client, rows);
  const explainedRows = rows.map(row => ({ ...row, blockers: [...row.blockers, ...(diagnostics.get(scopeKey(row)) ?? [])] }));
  return inventoryProductSyncReviewSchema.parse({ productId, productName: product.name, sku: product.sku, ready, blockers, targets,
    rows: explainedRows, reviewHash });
}

async function readMissingLinkDiagnostics(client: PoolClient, rows: InventoryProductSyncReview["rows"]): Promise<Map<string, string[]>> {
  const missing = rows.filter(row => row.status === "blocked" && row.blockers.includes("PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"));
  if (missing.length === 0) return new Map();
  const providerByScope = new Map(missing.map(row => [scopeKey(row), row.providerKey]));
  const checks = (await client.query<Scope & { status: string; reasonCode: string | null; updatedAt: Date; nextCheckAt: Date | null }>(
    `SELECT checks.publication_target_id AS "publicationTargetId",checks.product_variant_id AS "productVariantId",
      checks.status,checks.reason_code AS "reasonCode",checks.updated_at AS "updatedAt",checks.next_check_at AS "nextCheckAt"
      FROM inventory.stock_link_checks checks JOIN jsonb_to_recordset($1::jsonb)
        AS selected("publicationTargetId" integer,"productVariantId" integer)
        ON selected."publicationTargetId"=checks.publication_target_id AND selected."productVariantId"=checks.product_variant_id
      ORDER BY checks.publication_target_id,checks.product_variant_id`,
    [JSON.stringify(missing.map(row => ({ publicationTargetId: row.publicationTargetId, productVariantId: row.productVariantId })))])).rows;
  return new Map(checks.map(check => {
    // A historical refusal is not evidence of the current provider status. In
    // particular, Shopify drafts can now qualify without publishing the product.
    const guidance = check.reasonCode !== "STOCK_LINK_NOT_ON_SALE" ? ""
      : providerByScope.get(scopeKey(check)) === "shopify"
        ? " Shopify ACTIVE and DRAFT products can qualify for stock linking. Use Check again in Channel Inventory to recheck this saved result. Linking does not publish the product."
        : " Recheck current provider eligibility before creating a stock link; this saved result is not a new provider check.";
    return [scopeKey(check), [
      `Last saved stock-link check: ${check.reasonCode ?? check.status} (${check.status}); updated ${check.updatedAt.toISOString()}.`
        + guidance
        + (check.nextCheckAt ? ` Next check scheduled for ${check.nextCheckAt.toISOString()}.` : " No automatic retry is scheduled."),
    ]];
  }));
}

function destination(target: { publicationTargetId: number; channelId: number; channelName: string; providerKey: string; externalScopeId: string }) {
  return { publicationTargetId: target.publicationTargetId, channelId: target.channelId, channelName: target.channelName,
    providerKey: target.providerKey, externalScopeId: target.externalScopeId };
}
async function readOutboxRows(client: PoolClient, scopes: readonly Scope[]): Promise<OutboxRow[]> {
  return (await client.query<OutboxRow>(`SELECT DISTINCT ON (outbox.publication_target_id,outbox.product_variant_id)
    outbox.publication_target_id AS "publicationTargetId",outbox.product_variant_id AS "productVariantId",
    outbox.id::text AS "outboxId",outbox.desired_revision::text AS revision,outbox.desired_quantity::text AS quantity,
    outbox.external_inventory_item_id_snapshot AS "externalInventoryItemId",outbox.channel_id_snapshot AS "channelId",
    outbox.provider_key_snapshot AS "providerKey",outbox.external_scope_id_snapshot AS "externalScopeId",outbox.state
    FROM inventory.inventory_publication_outbox outbox JOIN jsonb_to_recordset($1::jsonb)
      AS selected("publicationTargetId" integer,"productVariantId" integer)
      ON selected."publicationTargetId"=outbox.publication_target_id AND selected."productVariantId"=outbox.product_variant_id
    WHERE outbox.publication_phase='full'
    ORDER BY outbox.publication_target_id,outbox.product_variant_id,outbox.desired_revision DESC`,
  [JSON.stringify(scopes.map(row => ({ publicationTargetId: row.publicationTargetId, productVariantId: row.productVariantId })))])).rows;
}
function failure(code: string, message: string, status = 409): InventoryProductSyncError {
  return new InventoryProductSyncError(`PRODUCT_SYNC_${code}`, message, status);
}
function canonicalRequired(): InventoryProductSyncError { return failure("CANONICAL_REQUIRED", "Complete ATP setup before syncing this product."); }
