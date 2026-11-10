import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { db as applicationDatabase } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import { productLocations, productMergeRuns, products, productVariants, type ProductMergeRunRow } from "@shared/schema";
import {
  productMergeExecuteSchema,
  productMergeResultSchema,
  productMergeRunOrderSchema,
  productMergeRunStatuses,
  type ProductMergeResult,
} from "@shared/catalog/product-merge";
import {
  archiveProductReplenishmentInTx,
  lockInventoryCostGraph,
  openOperationalQuantityPosting,
  type InventoryUseCases,
} from "../../inventory/catalog-inventory.api";
import {
  reassignOrderLineVariant,
  resolveAssignedBinLocation,
} from "../../oms/channel-order-intake.api";
import { reassignWmsOrderItemVariant } from "../../wms/order-item-commands";
import { mergePurchasingProductIdentity, readPurchasingMergeEvidence } from "../../procurement/purchasing-product-merge";
import { productMethods as catalogStorage } from "../catalog.storage";
import { renameDerivedVariantSkus } from "../application/product-sku-rename";
import {
  ProductMergeError,
  type ProductMergeRepository,
  type ProductMergeRunRecord,
} from "../application/product-merge.service";
import {
  deriveVariantSku,
  retiredSku,
  type MergeOpenOrderLine,
  type MergeVariantRow,
  type ProductMergeSnapshot,
} from "../domain/product-merge";

type Database = typeof applicationDatabase;
type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Executor = Database | Tx;

/** Warehouse states that are finished; their items are history, not open demand. */
const CLOSED_WAREHOUSE_STATUSES = ["shipped", "cancelled", "completed"];
/** OMS states with no remaining fulfillment. */
const CLOSED_OMS_STATUSES = ["shipped", "cancelled", "refunded"];
/** OMS-only lines (not yet materialized in WMS) are movable only before any fulfillment. */
const UNSTARTED_OMS_STATUSES = new Set(["pending", "confirmed"]);
const PG_UNIQUE_VIOLATION = "23505";

const rowsOf = <T>(result: unknown): T[] => (result as { rows: T[] }).rows;
/** Drizzle expands a JS array into a parameter LIST; these build a real
 * Postgres array (empty arrays included) for use with = ANY(...). */
const intArray = (values: readonly number[]) => values.length === 0
  ? sql`'{}'::int[]` : sql`ARRAY[${sql.join(values.map(value => sql`${value}`), sql`, `)}]::int[]`;
const textArray = (values: readonly string[]) => values.length === 0
  ? sql`'{}'::text[]` : sql`ARRAY[${sql.join(values.map(value => sql`${value}`), sql`, `)}]::text[]`;
const num = (value: unknown): number => Number(value ?? 0);
const numOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/**
 * Reads every fact the merge decision depends on. With `lock`, rows are locked
 * in a fixed order (cost graph → products → variants → levels) matching the
 * catalog inventory command, so concurrent stock writers cannot deadlock us.
 */
export async function loadProductMergeSnapshot(executor: Executor, sourceProductId: number, targetProductId: number, lock: boolean): Promise<ProductMergeSnapshot> {
  const forUpdate = lock ? sql`FOR UPDATE` : sql``;
  const productIds = [sourceProductId, targetProductId].sort((a, b) => a - b);
  const productRows = rowsOf<Record<string, unknown>>(await executor.execute(sql`
    SELECT id, sku, name, status, COALESCE(is_active, true) AS "isActive"
    FROM catalog.products WHERE id = ANY(${intArray(productIds)}) ORDER BY id ${forUpdate}`));
  const product = (id: number) => {
    const row = productRows.find(candidate => num(candidate.id) === id);
    return row ? { id, sku: (row.sku as string | null) ?? null, name: String(row.name ?? ""),
      status: (row.status as string | null) ?? null, isActive: Boolean(row.isActive) } : null;
  };
  const variantRows = rowsOf<Record<string, unknown>>(await executor.execute(sql`
    SELECT id, product_id AS "productId", sku, name, COALESCE(units_per_variant, 1) AS "unitsPerVariant",
           COALESCE(is_active, true) AS "isActive", COALESCE(track_inventory, true) AS "trackInventory"
    FROM catalog.product_variants WHERE product_id = ANY(${intArray(productIds)}) ORDER BY id ${forUpdate}`));
  const variants: MergeVariantRow[] = variantRows.map(row => ({
    id: num(row.id), productId: num(row.productId), sku: (row.sku as string | null) ?? null, name: String(row.name ?? ""),
    unitsPerVariant: num(row.unitsPerVariant), isActive: Boolean(row.isActive), trackInventory: Boolean(row.trackInventory),
  }));
  const sourceVariants = variants.filter(variant => variant.productId === sourceProductId);
  const targetVariants = variants.filter(variant => variant.productId === targetProductId);
  const sourceVariantIds = sourceVariants.map(variant => variant.id);
  const allVariantIds = variants.map(variant => variant.id);

  const stock = rowsOf<Record<string, unknown>>(await executor.execute(sql`
    SELECT id, product_variant_id AS "productVariantId", variant_qty AS "onHand", reserved_qty AS reserved,
           picked_qty AS picked, packed_qty AS packed
    FROM inventory.inventory_levels WHERE product_variant_id = ANY(${intArray(allVariantIds)})
    ORDER BY warehouse_location_id, product_variant_id, id ${forUpdate}`)).map(row => ({
    productVariantId: num(row.productVariantId), onHand: num(row.onHand), reserved: num(row.reserved),
    picked: num(row.picked), packed: num(row.packed),
  }));

  const binAssignments = rowsOf<Record<string, unknown>>(await executor.execute(sql`
    SELECT product_variant_id AS "productVariantId", count(*)::int AS count
    FROM warehouse.product_locations WHERE product_variant_id = ANY(${intArray(sourceVariantIds)}) GROUP BY 1`))
    .map(row => ({ productVariantId: num(row.productVariantId), count: num(row.count) }));

  // Open demand on the source: every unfinished WMS item, plus OMS lines that
  // have not materialized into WMS yet.
  const wmsLines = rowsOf<Record<string, unknown>>(await executor.execute(sql`
    SELECT item.id AS "wmsItemId", item.order_id AS "wmsOrderId", w.order_number AS "orderNumber",
           w.warehouse_status AS "warehouseStatus", item.product_id AS "productVariantId",
           item.quantity, item.picked_quantity AS "pickedQuantity", item.fulfilled_quantity AS "fulfilledQuantity",
           line.id AS "omsLineId", line.order_id AS "omsOrderId",
           EXISTS (SELECT 1 FROM wms.fulfillment_plan_lines plan WHERE plan.wms_order_item_id = item.id) AS "hasFulfillmentPlan"
    FROM wms.order_items item
    JOIN wms.orders w ON w.id = item.order_id
    LEFT JOIN oms.oms_order_lines line ON line.id = item.oms_order_line_id AND line.product_variant_id = item.product_id
    WHERE item.product_id = ANY(${intArray(sourceVariantIds)})
      AND w.warehouse_status <> ALL(${textArray(CLOSED_WAREHOUSE_STATUSES)})
    ORDER BY item.order_id, item.id ${lock ? sql`FOR UPDATE OF item` : sql``}`));
  const omsOnlyLines = rowsOf<Record<string, unknown>>(await executor.execute(sql`
    SELECT line.id AS "omsLineId", line.order_id AS "omsOrderId", o.external_order_number AS "orderNumber",
           o.status AS "omsStatus", line.product_variant_id AS "productVariantId", line.quantity
    FROM oms.oms_order_lines line
    JOIN oms.oms_orders o ON o.id = line.order_id
    WHERE line.product_variant_id = ANY(${intArray(sourceVariantIds)})
      AND o.status <> ALL(${textArray(CLOSED_OMS_STATUSES)})
      AND NOT EXISTS (SELECT 1 FROM wms.order_items item WHERE item.oms_order_line_id = line.id)
    ORDER BY line.order_id, line.id ${lock ? sql`FOR UPDATE OF line` : sql``}`));
  const openOrderLines: MergeOpenOrderLine[] = [
    ...wmsLines.map(row => ({
      omsOrderId: numOrNull(row.omsOrderId), omsLineId: numOrNull(row.omsLineId), wmsOrderId: num(row.wmsOrderId),
      wmsItemId: num(row.wmsItemId), orderNumber: (row.orderNumber as string | null) ?? null,
      warehouseStatus: String(row.warehouseStatus), productVariantId: num(row.productVariantId), quantity: num(row.quantity),
      pickedQuantity: num(row.pickedQuantity), fulfilledQuantity: num(row.fulfilledQuantity),
      hasFulfillmentPlan: Boolean(row.hasFulfillmentPlan),
    })),
    ...omsOnlyLines.map(row => ({
      omsOrderId: num(row.omsOrderId), omsLineId: num(row.omsLineId), wmsOrderId: null, wmsItemId: null,
      orderNumber: (row.orderNumber as string | null) ?? null,
      // A started OMS-only order carries a non-null state so the domain blocks it.
      warehouseStatus: UNSTARTED_OMS_STATUSES.has(String(row.omsStatus)) ? null : `oms:${String(row.omsStatus)}`,
      productVariantId: num(row.productVariantId), quantity: num(row.quantity),
      pickedQuantity: 0, fulfilledQuantity: 0, hasFulfillmentPlan: false,
    })),
  ];

  const purchasing = await readPurchasingMergeEvidence(executor, sourceProductId);

  const channelLinks = rowsOf<Record<string, unknown>>(await executor.execute(sql`
    SELECT
      (SELECT count(*) FROM channels.channel_listings WHERE product_variant_id = ANY(${intArray(sourceVariantIds)}))
    + (SELECT count(*) FROM channels.channel_feeds WHERE product_variant_id = ANY(${intArray(sourceVariantIds)}) AND is_active = 1)
    + (SELECT count(*) FROM channels.channel_product_identities WHERE product_id = ${sourceProductId})
    + (SELECT count(*) FROM inventory.publication_variant_mapping_heads WHERE product_variant_id = ANY(${intArray(sourceVariantIds)}))
      AS links`))[0];

  // SKU candidates the merge could produce; only collisions outside S and T matter.
  const source = product(sourceProductId);
  const target = product(targetProductId);
  const candidateSkus = [
    source?.sku,
    ...targetVariants.map(variant => deriveVariantSku(target?.sku ?? null, source?.sku ?? null, variant.sku)),
  ].filter((sku): sku is string => Boolean(sku)).map(sku => sku.toUpperCase());
  const foreignActiveVariantSkus = candidateSkus.length === 0 ? [] : rowsOf<{ sku: string }>(await executor.execute(sql`
    SELECT upper(sku) AS sku FROM catalog.product_variants
    WHERE is_active = true AND upper(sku) = ANY(${textArray(candidateSkus)}) AND product_id <> ALL(${intArray(productIds)})`))
    .map(row => row.sku);
  const foreignProductSkus = candidateSkus.length === 0 ? [] : rowsOf<{ sku: string }>(await executor.execute(sql`
    SELECT upper(sku) AS sku FROM catalog.products
    WHERE upper(sku) = ANY(${textArray(candidateSkus)}) AND id <> ALL(${intArray(productIds)})`)).map(row => row.sku);

  const history = rowsOf<Record<string, unknown>>(await executor.execute(sql`
    SELECT
      (SELECT count(*) FROM oms.oms_order_lines line JOIN oms.oms_orders o ON o.id = line.order_id
        WHERE line.product_variant_id = ANY(${intArray(sourceVariantIds)}) AND o.status = 'shipped') AS "shippedOrderLines",
      (SELECT count(*) FROM inventory.inventory_transactions
        WHERE product_variant_id = ANY(${intArray(sourceVariantIds)})) AS "inventoryTransactions"`))[0];

  return {
    source, target, sourceVariants, targetVariants, stock, binAssignments, openOrderLines,
    purchaseLines: purchasing.lines, supplierLinks: purchasing.supplierLinks,
    sourceChannelLinks: num(channelLinks?.links),
    foreignActiveVariantSkus, foreignProductSkus,
    history: { shippedOrderLines: num(history?.shippedOrderLines), inventoryTransactions: num(history?.inventoryTransactions) },
  };
}

function toRecord(row: ProductMergeRunRow): ProductMergeRunRecord {
  const request = productMergeExecuteSchema.parse(row.request);
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    requestHash: row.requestHash,
    request,
    actor: row.actor,
    status: (productMergeRunStatuses as readonly string[]).includes(row.status)
      ? row.status as ProductMergeRunRecord["status"]
      : (() => { throw new ProductMergeError("MERGE_RUN_CORRUPT", `Unknown merge run status ${row.status}`, 500); })(),
    sourceProductId: row.sourceProductId,
    targetProductId: row.targetProductId,
    orders: productMergeRunOrderSchema.array().parse(row.orders),
    result: row.result === null ? null : productMergeResultSchema.parse(row.result),
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class PostgresProductMergeRepository implements ProductMergeRepository {
  constructor(private readonly database: Database, private readonly inventory: InventoryUseCases,
    private readonly reportEffectFailure: (error: unknown) => void) {}

  loadSnapshot(sourceProductId: number, targetProductId: number): Promise<ProductMergeSnapshot> {
    // One read-only snapshot so counts across tables are mutually consistent.
    return this.database.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`);
      return loadProductMergeSnapshot(tx, sourceProductId, targetProductId, false);
    });
  }

  async findRunByKey(idempotencyKey: string) {
    const [row] = await this.database.select().from(productMergeRuns).where(eq(productMergeRuns.idempotencyKey, idempotencyKey));
    return row ? toRecord(row) : null;
  }

  async findRun(runId: number) {
    const [row] = await this.database.select().from(productMergeRuns).where(eq(productMergeRuns.id, runId));
    return row ? toRecord(row) : null;
  }

  async createRun(input: Parameters<ProductMergeRepository["createRun"]>[0]) {
    try {
      const [row] = await this.database.insert(productMergeRuns).values({
        idempotencyKey: input.idempotencyKey, requestHash: input.requestHash,
        sourceProductId: input.sourceProductId, targetProductId: input.request.targetProductId,
        request: input.request, status: "releasing", orders: input.orders, actor: input.actor,
        createdAt: input.now, updatedAt: input.now,
      }).returning();
      return toRecord(row);
    } catch (error) {
      if ((error as { code?: string }).code === PG_UNIQUE_VIOLATION) {
        const replay = await this.findRunByKey(input.idempotencyKey);
        if (replay) return replay;
        throw new ProductMergeError("MERGE_RUN_ACTIVE", "Another merge of one of these products is still running", 409);
      }
      throw error;
    }
  }

  async updateRun(run: Pick<ProductMergeRunRecord, "id" | "updatedAt">, expectedStatus: ProductMergeRunRecord["status"],
    patch: Parameters<ProductMergeRepository["updateRun"]>[2], now: Date) {
    const [row] = await this.database.update(productMergeRuns).set({ ...patch, updatedAt: now })
      .where(and(eq(productMergeRuns.id, run.id), eq(productMergeRuns.status, expectedStatus),
        eq(productMergeRuns.updatedAt, new Date(run.updatedAt)))).returning();
    if (!row) throw new ProductMergeError("MERGE_RUN_CONCURRENT_UPDATE", "The merge run was advanced by another request", 409, "transient");
    return toRecord(row);
  }

  async merge({ run, evaluate, now }: Parameters<ProductMergeRepository["merge"]>[0]) {
    const effects: Array<() => Promise<void>> = [];
    const outcome = await this.database.transaction(async tx => {
      // Lock order: cost graph → run → products/variants/levels (inside loadSnapshot).
      await lockInventoryCostGraph(tx);
      const [locked] = await tx.select().from(productMergeRuns).where(eq(productMergeRuns.id, run.id)).for("update");
      if (!locked || locked.status !== "merging" || locked.updatedAt.toISOString() !== run.updatedAt) {
        throw new ProductMergeError("MERGE_RUN_CONCURRENT_UPDATE", "The merge run is no longer waiting to merge", 409, "transient");
      }
      const snapshot = await loadProductMergeSnapshot(tx, run.sourceProductId, run.targetProductId, true);
      const decision = evaluate(snapshot);
      if (decision.blocked) throw new ProductMergeError("MERGE_BLOCKED", "A new blocker appeared; nothing was moved", 409);
      if (decision.hash !== run.request.expectedPreviewHash) {
        throw new ProductMergeError("MERGE_PREVIEW_STALE", "The products changed since the preview; nothing was moved", 409);
      }
      const source = snapshot.source!;
      const target = snapshot.target!;
      const pairs = decision.pairs;
      const variantMap = new Map(pairs.map(pair => [pair.source.id, pair.target!.id]));
      const sourceIds = new Set(variantMap.keys());

      // Releasing the open orders must have freed every source unit.
      const held = snapshot.stock.filter(row => sourceIds.has(row.productVariantId) && (row.reserved || row.picked || row.packed));
      if (held.length > 0) {
        throw new ProductMergeError("MERGE_STOCK_STILL_HELD",
          "Some source stock is still reserved or picked by something other than the released orders; nothing was moved", 409,
          "permanent", { variantIds: [...new Set(held.map(row => row.productVariantId))] });
      }

      // 1. Stock: exact lot/cost conversion through the quantity ledger.
      const posting = await openOperationalQuantityPosting(tx);
      const commandKey = `product-merge:${run.id}`;
      const replay = await posting?.beginOperation(commandKey, { contractVersion: "product_merge_v1", runId: run.id,
        sourceProductId: run.sourceProductId, targetProductId: run.targetProductId });
      if (replay) throw new ProductMergeError("MERGE_LEDGER_REPLAY", "The stock move for this run was already posted", 409);
      const inventory = this.inventory.withTx(tx);
      let stockUnitsMoved = 0;
      let stockLocationsMoved = 0;
      const expectedUnits = snapshot.stock.filter(row => sourceIds.has(row.productVariantId)).reduce((sum, row) => sum + row.onHand, 0);
      for (const pair of pairs) {
        if (!snapshot.stock.some(row => row.productVariantId === pair.source.id && row.onHand > 0)) continue;
        const childKey = `product-merge-child:${createHash("sha256").update(JSON.stringify([run.id, pair.source.id])).digest("hex")}`;
        const moved = await inventory.convertSku({
          fromVariantId: pair.source.id, toVariantId: pair.target!.id, commandKey: childKey,
          notes: `Product merge ${run.id}: ${pair.source.sku} → ${pair.target!.sku}`, userId: run.actor,
          deferUntilCommit: (effect: () => Promise<void>) => effects.push(effect),
        }, posting ?? undefined);
        stockUnitsMoved += moved.totalConverted;
        stockLocationsMoved += moved.conversions.length;
      }
      if (stockUnitsMoved !== expectedUnits) {
        throw new ProductMergeError("MERGE_TRANSFER_INCOMPLETE",
          `Expected to move ${expectedUnits} units but moved ${stockUnitsMoved}; nothing was moved`, 409);
      }
      if (posting && stockUnitsMoved > 0) {
        await posting.post({ idempotencyKey: commandKey, kind: "transform", actor: run.actor,
          reason: `Product merge ${run.id}: product ${run.sourceProductId} into ${run.targetProductId}`,
          reference: { type: "product_merge", id: String(run.id) }, occurredAt: now.toISOString() });
      }

      // 2. Bin assignments follow the stock (a duplicate slot is dropped).
      let binAssignmentsMoved = 0;
      for (const [sourceId, targetId] of variantMap) {
        const targetSlots = await tx.select({ locationId: productLocations.warehouseLocationId }).from(productLocations)
          .where(eq(productLocations.productVariantId, targetId));
        const occupied = targetSlots.map(slot => slot.locationId).filter((id): id is number => id !== null);
        const targetVariant = snapshot.targetVariants.find(variant => variant.id === targetId)!;
        if (occupied.length > 0) {
          await tx.delete(productLocations).where(and(eq(productLocations.productVariantId, sourceId),
            inArray(productLocations.warehouseLocationId, occupied)));
        }
        binAssignmentsMoved += (await tx.update(productLocations)
          .set({ productVariantId: targetId, productId: run.targetProductId, sku: targetVariant.sku, updatedAt: now })
          .where(eq(productLocations.productVariantId, sourceId)).returning({ id: productLocations.id })).length;
      }

      // 3. Open order lines (their reservations were released in the previous step).
      let orderLinesMoved = 0;
      const channelByOmsOrder = new Map<number, number>();
      for (const line of snapshot.openOrderLines.filter(candidate => sourceIds.has(candidate.productVariantId))) {
        const targetVariant = snapshot.targetVariants.find(variant => variant.id === variantMap.get(line.productVariantId))!;
        if (line.omsLineId !== null && line.omsOrderId !== null) {
          let channelId = channelByOmsOrder.get(line.omsOrderId);
          if (channelId === undefined) {
            channelId = num(rowsOf<{ channelId: number }>(await tx.execute(sql`
              SELECT channel_id AS "channelId" FROM oms.oms_orders WHERE id = ${line.omsOrderId}`))[0]?.channelId);
            channelByOmsOrder.set(line.omsOrderId, channelId);
          }
          await reassignOrderLineVariant(tx, {
            orderId: line.omsOrderId, orderLineId: line.omsLineId, channelId, fromVariantId: line.productVariantId,
            to: { variantId: targetVariant.id, productId: run.targetProductId, sku: targetVariant.sku ?? "",
              inventoryTracking: targetVariant.trackInventory },
            mergeRunId: run.id, now,
          });
        }
        if (line.wmsItemId !== null) {
          const bin = await resolveAssignedBinLocation(tx, targetVariant.id);
          await reassignWmsOrderItemVariant(tx, {
            itemId: line.wmsItemId, fromVariantId: line.productVariantId, toVariantId: targetVariant.id,
            toCatalogProductId: run.targetProductId, sku: targetVariant.sku ?? "",
            ...(bin ? { location: bin.location, zone: bin.zone } : {}),
          });
        }
        orderLinesMoved++;
      }

      // 4. Purchasing (procurement-owned command).
      const resultingTargetProductSku = run.request.adoptSourceSku ? source.sku : target.sku;
      const skuMap = new Map<string, string>();
      if (source.sku && resultingTargetProductSku) skuMap.set(source.sku, resultingTargetProductSku);
      for (const pair of pairs) {
        const finalSku = run.request.adoptSourceSku ? deriveVariantSku(target.sku, source.sku, pair.target!.sku) : pair.target!.sku;
        if (pair.source.sku && finalSku) skuMap.set(pair.source.sku, finalSku);
      }
      const purchasing = await mergePurchasingProductIdentity(tx, {
        sourceProductId: run.sourceProductId, targetProductId: run.targetProductId, variantMap, skuMap,
        actorId: run.actor, mergeRunId: run.id, now,
      });

      // 5. Retire the source. Its SKUs get a -MERGED-<id> suffix: products.sku
      // is unique even when archived, and the suffix frees the SKU text for the
      // target while history rows keep the text they were written with.
      for (const variant of snapshot.sourceVariants) {
        await tx.update(productVariants).set({ isActive: false, sku: retiredSku(variant.sku, variant.id), updatedAt: now })
          .where(eq(productVariants.id, variant.id));
      }
      await archiveProductReplenishmentInTx(tx, run.sourceProductId, now);
      await tx.update(products).set({ isActive: false, status: "archived", sku: retiredSku(source.sku, source.id), updatedAt: now })
        .where(eq(products.id, run.sourceProductId));

      // 6. Optionally adopt the source SKU, through the same cascade the
      // product edit uses (variant SKUs, bins, WMS items, procurement refs).
      let variantsRenamed = 0;
      if (run.request.adoptSourceSku && source.sku && source.sku !== target.sku) {
        await tx.update(products).set({ sku: source.sku, updatedAt: now }).where(eq(products.id, run.targetProductId));
        variantsRenamed = await renameDerivedVariantSkus(tx, catalogStorage, {
          productId: run.targetProductId, oldProductSku: target.sku, newProductSku: source.sku, actor: run.actor,
        });
      }

      // 7. Channel stock for the surviving product is recomputed by the publisher.
      await tx.execute(sql`SELECT inventory.invalidate_publication_selection_product(${run.targetProductId})`);

      const result: ProductMergeResult = productMergeResultSchema.parse({
        stockUnitsMoved, stockLocationsMoved, orderLinesMoved,
        purchaseOrderLinesMoved: purchasing.linesMoved,
        supplierLinksMoved: purchasing.supplierLinksMoved + purchasing.supplierLinksRetired,
        binAssignmentsMoved, variantsRenamed,
        sourceProductSku: retiredSku(source.sku, source.id),
        targetProductSku: resultingTargetProductSku,
      });
      if (posting) {
        if (stockUnitsMoved > 0) await posting.finishOperation({ runId: run.id, result });
        else await posting.finishNoMovement({ runId: run.id, result });
      }
      await persistAuditEvent(tx, {
        actor: run.actor, action: "catalog.product_merged", target: `product:${run.sourceProductId}`,
        changes: {
          before: { source, target, sourceVariants: snapshot.sourceVariants, targetVariants: snapshot.targetVariants },
          after: { sourceProductSku: result.sourceProductSku, targetProductSku: result.targetProductSku, variantMap: [...variantMap] },
        },
        context: { mergeRunId: run.id, previewHash: run.request.expectedPreviewHash, result },
      }, { timestamp: now, emitStructuredLog: false });

      const [advanced] = await tx.update(productMergeRuns).set({ status: "reclaiming", result, errorCode: null, errorMessage: null, updatedAt: now })
        .where(and(eq(productMergeRuns.id, run.id), eq(productMergeRuns.status, "merging"))).returning();
      return { run: toRecord(advanced), result };
    });
    // Post-commit notifications (channel stock pushes). Best effort by design:
    // the publication invalidation above already queued the durable work.
    for (const effect of effects) {
      try { await effect(); } catch (error) { this.reportEffectFailure(error); }
    }
    return outcome;
  }
}

