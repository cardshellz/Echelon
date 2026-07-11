import { and, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import {
  poEvents,
  poStatusHistory,
  productVariants,
  products,
  purchaseOrderLines,
  purchaseOrders,
  purchasingRecommendationDecisions,
  purchasingRecommendationPoHandoffs,
  vendorProducts,
  vendors,
} from "@shared/schema";
import { db as defaultDatabase } from "../../db";
import type {
  CreatedRecommendationPurchaseOrder,
  CreatedRecommendationPurchaseOrderLine,
  NewRecommendationDecisionRecord,
  NewRecommendationPoHandoffRecord,
  NewRecommendationPurchaseOrder,
  NewRecommendationPurchaseOrderLine,
  RecommendationDecisionRecord,
  RecommendationKind,
  RecommendationPoHandoffRecord,
  RecommendationPoHandoffRepository,
  RecommendationPoHandoffUnitOfWork,
  RecommendationProductRecord,
  RecommendationProductVariantRecord,
  RecommendationVendorProductRecord,
  RecommendationVendorRecord,
} from "./recommendation-po-handoff.service";

type Database = Pick<typeof defaultDatabase, "transaction">;
type Transaction = Parameters<Parameters<typeof defaultDatabase.transaction>[0]>[0];

const MAX_PO_NUMBER_ATTEMPTS = 10_000;
const RECOMMENDATION_LOCK_PREFIX = "procurement:purchasing-recommendation:";

function uniquePositiveIds(ids: readonly number[]): number[] {
  return [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0);
}

function poNumberPrefix(numberDate: Date): string {
  return `PO-${numberDate.toISOString().slice(0, 10).replace(/-/g, "")}-`;
}

function nextPoNumberSequence(existingPoNumbers: readonly string[], prefix: string): number {
  let maximum = 0;
  for (const poNumber of existingPoNumbers) {
    if (!poNumber.startsWith(prefix)) continue;
    const suffix = poNumber.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    const value = Number.parseInt(suffix, 10);
    if (Number.isSafeInteger(value) && value > maximum) maximum = value;
  }
  return maximum + 1;
}

function createUnitOfWork(tx: Transaction): RecommendationPoHandoffUnitOfWork {
  return {
    async lockRecommendationKeys(keys) {
      for (const key of [...new Set(keys)].sort()) {
        await tx.execute(sql`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${`${RECOMMENDATION_LOCK_PREFIX}${key}`}, 0::bigint)
          )
        `);
      }
    },

    async getDecisionsForUpdate(ids) {
      const safeIds = uniquePositiveIds(ids);
      if (safeIds.length === 0) return [];
      return await tx
        .select()
        .from(purchasingRecommendationDecisions)
        .where(inArray(purchasingRecommendationDecisions.id, safeIds))
        .for("update") as RecommendationDecisionRecord[];
    },

    async getLatestActiveDecisions(keys) {
      if (keys.length === 0) return [];
      const keyConditions = keys.map((key) => and(
        eq(purchasingRecommendationDecisions.recommendationId, key.recommendationId),
        eq(purchasingRecommendationDecisions.kind, key.kind),
      ));
      const matchingKeys = or(...keyConditions);
      if (!matchingKeys) return [];
      return await tx
        .select()
        .from(purchasingRecommendationDecisions)
        .where(and(
          eq(purchasingRecommendationDecisions.status, "active"),
          matchingKeys,
        ))
        .orderBy(
          desc(purchasingRecommendationDecisions.decidedAt),
          desc(purchasingRecommendationDecisions.id),
        ) as RecommendationDecisionRecord[];
    },

    async getHandoffsByAcceptedDecisionIds(ids) {
      const safeIds = uniquePositiveIds(ids);
      if (safeIds.length === 0) return [];
      return await tx
        .select()
        .from(purchasingRecommendationPoHandoffs)
        .where(inArray(purchasingRecommendationPoHandoffs.acceptedDecisionId, safeIds)) as RecommendationPoHandoffRecord[];
    },

    async getVendorProducts(ids) {
      const safeIds = uniquePositiveIds(ids);
      if (safeIds.length === 0) return [];
      return await tx
        .select({
          id: vendorProducts.id,
          vendorId: vendorProducts.vendorId,
          productId: vendorProducts.productId,
          productVariantId: vendorProducts.productVariantId,
          vendorSku: vendorProducts.vendorSku,
          unitCostCents: vendorProducts.unitCostCents,
          unitCostMills: vendorProducts.unitCostMills,
          isPreferred: vendorProducts.isPreferred,
          isActive: vendorProducts.isActive,
        })
        .from(vendorProducts)
        .where(inArray(vendorProducts.id, safeIds))
        .for("share") as RecommendationVendorProductRecord[];
    },

    async getVendors(ids) {
      const safeIds = uniquePositiveIds(ids);
      if (safeIds.length === 0) return [];
      return await tx
        .select({
          id: vendors.id,
          active: vendors.active,
          currency: vendors.currency,
          paymentTermsDays: vendors.paymentTermsDays,
          paymentTermsType: vendors.paymentTermsType,
          shipFromAddress: vendors.shipFromAddress,
          defaultIncoterms: vendors.defaultIncoterms,
        })
        .from(vendors)
        .where(inArray(vendors.id, safeIds))
        .for("share") as RecommendationVendorRecord[];
    },

    async getProducts(ids) {
      const safeIds = uniquePositiveIds(ids);
      if (safeIds.length === 0) return [];
      return await tx
        .select({
          id: products.id,
          sku: products.sku,
          name: products.name,
          status: products.status,
          isActive: products.isActive,
        })
        .from(products)
        .where(inArray(products.id, safeIds))
        .for("share") as RecommendationProductRecord[];
    },

    async getProductVariants(ids) {
      const safeIds = uniquePositiveIds(ids);
      if (safeIds.length === 0) return [];
      return await tx
        .select({
          id: productVariants.id,
          productId: productVariants.productId,
          sku: productVariants.sku,
          name: productVariants.name,
          unitsPerVariant: productVariants.unitsPerVariant,
          isActive: productVariants.isActive,
        })
        .from(productVariants)
        .where(inArray(productVariants.id, safeIds))
        .for("share") as RecommendationProductVariantRecord[];
    },

    async createPurchaseOrder(values, numberDate) {
      const prefix = poNumberPrefix(numberDate);
      const existingRows = await tx
        .select({ poNumber: purchaseOrders.poNumber })
        .from(purchaseOrders)
        .where(like(purchaseOrders.poNumber, `${prefix}%`));
      const firstSequence = nextPoNumberSequence(
        existingRows.map((row) => row.poNumber),
        prefix,
      );

      for (let attempt = 0; attempt < MAX_PO_NUMBER_ATTEMPTS; attempt += 1) {
        const sequence = firstSequence + attempt;
        if (!Number.isSafeInteger(sequence)) break;
        const poNumber = `${prefix}${String(sequence).padStart(3, "0")}`;
        const [created] = await tx
          .insert(purchaseOrders)
          .values({ ...values, poNumber })
          .onConflictDoNothing()
          .returning();
        if (created) return created as CreatedRecommendationPurchaseOrder;
      }

      throw new Error(`Unable to reserve a purchase order number for ${prefix}`);
    },

    async createPurchaseOrderLine(values) {
      const [created] = await tx
        .insert(purchaseOrderLines)
        .values(values)
        .returning();
      if (!created) throw new Error("Purchase order line insert returned no row");
      return created as CreatedRecommendationPurchaseOrderLine;
    },

    async createStatusHistory(values) {
      await tx.insert(poStatusHistory).values(values);
    },

    async createPoEvent(values) {
      await tx.insert(poEvents).values(values);
    },

    async createDecision(values) {
      const [created] = await tx
        .insert(purchasingRecommendationDecisions)
        .values(values)
        .returning();
      if (!created) throw new Error("Purchasing recommendation decision insert returned no row");
      return created as RecommendationDecisionRecord;
    },

    async createHandoff(values) {
      const [created] = await tx
        .insert(purchasingRecommendationPoHandoffs)
        .values(values)
        .returning();
      if (!created) throw new Error("Purchasing recommendation PO handoff insert returned no row");
      return created as RecommendationPoHandoffRecord;
    },
  };
}

export function createDrizzleRecommendationPoHandoffRepository(
  database: Database = defaultDatabase,
): RecommendationPoHandoffRepository {
  return {
    transaction<T>(work: (unitOfWork: RecommendationPoHandoffUnitOfWork) => Promise<T>): Promise<T> {
      return database.transaction(async (tx) => work(createUnitOfWork(tx as Transaction)));
    },
  };
}

export const recommendationPoHandoffRepository = createDrizzleRecommendationPoHandoffRepository();

export type {
  NewRecommendationDecisionRecord,
  NewRecommendationPoHandoffRecord,
  NewRecommendationPurchaseOrder,
  NewRecommendationPurchaseOrderLine,
  RecommendationKind,
};
