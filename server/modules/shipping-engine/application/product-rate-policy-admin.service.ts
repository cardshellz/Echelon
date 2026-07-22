import { createHash } from "crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  productCategories,
  productLineProducts,
  productLines,
  productVariants,
  products,
  shippingGroups,
  shippingProductSetMembers,
  shippingProductSets,
  shippingRateRuleBands,
  shippingRateRuleMembers,
  shippingRateRules,
  shippingRateTableRows,
  shippingRateTables,
  shippingServiceLevels,
  shippingVariantAttrs,
  type ShippingProductSetSelectorKind,
  type ShippingRateRuleAction,
  type ShippingRateRuleDestinationScope,
  type ShippingRateRuleKind,
  type ShippingRateRuleMeasurementScope,
} from "@shared/schema";
import { db } from "../../../db";
import { persistAuditEvent } from "../../../infrastructure/auditLogger";
import {
  evaluateProductRatePolicy,
  validateProductRateRules,
  type ProductRateRule,
  type ProductRateRuleBand,
} from "../domain/product-rate-policy";
import {
  selectServiceLevelRates,
  type ShippingFulfillmentMode,
  type ShippingPricingBasis,
  type ShippingRateChargeModel,
} from "../domain/rate-selection";

export type ProductSetSelectorInput =
  | { kind: "manual"; variantIds: number[] }
  | { kind: "shipping_group" | "product_line" | "category" | "sioc"; ref: string }
  | { kind: "saved_set"; productSetId: number };

export interface ProductRateRuleDraftInput {
  name: string;
  kind: ShippingRateRuleKind;
  action: ShippingRateRuleAction;
  measurementScope: ShippingRateRuleMeasurementScope;
  destinationScope: ShippingRateRuleDestinationScope;
  selector: ProductSetSelectorInput;
  rateCents: number | null;
  perStartedPoundCents: number | null;
  thresholdCents: number | null;
  bands: ProductRateRuleBand[];
}

export interface ProductRatePolicyPreviewInput {
  originWarehouseId: number;
  destination: { country: string; region: string; postalCode: string };
  lines: Array<{ productVariantId: number; quantity: number; unitPriceCents: number }>;
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type LoadedProductRateRule = ProductRateRule & { sourceProductSetId: number | null };

export class ProductRatePolicyAdminError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: readonly string[],
  ) {
    super(message);
    this.name = "ProductRatePolicyAdminError";
  }
}

export async function listProductPolicySelectors(search = "") {
  const searchTerm = search.trim();
  const variantFilter = searchTerm === ""
    ? undefined
    : sql`(${productVariants.sku} ILIKE ${`%${searchTerm}%`} OR ${productVariants.name} ILIKE ${`%${searchTerm}%`} OR ${products.name} ILIKE ${`%${searchTerm}%`})`;
  const [groups, lines, categories, sets, variants] = await Promise.all([
    db.select({ code: shippingGroups.code, name: shippingGroups.name })
      .from(shippingGroups)
      .where(eq(shippingGroups.isActive, true))
      .orderBy(asc(shippingGroups.sortOrder), asc(shippingGroups.name)),
    db.select({ code: productLines.code, name: productLines.name })
      .from(productLines)
      .where(eq(productLines.isActive, true))
      .orderBy(asc(productLines.sortOrder), asc(productLines.name)),
    db.select({ id: productCategories.id, name: productCategories.name })
      .from(productCategories)
      .orderBy(asc(productCategories.name)),
    db.select({
      id: shippingProductSets.id,
      name: shippingProductSets.name,
      selectorKind: shippingProductSets.selectorKind,
      selectorRef: shippingProductSets.selectorRef,
      memberCount: sql<number>`count(${shippingProductSetMembers.id})::int`,
    })
      .from(shippingProductSets)
      .leftJoin(shippingProductSetMembers, eq(shippingProductSetMembers.productSetId, shippingProductSets.id))
      .where(eq(shippingProductSets.status, "active"))
      .groupBy(shippingProductSets.id)
      .orderBy(asc(shippingProductSets.name)),
    db.select({
      id: productVariants.id,
      sku: productVariants.sku,
      name: productVariants.name,
      productName: products.name,
      isActive: productVariants.isActive,
    })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(eq(productVariants.isActive, true), eq(products.isActive, true), variantFilter))
      .orderBy(asc(productVariants.sku), asc(productVariants.id))
      .limit(50),
  ]);
  return { shippingGroups: groups, productLines: lines, categories, productSets: sets, variants };
}

export async function listRateTableProductRules(rateTableId: number) {
  const [table] = await db.select({ id: shippingRateTables.id, status: shippingRateTables.status })
    .from(shippingRateTables)
    .where(eq(shippingRateTables.id, rateTableId))
    .limit(1);
  if (!table) throw notFound("Rate table not found.");

  const rules = await loadRules(db, rateTableId);
  const setIds = [...new Set(rules.flatMap((rule) => rule.sourceProductSetId ? [rule.sourceProductSetId] : []))];
  const sets = setIds.length === 0
    ? []
    : await db.select({ id: shippingProductSets.id, name: shippingProductSets.name })
        .from(shippingProductSets)
        .where(inArray(shippingProductSets.id, setIds));
  const setNames = new Map(sets.map((set) => [set.id, set.name]));
  return {
    rateTable: table,
    rules: rules.map((rule) => ({
      ...rule,
      productSetName: rule.sourceProductSetId ? setNames.get(rule.sourceProductSetId) ?? null : null,
    })),
    validationErrors: validateProductRateRules(rules),
  };
}

export async function createRateTableProductRule(
  rateTableId: number,
  input: ProductRateRuleDraftInput,
  actorUserId: string,
) {
  const actor = requireAuditActor(actorUserId);
  return db.transaction(async (tx) => {
    await lockDraftTable(tx, rateTableId);
    const { productSetId, variantIds } = await resolveSelector(tx, input.name, input.selector);
    const [created] = await tx.insert(shippingRateRules).values({
      rateTableId,
      sourceProductSetId: productSetId,
      name: input.name,
      kind: input.kind,
      action: input.action,
      measurementScope: input.measurementScope,
      destinationScope: input.destinationScope,
      rateCents: input.rateCents,
      perStartedPoundCents: input.perStartedPoundCents,
      thresholdCents: input.thresholdCents,
      isActive: true,
    }).returning();
    await replaceRuleChildren(tx, created.id, variantIds, input.bands);
    await assertValidTableRules(tx, rateTableId);
    const after = await loadRuleSnapshot(tx, rateTableId, created.id);
    await persistProductRuleAudit(tx, {
      actor,
      action: "shipping.product_rate_rule.created",
      rateTableId,
      ruleId: created.id,
      before: null,
      after,
    });
    return created;
  });
}

export async function updateRateTableProductRule(
  rateTableId: number,
  ruleId: number,
  input: ProductRateRuleDraftInput,
  actorUserId: string,
) {
  const actor = requireAuditActor(actorUserId);
  return db.transaction(async (tx) => {
    await lockDraftTable(tx, rateTableId);
    const before = await loadRuleSnapshot(tx, rateTableId, ruleId);
    const { productSetId, variantIds } = await resolveSelector(tx, input.name, input.selector);
    const [updated] = await tx.update(shippingRateRules).set({
      sourceProductSetId: productSetId,
      name: input.name,
      kind: input.kind,
      action: input.action,
      measurementScope: input.measurementScope,
      destinationScope: input.destinationScope,
      rateCents: input.rateCents,
      perStartedPoundCents: input.perStartedPoundCents,
      thresholdCents: input.thresholdCents,
      updatedAt: new Date(),
    }).where(eq(shippingRateRules.id, ruleId)).returning();
    await replaceRuleChildren(tx, ruleId, variantIds, input.bands);
    await assertValidTableRules(tx, rateTableId);
    const after = await loadRuleSnapshot(tx, rateTableId, ruleId);
    await persistProductRuleAudit(tx, {
      actor,
      action: "shipping.product_rate_rule.updated",
      rateTableId,
      ruleId,
      before,
      after,
    });
    return updated;
  });
}

export async function deleteRateTableProductRule(
  rateTableId: number,
  ruleId: number,
  actorUserId: string,
) {
  const actor = requireAuditActor(actorUserId);
  return db.transaction(async (tx) => {
    await lockDraftTable(tx, rateTableId);
    const before = await loadRuleSnapshot(tx, rateTableId, ruleId);
    const [deleted] = await tx.delete(shippingRateRules)
      .where(and(eq(shippingRateRules.id, ruleId), eq(shippingRateRules.rateTableId, rateTableId)))
      .returning({ id: shippingRateRules.id });
    if (!deleted) throw notFound("Shipping rule not found.");
    await persistProductRuleAudit(tx, {
      actor,
      action: "shipping.product_rate_rule.deleted",
      rateTableId,
      ruleId,
      before,
      after: null,
    });
    return deleted;
  });
}

export async function previewRateTableProductPolicy(
  rateTableId: number,
  input: ProductRatePolicyPreviewInput,
) {
  const [table] = await db.select({
    id: shippingRateTables.id,
    pricingBasis: shippingRateTables.pricingBasis,
    currency: shippingRateTables.currency,
    serviceLevelId: shippingRateTables.serviceLevelId,
  }).from(shippingRateTables).where(eq(shippingRateTables.id, rateTableId)).limit(1);
  if (!table) throw notFound("Rate table not found.");

  const variantIds = [...new Set(input.lines.map((line) => line.productVariantId))];
  const variants = await db.select({
    id: productVariants.id,
    sku: productVariants.sku,
    weightGrams: productVariants.weightGrams,
  }).from(productVariants).where(inArray(productVariants.id, variantIds));
  if (variants.length !== variantIds.length) {
    throw new ProductRatePolicyAdminError(
      400,
      "SHIPPING_PRODUCT_POLICY_PREVIEW_VARIANT_NOT_FOUND",
      "Every test line must reference an existing catalog variant.",
    );
  }
  const variantById = new Map(variants.map((variant) => [variant.id, variant]));
  const lines = input.lines.map((line) => {
    const variant = variantById.get(line.productVariantId)!;
    if (!Number.isSafeInteger(variant.weightGrams) || variant.weightGrams! <= 0) {
      throw new ProductRatePolicyAdminError(
        409,
        "SHIPPING_PRODUCT_POLICY_PREVIEW_WEIGHT_MISSING",
        `${variant.sku ?? `Variant ${variant.id}`} needs a catalog weight before it can be tested.`,
      );
    }
    return {
      sku: variant.sku,
      productVariantId: variant.id,
      quantity: line.quantity,
      unitWeightGrams: variant.weightGrams,
      unitPriceCents: line.unitPriceCents,
    };
  });
  const totalWeightGrams = lines.reduce(
    (sum, line) => sum + line.unitWeightGrams! * line.quantity,
    0,
  );
  const candidateRows = await db.select({
    rateTableId: shippingRateTableRows.rateTableId,
    serviceLevelId: shippingServiceLevels.id,
    serviceLevelCode: shippingServiceLevels.code,
    displayName: shippingServiceLevels.displayName,
    description: shippingServiceLevels.description,
    fulfillmentMode: shippingServiceLevels.fulfillmentMode,
    pricingBasis: shippingRateTables.pricingBasis,
    sortOrder: shippingServiceLevels.sortOrder,
    promiseMinBusinessDays: shippingServiceLevels.promiseMinBusinessDays,
    promiseMaxBusinessDays: shippingServiceLevels.promiseMaxBusinessDays,
    currency: shippingRateTables.currency,
    originWarehouseId: shippingRateTableRows.originWarehouseId,
    destinationCountry: shippingRateTableRows.destinationCountry,
    destinationRegion: shippingRateTableRows.destinationRegion,
    postalPrefix: shippingRateTableRows.postalPrefix,
    minMeasure: shippingRateTableRows.minMeasure,
    maxMeasure: shippingRateTableRows.maxMeasure,
    maxShipmentWeightGrams: shippingRateTableRows.maxShipmentWeightGrams,
    chargeModel: shippingRateTableRows.chargeModel,
    rateCents: shippingRateTableRows.rateCents,
    perStartedPoundCents: shippingRateTableRows.perStartedPoundCents,
  }).from(shippingRateTableRows)
    .innerJoin(shippingRateTables, eq(shippingRateTables.id, shippingRateTableRows.rateTableId))
    .innerJoin(shippingServiceLevels, eq(shippingServiceLevels.id, shippingRateTables.serviceLevelId))
    .where(eq(shippingRateTableRows.rateTableId, rateTableId));
  const typedRows = candidateRows.map((row) => ({
    ...row,
    fulfillmentMode: row.fulfillmentMode as ShippingFulfillmentMode,
    pricingBasis: row.pricingBasis as ShippingPricingBasis,
    chargeModel: row.chargeModel as ShippingRateChargeModel,
  }));
  const selectionInput = {
    destinationCountry: input.destination.country,
    destinationRegion: input.destination.region,
    destinationPostal: input.destination.postalCode,
    shipmentWeightGrams: totalWeightGrams,
    palletCount: null,
    originWarehouseId: input.originWarehouseId,
  };
  const defaultRate = selectServiceLevelRates(typedRows, selectionInput)[0];
  if (!defaultRate) {
    return { ok: false as const, code: "NO_DEFAULT_RATE", message: "No destination default covers this test cart." };
  }
  const rules = await loadRules(db, rateTableId);
  const result = evaluateProductRatePolicy({
    destination: input.destination,
    lines,
    rules,
    defaultRateForWeightGrams: (weightGrams) => {
      if (weightGrams === 0) return 0;
      return selectServiceLevelRates(typedRows, { ...selectionInput, shipmentWeightGrams: weightGrams })[0]?.rateCents ?? null;
    },
  });
  return result.ok
    ? {
        ok: true as const,
        currency: table.currency.toUpperCase(),
        defaultTotalCents: defaultRate.rateCents,
        totalCents: result.totalCents,
        trace: result.trace,
      }
    : result;
}

export async function cloneProductRules(
  tx: Transaction,
  sourceRateTableId: number,
  targetRateTableId: number,
): Promise<void> {
  const sourceRules = await loadRules(tx, sourceRateTableId);
  for (const source of sourceRules) {
    const [rule] = await tx.insert(shippingRateRules).values({
      rateTableId: targetRateTableId,
      sourceProductSetId: source.sourceProductSetId,
      name: source.name,
      kind: source.kind,
      action: source.action,
      measurementScope: source.measurementScope,
      destinationScope: mutableDestinationScope(source.destinationScope),
      rateCents: source.rateCents,
      perStartedPoundCents: source.perStartedPoundCents,
      thresholdCents: source.thresholdCents,
      isActive: source.isActive,
    }).returning({ id: shippingRateRules.id });
    await replaceRuleChildren(tx, rule.id, source.memberVariantIds, source.bands);
  }
}

export async function validateRateTableProductRules(
  rateTableId: number,
  executor: typeof db | Transaction = db,
): Promise<string[]> {
  return validateProductRateRules(await loadRules(executor, rateTableId));
}

async function lockDraftTable(tx: Transaction, rateTableId: number): Promise<void> {
  await tx.execute(sql`SELECT id FROM shipping.rate_tables WHERE id = ${rateTableId} FOR UPDATE`);
  const [table] = await tx.select({ status: shippingRateTables.status })
    .from(shippingRateTables)
    .where(eq(shippingRateTables.id, rateTableId))
    .limit(1);
  if (!table) throw notFound("Rate table not found.");
  if (table.status !== "draft") {
    throw new ProductRatePolicyAdminError(
      409,
      "SHIPPING_PRODUCT_POLICY_DRAFT_REQUIRED",
      "Product policies can only be changed on a draft rate-table revision.",
    );
  }
}

async function resolveSelector(
  tx: Transaction,
  name: string,
  selector: ProductSetSelectorInput,
): Promise<{ productSetId: number; variantIds: number[] }> {
  if (selector.kind === "saved_set") {
    const [set] = await tx.select({ id: shippingProductSets.id })
      .from(shippingProductSets)
      .where(and(eq(shippingProductSets.id, selector.productSetId), eq(shippingProductSets.status, "active")))
      .limit(1);
    if (!set) throw new ProductRatePolicyAdminError(404, "SHIPPING_PRODUCT_SET_NOT_FOUND", "Saved product set not found.");
    const members = await tx.select({ id: shippingProductSetMembers.productVariantId })
      .from(shippingProductSetMembers)
      .where(eq(shippingProductSetMembers.productSetId, set.id))
      .orderBy(asc(shippingProductSetMembers.productVariantId));
    if (members.length === 0) throw emptySelectorError();
    return { productSetId: set.id, variantIds: members.map((member) => member.id) };
  }

  const variantIds = await resolveVariantIds(tx, selector);
  if (variantIds.length === 0) throw emptySelectorError();
  const selectorRef = selector.kind === "manual" ? null : selector.ref;
  const selectorHash = createHash("sha256")
    .update(JSON.stringify({ kind: selector.kind, ref: selectorRef, variantIds }))
    .digest("hex")
    .slice(0, 16);
  const code = `policy-${selector.kind}-${selectorHash}`;
  const [existing] = await tx.select({ id: shippingProductSets.id })
    .from(shippingProductSets)
    .where(eq(shippingProductSets.code, code))
    .limit(1);
  if (existing) return { productSetId: existing.id, variantIds };

  const [created] = await tx.insert(shippingProductSets).values({
    code,
    name: name.trim(),
    selectorKind: selector.kind as ShippingProductSetSelectorKind,
    selectorRef,
    status: "active",
    metadata: { materializedVariantCount: variantIds.length },
  }).returning({ id: shippingProductSets.id });
  await tx.insert(shippingProductSetMembers).values(
    variantIds.map((productVariantId) => ({ productSetId: created.id, productVariantId })),
  );
  return { productSetId: created.id, variantIds };
}

async function resolveVariantIds(
  tx: Transaction,
  selector: Exclude<ProductSetSelectorInput, { kind: "saved_set" }>,
): Promise<number[]> {
  if (selector.kind === "manual") {
    const ids = [...new Set(selector.variantIds)].sort((left, right) => left - right);
    if (ids.length === 0) return [];
    const rows = await tx.select({ id: productVariants.id })
      .from(productVariants)
      .innerJoin(products, eq(products.id, productVariants.productId))
      .where(and(
        inArray(productVariants.id, ids),
        eq(productVariants.isActive, true),
        eq(products.isActive, true),
      ))
      .orderBy(asc(productVariants.id));
    if (rows.length !== ids.length) {
      throw new ProductRatePolicyAdminError(
        400,
        "SHIPPING_PRODUCT_POLICY_INVALID_VARIANTS",
        "Every selected variant must exist and be active.",
      );
    }
    return rows.map((row) => row.id);
  }

  const base = tx.select({ id: productVariants.id })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId));
  if (selector.kind === "shipping_group") {
    return base.innerJoin(shippingGroups, eq(shippingGroups.id, products.shippingGroupId))
      .where(and(
        eq(shippingGroups.code, selector.ref),
        eq(productVariants.isActive, true),
        eq(products.isActive, true),
      )).orderBy(asc(productVariants.id)).then((rows) => rows.map((row) => row.id));
  }
  if (selector.kind === "product_line") {
    return base.innerJoin(productLineProducts, eq(productLineProducts.productId, products.id))
      .innerJoin(productLines, eq(productLines.id, productLineProducts.productLineId))
      .where(and(
        eq(productLines.code, selector.ref),
        eq(productVariants.isActive, true),
        eq(products.isActive, true),
      )).orderBy(asc(productVariants.id)).then((rows) => rows.map((row) => row.id));
  }
  if (selector.kind === "category") {
    const categoryId = Number(selector.ref);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      throw new ProductRatePolicyAdminError(400, "SHIPPING_PRODUCT_POLICY_INVALID_CATEGORY", "Select a valid category.");
    }
    return base.where(and(
      eq(products.categoryId, categoryId),
      eq(productVariants.isActive, true),
      eq(products.isActive, true),
    )).orderBy(asc(productVariants.id)).then((rows) => rows.map((row) => row.id));
  }
  if (selector.ref !== "true") {
    throw new ProductRatePolicyAdminError(400, "SHIPPING_PRODUCT_POLICY_INVALID_SIOC", "SIOC selector must be enabled.");
  }
  return base.innerJoin(shippingVariantAttrs, eq(shippingVariantAttrs.productVariantId, productVariants.id))
    .where(and(
      eq(shippingVariantAttrs.shipsInOwnContainer, true),
      eq(productVariants.isActive, true),
      eq(products.isActive, true),
    )).orderBy(asc(productVariants.id)).then((rows) => rows.map((row) => row.id));
}

async function replaceRuleChildren(
  tx: Transaction,
  ruleId: number,
  variantIds: readonly number[],
  bands: readonly ProductRateRuleBand[],
): Promise<void> {
  await tx.delete(shippingRateRuleMembers).where(eq(shippingRateRuleMembers.rateRuleId, ruleId));
  await tx.delete(shippingRateRuleBands).where(eq(shippingRateRuleBands.rateRuleId, ruleId));
  if (variantIds.length > 0) {
    await tx.insert(shippingRateRuleMembers).values(
      variantIds.map((productVariantId) => ({ rateRuleId: ruleId, productVariantId })),
    );
  }
  if (bands.length > 0) {
    await tx.insert(shippingRateRuleBands).values(
      bands.map((band) => ({ rateRuleId: ruleId, ...band })),
    );
  }
}

async function assertValidTableRules(tx: Transaction, rateTableId: number): Promise<void> {
  const errors = validateProductRateRules(await loadRules(tx, rateTableId));
  if (errors.length > 0) {
    throw new ProductRatePolicyAdminError(
      409,
      "SHIPPING_PRODUCT_POLICY_INVALID",
      "Resolve the product policy conflicts before saving.",
      errors,
    );
  }
}

async function loadRuleSnapshot(
  executor: typeof db | Transaction,
  rateTableId: number,
  ruleId: number,
): Promise<LoadedProductRateRule> {
  const rule = (await loadRules(executor, rateTableId)).find((candidate) => candidate.id === ruleId);
  if (!rule) throw notFound("Shipping rule not found.");
  return rule;
}

async function persistProductRuleAudit(
  tx: Transaction,
  input: {
    actor: string;
    action: string;
    rateTableId: number;
    ruleId: number;
    before: LoadedProductRateRule | null;
    after: LoadedProductRateRule | null;
  },
): Promise<void> {
  await persistAuditEvent(tx, {
    actor: input.actor,
    action: input.action,
    target: `shipping.rate_rule:${input.ruleId}`,
    changes: {
      before: input.before === null ? null : productRuleAuditState(input.before),
      after: input.after === null ? null : productRuleAuditState(input.after),
    },
    context: { rateTableId: input.rateTableId },
  }, { emitStructuredLog: false });
}

function productRuleAuditState(rule: LoadedProductRateRule): Record<string, unknown> {
  return {
    id: rule.id,
    sourceProductSetId: rule.sourceProductSetId,
    name: rule.name,
    kind: rule.kind,
    action: rule.action,
    measurementScope: rule.measurementScope,
    destinationScope: rule.destinationScope,
    rateCents: rule.rateCents,
    perStartedPoundCents: rule.perStartedPoundCents,
    thresholdCents: rule.thresholdCents,
    memberVariantIds: [...rule.memberVariantIds],
    bands: rule.bands.map((band) => ({ ...band })),
    isActive: rule.isActive,
  };
}

function requireAuditActor(actorUserId: string): string {
  const actor = actorUserId.trim();
  if (actor === "" || actor.length > 200) {
    throw new ProductRatePolicyAdminError(
      401,
      "SHIPPING_PRODUCT_POLICY_ACTOR_REQUIRED",
      "An authenticated operator is required to change product shipping policies.",
    );
  }
  return actor;
}

async function loadRules(
  executor: typeof db | Transaction,
  rateTableId: number,
): Promise<LoadedProductRateRule[]> {
  const [rules, members, bands] = await Promise.all([
    executor.select().from(shippingRateRules)
      .where(eq(shippingRateRules.rateTableId, rateTableId))
      .orderBy(asc(shippingRateRules.id)),
    executor.select({
      ruleId: shippingRateRuleMembers.rateRuleId,
      productVariantId: shippingRateRuleMembers.productVariantId,
    }).from(shippingRateRuleMembers)
      .innerJoin(shippingRateRules, eq(shippingRateRules.id, shippingRateRuleMembers.rateRuleId))
      .where(eq(shippingRateRules.rateTableId, rateTableId))
      .orderBy(asc(shippingRateRuleMembers.rateRuleId), asc(shippingRateRuleMembers.productVariantId)),
    executor.select({
      ruleId: shippingRateRuleBands.rateRuleId,
      minMeasure: shippingRateRuleBands.minMeasure,
      maxMeasure: shippingRateRuleBands.maxMeasure,
      rateCents: shippingRateRuleBands.rateCents,
    }).from(shippingRateRuleBands)
      .innerJoin(shippingRateRules, eq(shippingRateRules.id, shippingRateRuleBands.rateRuleId))
      .where(eq(shippingRateRules.rateTableId, rateTableId))
      .orderBy(asc(shippingRateRuleBands.rateRuleId), asc(shippingRateRuleBands.minMeasure)),
  ]);
  const membersByRule = groupValues(members, (row) => row.ruleId, (row) => row.productVariantId);
  const bandsByRule = groupValues(bands, (row) => row.ruleId, (row) => ({
    minMeasure: row.minMeasure,
    maxMeasure: row.maxMeasure,
    rateCents: row.rateCents,
  }));
  return rules.map((rule) => ({
    id: rule.id,
    sourceProductSetId: rule.sourceProductSetId,
    name: rule.name,
    kind: rule.kind as ShippingRateRuleKind,
    action: rule.action as ShippingRateRuleAction,
    measurementScope: rule.measurementScope as ShippingRateRuleMeasurementScope,
    destinationScope: rule.destinationScope as ShippingRateRuleDestinationScope,
    rateCents: rule.rateCents,
    perStartedPoundCents: rule.perStartedPoundCents,
    thresholdCents: rule.thresholdCents,
    memberVariantIds: membersByRule.get(rule.id) ?? [],
    bands: bandsByRule.get(rule.id) ?? [],
    isActive: rule.isActive,
  }));
}

function groupValues<Row, Key, Value>(
  rows: readonly Row[],
  key: (row: Row) => Key,
  value: (row: Row) => Value,
): Map<Key, Value[]> {
  const grouped = new Map<Key, Value[]>();
  for (const row of rows) {
    const itemKey = key(row);
    grouped.set(itemKey, [...(grouped.get(itemKey) ?? []), value(row)]);
  }
  return grouped;
}

function mutableDestinationScope(
  scope: ProductRateRule["destinationScope"],
): ShippingRateRuleDestinationScope {
  return {
    country: scope.country,
    regions: [...scope.regions],
    postalPrefixes: scope.postalPrefixes.map((entry) => ({
      region: entry.region,
      prefixes: [...entry.prefixes],
    })),
  };
}

function emptySelectorError() {
  return new ProductRatePolicyAdminError(
    409,
    "SHIPPING_PRODUCT_POLICY_EMPTY_SET",
    "The selected product set contains no active variants.",
  );
}

function notFound(message: string) {
  return new ProductRatePolicyAdminError(404, "SHIPPING_PRODUCT_POLICY_NOT_FOUND", message);
}
