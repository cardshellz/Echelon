import { createHash } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool, PoolClient, QueryResult } from "pg";

import * as schema from "@shared/schema";
import { getVariantUomDefinition } from "@shared/catalog/variant-uom";
import { insertProductVariantSchema } from "@shared/schema/catalog.schema";
import { canonicalJson } from "@shared/utils/canonical-json";

import { persistAuditEvent } from "../../infrastructure/auditLogger";
import { assertVariantSalesIdentityCompatible } from "./variant-sales-eligibility-policy";
import { validateVariantUomWrite } from "./variant-uom";

/**
 * Piece-variant backfill.
 *
 * Receiving counts purchase-order pieces in a one-piece variant whenever the
 * shipped quantity is not a whole number of the preferred pack
 * (`planReceiptUnits` in server/modules/procurement/receiving-unit-contract.ts
 * raises RECEIVING_PIECE_VARIANT_REQUIRED otherwise). Products that are sold
 * only in packs or cases therefore need one active `units_per_variant = 1`
 * variant even though it is never sold. This service finds such products and
 * proposes exactly one internal-only piece variant per product.
 *
 * Contract, mirrored from legacy-po-receive-config-remediation.service.ts:
 * preview is read-only and fingerprints every candidate (safe and blocked);
 * apply re-derives the same preview inside one transaction under row locks and
 * refuses to write unless the fingerprint still matches what the operator
 * reviewed. Blocked products are reported, never guessed at. Audit rows go
 * through the audit table owner's API (persistAuditEvent) on the same pinned
 * connection, so they commit or roll back with the variants they describe.
 */

export const PIECE_VARIANT_BACKFILL_CONTRACT_VERSION = 1;
export const PIECE_VARIANT_AUDIT_ACTION = "product_variant.piece_unit_backfilled";

// Single-key advisory lock owned by this backfill so two operators cannot run
// apply concurrently. Distinct from every other remediation lock in the repo.
const PIECE_VARIANT_BACKFILL_ADVISORY_LOCK = 1_952_318_402;

// catalog.product_variants.sku is varchar(100).
const MAX_VARIANT_SKU_LENGTH = 100;

/**
 * Same conventions the product page applies when an operator creates a piece
 * by hand (client/src/pages/ProductDetail.tsx computeAutoSku / computeAutoName):
 * `${productSku}-PC1` and the bare type label. A piece is a receiving and
 * counting identity, so it keeps the family SKU distinct from a package SKU.
 */
export const PIECE_SKU_SUFFIX = `-${getVariantUomDefinition("piece").skuPrefix}1`;
export const PIECE_VARIANT_NAME = getVariantUomDefinition("piece").label;

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<QueryResult<any>>;
};

export type PieceVariantBackfillBlocker =
  | "product_sku_missing"
  | "proposed_sku_too_long"
  | "proposed_sku_already_used"
  | "inactive_single_unit_variant_exists"
  | "base_unit_flag_on_multi_unit_variant";

export type PieceVariantBackfillWarning =
  | "recipe_managed_product"
  | "product_status_not_active";

export type ExistingVariantSummary = {
  id: number;
  sku: string | null;
  name: string;
  uomType: string;
  unitsPerVariant: number;
  hierarchyLevel: number;
  parentVariantId: number | null;
  isBaseUnit: boolean;
  isActive: boolean;
  requiresShipping: boolean;
  trackInventory: boolean | null;
  salesEligibility: string;
};

export type ProposedPieceVariant = {
  sku: string;
  name: string;
  uomType: "piece";
  unitsPerVariant: 1;
  hierarchyLevel: 1;
  parentVariantId: null;
  isBaseUnit: true;
  salesEligibility: "internal_only";
  requiresShipping: true;
  trackInventory: true;
  isActive: true;
  dropshipEligible: false;
};

export type PieceVariantSkuConflict = {
  variantId: number;
  productId: number;
  isActive: boolean;
};

export type PieceVariantBackfillTarget = {
  productId: number;
  productSku: string | null;
  productName: string;
  productStatus: string | null;
  inventoryStrategy: string;
  existingVariants: ExistingVariantSummary[];
  skuConflict: PieceVariantSkuConflict | null;
  action: "create_piece_variant" | "blocked";
  proposedVariant: ProposedPieceVariant | null;
  warnings: PieceVariantBackfillWarning[];
  blockers: PieceVariantBackfillBlocker[];
};

export type PieceVariantBackfillPreview = {
  mode: "preview";
  contractVersion: number;
  generatedAt: string;
  previewHash: string;
  pieceSkuSuffix: string;
  summary: {
    candidateProducts: number;
    productsToCreate: number;
    blockedProducts: number;
    blockerCounts: Record<PieceVariantBackfillBlocker, number>;
    warningCounts: Record<PieceVariantBackfillWarning, number>;
  };
  targets: PieceVariantBackfillTarget[];
};

export type CreatedPieceVariant = {
  productId: number;
  productSku: string;
  variantId: number;
  sku: string;
};

export type PieceVariantBackfillApplyResult = {
  mode: "apply";
  contractVersion: number;
  previewHash: string;
  actorId: string;
  createdVariants: CreatedPieceVariant[];
  blockedProducts: number;
  auditedVariants: number;
};

export type PieceVariantBackfillClock = () => Date;

const BLOCKERS: readonly PieceVariantBackfillBlocker[] = [
  "product_sku_missing",
  "proposed_sku_too_long",
  "proposed_sku_already_used",
  "inactive_single_unit_variant_exists",
  "base_unit_flag_on_multi_unit_variant",
];

const WARNINGS: readonly PieceVariantBackfillWarning[] = [
  "recipe_managed_product",
  "product_status_not_active",
];

/**
 * A product needs a piece when it is live, has at least one physical tracked
 * variant (so receiving can apply to it at all), and has no active one-piece
 * variant. Procurement treats `is_active = false` or `status = 'archived'` as
 * not purchasable (purchase-order-line-commands.ts), so those are excluded.
 * `$1` is the piece SKU suffix; the lateral conflict lookup reports any
 * variant, active or not, already carrying the SKU this backfill would mint.
 */
const CANDIDATE_PREDICATE = `
  p.is_active = TRUE
  AND COALESCE(p.status, 'active') <> 'archived'
  AND EXISTS (
    SELECT 1
    FROM catalog.product_variants physical
    WHERE physical.product_id = p.id
      AND physical.is_active = TRUE
      AND physical.requires_shipping = TRUE
      AND COALESCE(physical.track_inventory, TRUE) = TRUE
  )
  AND NOT EXISTS (
    SELECT 1
    FROM catalog.product_variants single_unit
    WHERE single_unit.product_id = p.id
      AND single_unit.is_active = TRUE
      AND single_unit.units_per_variant = 1
  )
`;

const CANDIDATE_QUERY = `
  SELECT
    p.id AS product_id,
    p.sku AS product_sku,
    p.name AS product_name,
    p.status AS product_status,
    p.inventory_strategy,
    COALESCE(variants.rows, '[]'::jsonb) AS existing_variants,
    conflict.variant_id AS sku_conflict_variant_id,
    conflict.product_id AS sku_conflict_product_id,
    conflict.is_active AS sku_conflict_is_active
  FROM catalog.products p
  LEFT JOIN LATERAL (
    SELECT jsonb_agg(
      jsonb_build_object(
        'id', pv.id,
        'sku', pv.sku,
        'name', pv.name,
        'uomType', pv.uom_type,
        'unitsPerVariant', pv.units_per_variant,
        'hierarchyLevel', pv.hierarchy_level,
        'parentVariantId', pv.parent_variant_id,
        'isBaseUnit', pv.is_base_unit,
        'isActive', pv.is_active,
        'requiresShipping', pv.requires_shipping,
        'trackInventory', pv.track_inventory,
        'salesEligibility', pv.sales_eligibility
      )
      ORDER BY pv.id
    ) AS rows
    FROM catalog.product_variants pv
    WHERE pv.product_id = p.id
  ) variants ON TRUE
  LEFT JOIN LATERAL (
    SELECT c.id AS variant_id, c.product_id, c.is_active
    FROM catalog.product_variants c
    WHERE p.sku IS NOT NULL
      AND BTRIM(p.sku) <> ''
      AND UPPER(c.sku) = UPPER(BTRIM(p.sku) || $1)
    ORDER BY c.is_active DESC, c.id
    LIMIT 1
  ) conflict ON TRUE
  WHERE ${CANDIDATE_PREDICATE}
  ORDER BY p.id
`;

const LOCK_CANDIDATE_PRODUCTS_QUERY = `
  SELECT p.id AS product_id
  FROM catalog.products p
  WHERE ${CANDIDATE_PREDICATE}
  ORDER BY p.id
  FOR UPDATE OF p
`;

const LOCK_CANDIDATE_VARIANTS_QUERY = `
  SELECT id
  FROM catalog.product_variants
  WHERE product_id = ANY($1::int[])
  ORDER BY id
  FOR UPDATE
`;

/**
 * The NOT EXISTS guard repeats the candidate predicate at write time so a
 * one-piece variant created between preview and apply (by any path that does
 * not take the product row lock) yields zero rows instead of a duplicate.
 */
const INSERT_PIECE_VARIANT_QUERY = `
  INSERT INTO catalog.product_variants AS pv (
    product_id, sku, name, uom_type, units_per_variant, hierarchy_level,
    parent_variant_id, is_base_unit, sales_eligibility, requires_shipping,
    track_inventory, is_active, dropship_eligible
  )
  SELECT $1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, $10, $11, $12
  WHERE NOT EXISTS (
    SELECT 1
    FROM catalog.product_variants single_unit
    WHERE single_unit.product_id = $1
      AND single_unit.is_active = TRUE
      AND single_unit.units_per_variant = 1
  )
  RETURNING to_jsonb(pv) AS row
`;

function asSafeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`${field} is not a safe integer`);
  }
  return parsed;
}

function asOptionalSafeInteger(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : asSafeInteger(value, field);
}

function asNullableTrimmedString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed === "" ? null : trimmed;
}

function parseExistingVariants(value: unknown): ExistingVariantSummary[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    const row = entry as Record<string, unknown>;
    const field = (name: string) => `existing_variants[${index}].${name}`;
    return {
      id: asSafeInteger(row.id, field("id")),
      sku: row.sku == null ? null : String(row.sku),
      name: String(row.name),
      uomType: String(row.uomType),
      unitsPerVariant: asSafeInteger(row.unitsPerVariant, field("unitsPerVariant")),
      hierarchyLevel: asSafeInteger(row.hierarchyLevel, field("hierarchyLevel")),
      parentVariantId: asOptionalSafeInteger(row.parentVariantId, field("parentVariantId")),
      isBaseUnit: row.isBaseUnit === true,
      isActive: row.isActive === true,
      requiresShipping: row.requiresShipping === true,
      trackInventory: row.trackInventory == null ? null : row.trackInventory === true,
      salesEligibility: String(row.salesEligibility),
    };
  });
}

function parseSkuConflict(row: Record<string, unknown>): PieceVariantSkuConflict | null {
  if (row.sku_conflict_variant_id == null) return null;
  return {
    variantId: asSafeInteger(row.sku_conflict_variant_id, "sku_conflict_variant_id"),
    productId: asSafeInteger(row.sku_conflict_product_id, "sku_conflict_product_id"),
    isActive: row.sku_conflict_is_active === true,
  };
}

/**
 * Builds the piece the backfill would insert and runs it through the same
 * catalog validators the create-variant route applies
 * (catalog.routes.ts POST /api/products/:id/variants), so a proposal that the
 * UI would reject can never reach the INSERT.
 */
export function buildProposedPieceVariant(productSku: string): ProposedPieceVariant {
  const proposed: ProposedPieceVariant = {
    sku: `${productSku}${PIECE_SKU_SUFFIX}`,
    name: PIECE_VARIANT_NAME,
    uomType: "piece",
    unitsPerVariant: 1,
    hierarchyLevel: 1,
    parentVariantId: null,
    isBaseUnit: true,
    salesEligibility: "internal_only",
    requiresShipping: true,
    trackInventory: true,
    isActive: true,
    dropshipEligible: false,
  };
  // productId is required by the insert schema; 1 is a placeholder for shape
  // validation only. The real product id is bound at INSERT time.
  insertProductVariantSchema.parse({ productId: 1, ...proposed });
  validateVariantUomWrite(proposed);
  assertVariantSalesIdentityCompatible({
    salesEligibility: proposed.salesEligibility,
    shopifyVariantId: null,
    shopifyInventoryItemId: null,
    dropshipEligible: proposed.dropshipEligible,
  });
  return proposed;
}

export function classifyPieceVariantCandidate(
  row: Record<string, unknown>,
): PieceVariantBackfillTarget {
  const productId = asSafeInteger(row.product_id, "product_id");
  const productSku = asNullableTrimmedString(row.product_sku);
  const productStatus = row.product_status == null ? null : String(row.product_status);
  const inventoryStrategy = String(row.inventory_strategy);
  const existingVariants = parseExistingVariants(row.existing_variants);
  const skuConflict = parseSkuConflict(row);
  const warnings: PieceVariantBackfillWarning[] = [];
  const blockers: PieceVariantBackfillBlocker[] = [];

  // The query already excludes products with an active one-piece variant; a
  // disagreement here means the SQL and this classifier drifted apart.
  if (existingVariants.some((variant) => variant.isActive && variant.unitsPerVariant === 1)) {
    throw new Error(
      `Product ${productId} already has an active one-piece variant; candidate query drift`,
    );
  }

  if (!productSku) {
    blockers.push("product_sku_missing");
  } else if (productSku.length + PIECE_SKU_SUFFIX.length > MAX_VARIANT_SKU_LENGTH) {
    blockers.push("proposed_sku_too_long");
  }
  if (skuConflict) blockers.push("proposed_sku_already_used");
  // Reactivating a retired piece is a different decision from minting one:
  // it may carry inventory, receipt, or cost history an operator must review.
  if (existingVariants.some((variant) => !variant.isActive && variant.unitsPerVariant === 1)) {
    blockers.push("inactive_single_unit_variant_exists");
  }
  // Two base-unit flags on one product would make receiving credit ambiguous
  // (receive-validation.service.ts already warns on the mis-flagged pack).
  if (existingVariants.some((variant) =>
    variant.isActive && variant.isBaseUnit && variant.unitsPerVariant !== 1
  )) {
    blockers.push("base_unit_flag_on_multi_unit_variant");
  }

  if (inventoryStrategy === "recipe_managed") warnings.push("recipe_managed_product");
  if (productStatus !== null && productStatus !== "active") {
    warnings.push("product_status_not_active");
  }

  const action: PieceVariantBackfillTarget["action"] = blockers.length > 0
    ? "blocked"
    : "create_piece_variant";

  return {
    productId,
    productSku,
    productName: String(row.product_name),
    productStatus,
    inventoryStrategy,
    existingVariants,
    skuConflict,
    action,
    proposedVariant: action === "create_piece_variant" && productSku
      ? buildProposedPieceVariant(productSku)
      : null,
    warnings,
    blockers,
  };
}

function countBy<T extends string>(
  keys: readonly T[],
  targets: PieceVariantBackfillTarget[],
  pick: (target: PieceVariantBackfillTarget) => readonly T[],
): Record<T, number> {
  const counts = Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
  for (const target of targets) {
    for (const key of pick(target)) counts[key] += 1;
  }
  return counts;
}

/**
 * Fingerprints the reviewed proposal. Excludes generatedAt so the same catalog
 * state yields the same hash however many times preview runs.
 */
function previewFingerprint(targets: PieceVariantBackfillTarget[]): string {
  return createHash("sha256")
    .update(`piece-variant-backfill:v${PIECE_VARIANT_BACKFILL_CONTRACT_VERSION}:`)
    .update(canonicalJson({ pieceSkuSuffix: PIECE_SKU_SUFFIX, targets }))
    .digest("hex");
}

async function previewWithQueryable(
  queryable: Queryable,
  clock: PieceVariantBackfillClock,
): Promise<PieceVariantBackfillPreview> {
  const result = await queryable.query(CANDIDATE_QUERY, [PIECE_SKU_SUFFIX]);
  const targets = result.rows.map((row) => classifyPieceVariantCandidate(row));
  const blocked = targets.filter((target) => target.action === "blocked");
  return {
    mode: "preview",
    contractVersion: PIECE_VARIANT_BACKFILL_CONTRACT_VERSION,
    generatedAt: clock().toISOString(),
    previewHash: previewFingerprint(targets),
    pieceSkuSuffix: PIECE_SKU_SUFFIX,
    summary: {
      candidateProducts: targets.length,
      productsToCreate: targets.length - blocked.length,
      blockedProducts: blocked.length,
      blockerCounts: countBy(BLOCKERS, targets, (target) => target.blockers),
      warningCounts: countBy(WARNINGS, targets, (target) => target.warnings),
    },
    targets,
  };
}

export async function previewPieceVariantBackfill(
  queryable: Queryable,
  options: { clock?: PieceVariantBackfillClock } = {},
): Promise<PieceVariantBackfillPreview> {
  return previewWithQueryable(queryable, options.clock ?? (() => new Date()));
}

async function assertActor(client: PoolClient, actorId: string): Promise<void> {
  const actor = await client.query(
    "SELECT id FROM public.users WHERE id = $1 LIMIT 1",
    [actorId],
  );
  if (actor.rowCount !== 1) {
    throw new Error("--actor must identify an existing application user");
  }
}

/**
 * Creates every reviewed piece variant in one SERIALIZABLE transaction.
 *
 * Blocked products are skipped and counted, not treated as a reason to abort:
 * each blocker is a per-product data fact (missing SKU, SKU collision, retired
 * piece) that the operator saw in the preview whose hash they supplied, and it
 * says nothing about the safety of the other products' proposals.
 */
export async function applyPieceVariantBackfill(input: {
  pool: Pool;
  actorId: string;
  expectedPreviewHash: string;
  clock?: PieceVariantBackfillClock;
}): Promise<PieceVariantBackfillApplyResult> {
  const actorId = input.actorId.trim();
  if (!actorId) throw new Error("actorId is required");
  if (!/^[0-9a-f]{64}$/.test(input.expectedPreviewHash)) {
    throw new Error("expectedPreviewHash must be a SHA-256 hash from preview");
  }
  const clock = input.clock ?? (() => new Date());

  const client = await input.pool.connect();
  try {
    // SERIALIZABLE turns a concurrent variant insert that slips past the row
    // locks into a serialization failure rather than a silent second piece.
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
    // Drizzle over the pinned client: every statement it issues runs on this
    // connection, inside this transaction, so the audit writer's inserts share
    // the variants' commit or rollback. Bound to the app schema so its type is
    // exactly the one the audit owner's API is declared against.
    const auditWriter = drizzle(client, { schema });
    await client.query("SELECT pg_advisory_xact_lock($1)", [
      PIECE_VARIANT_BACKFILL_ADVISORY_LOCK,
    ]);
    await assertActor(client, actorId);

    const lockedProducts = await client.query(LOCK_CANDIDATE_PRODUCTS_QUERY);
    const lockedProductIds = lockedProducts.rows.map((row) =>
      asSafeInteger(row.product_id, "locked_product_id")
    );
    if (lockedProductIds.length > 0) {
      await client.query(LOCK_CANDIDATE_VARIANTS_QUERY, [lockedProductIds]);
    }

    const preview = await previewWithQueryable(client, clock);
    if (preview.previewHash !== input.expectedPreviewHash) {
      throw new Error("Catalog changed after preview; run preview again");
    }

    const createdVariants: CreatedPieceVariant[] = [];
    let auditedVariants = 0;

    for (const target of preview.targets) {
      if (target.action !== "create_piece_variant") continue;
      if (!target.proposedVariant || !target.productSku) {
        throw new Error(`Product ${target.productId} has no validated piece proposal`);
      }
      const proposed = target.proposedVariant;

      const inserted = await client.query(INSERT_PIECE_VARIANT_QUERY, [
        target.productId,
        proposed.sku,
        proposed.name,
        proposed.uomType,
        proposed.unitsPerVariant,
        proposed.hierarchyLevel,
        proposed.isBaseUnit,
        proposed.salesEligibility,
        proposed.requiresShipping,
        proposed.trackInventory,
        proposed.isActive,
        proposed.dropshipEligible,
      ]);
      if (inserted.rowCount !== 1) {
        throw new Error(
          `Product ${target.productId} changed during backfill; roll back and preview again`,
        );
      }
      const afterRow = inserted.rows[0].row as Record<string, unknown>;
      const variantId = asSafeInteger(afterRow.id, "created_variant_id");

      await persistAuditEvent(auditWriter, {
        actor: `user:${actorId}`,
        action: PIECE_VARIANT_AUDIT_ACTION,
        target: `product_variant:${variantId}`,
        changes: { before: null, after: afterRow },
        context: {
          contractVersion: PIECE_VARIANT_BACKFILL_CONTRACT_VERSION,
          source: "piece_variant_backfill",
          reason: "receiving_piece_variant_required",
          previewHash: preview.previewHash,
          productId: target.productId,
          productSku: target.productSku,
          inventoryStrategy: target.inventoryStrategy,
          existingVariantIds: target.existingVariants.map((variant) => variant.id),
          warnings: target.warnings,
        },
      }, {
        timestamp: clock(),
        // The CLI's stdout is its machine-readable result document; the
        // audit_events row is the durable record, so no console line here.
        emitStructuredLog: false,
      });
      auditedVariants++;
      createdVariants.push({
        productId: target.productId,
        productSku: target.productSku,
        variantId,
        sku: proposed.sku,
      });
    }

    await client.query("COMMIT");
    return {
      mode: "apply",
      contractVersion: PIECE_VARIANT_BACKFILL_CONTRACT_VERSION,
      previewHash: preview.previewHash,
      actorId,
      createdVariants,
      blockedProducts: preview.summary.blockedProducts,
      auditedVariants,
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original failure.
    }
    throw error;
  } finally {
    client.release();
  }
}
