import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import { parseCatalogVariantUomType } from "../domain/listing-tiers";
import type {
  DropshipSelectionAtpRepository,
  DropshipVendorCatalogCandidate,
  DropshipVendorProfile,
  DropshipVendorSelectionCountRecord,
  DropshipVendorSelectionRuleRecord,
  DropshipVendorVariantOverrideRecord,
} from "../application/dropship-selection-atp-service";
import type {
  DropshipVendorCatalogCandidateFilter,
  ListDropshipVendorSelectionRulesInput,
} from "../application/dropship-selection-dtos";
import { countSelectedVariants } from "../application/dropship-selected-catalog";
import type { DropshipCatalogExposureRule } from "../domain/catalog-exposure";
import { CATALOG_READ_WORDS } from "../domain/catalog-read-words";
import { DROPSHIP_CATALOG_READ_ERROR_CODES } from "../../../../shared/dropship/vendor-catalog-reads";
import { listLiveVariantIds, readHeadSelectionRevisionId } from "./dropship-listing-push-run.repository";
import { selectedCatalogReaderForTransaction } from "./dropship-selected-catalog.reader";

/**
 * PR B's freeze trigger on the rules table raises exactly this message with
 * SQLSTATE P0001 (the picks migration, PLAN-B v4.1 §6 step 8). PR A's rules
 * save answers it with 410 "this page was updated, reload" (§4.9 item 2, D39),
 * so an A dyno still serving during B's release refuses instead of a 500. B
 * deleted the rules save (V10): B's own PUT answers 410 before any database
 * call; this constant stays as the freeze's contract, pinned by the migration's
 * text test.
 */
export const SELECTION_RULES_RETIRED_DB_MESSAGE = "DROPSHIP_SELECTION_RULES_RETIRED";

interface VendorRow {
  id: number;
  member_id: string;
  status: string;
  entitlement_status: string;
}

interface CatalogRuleRow {
  id: number;
  scope_type: string;
  action: string;
  product_line_id: number | null;
  product_id: number | null;
  product_variant_id: number | null;
  category: string | null;
  starts_at: Date | null;
  ends_at: Date | null;
}

interface SelectionRuleRow {
  id: number;
  revision_id: number | null;
  vendor_id: number;
  scope_type: string;
  action: string;
  product_line_id: number | null;
  product_id: number | null;
  product_variant_id: number | null;
  category: string | null;
  auto_connect_new_skus: boolean;
  auto_list_new_skus: boolean;
  priority: number;
  is_active: boolean;
  metadata: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

interface VendorCatalogCandidateRow {
  product_id: number;
  product_sku: string | null;
  product_name: string;
  product_category: string | null;
  product_category_id: number | null;
  product_category_name: string | null;
  product_is_active: boolean;
  product_variant_id: number;
  variant_sku: string | null;
  variant_name: string;
  units_per_variant: number;
  uom_type: string;
  variant_is_active: boolean;
  product_line_ids: number[] | null;
  product_line_names: string[] | null;
  picked: boolean;
}

interface VariantOverrideRow {
  id: number;
  vendor_id: number;
  product_variant_id: number;
  enabled_override: boolean | null;
  marketplace_quantity_cap: number | null;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
}

export class PgDropshipSelectionAtpRepository implements DropshipSelectionAtpRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async findVendorByMemberId(memberId: string): Promise<DropshipVendorProfile | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<VendorRow>(
        `SELECT id, member_id, status, entitlement_status
         FROM dropship.dropship_vendors
         WHERE member_id::text = $1
         LIMIT 1`,
        [memberId],
      );
      const row = result.rows[0];
      if (!row) {
        return null;
      }
      return {
        vendorId: row.id,
        memberId: row.member_id,
        status: row.status,
        entitlementStatus: row.entitlement_status,
      };
    } finally {
      client.release();
    }
  }

  async listCatalogExposureRules(): Promise<DropshipCatalogExposureRule[]> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<CatalogRuleRow>(
        `SELECT id, scope_type, action, product_line_id, product_id,
                product_variant_id, category, starts_at, ends_at
         FROM dropship.dropship_catalog_rules
         WHERE is_active = true
         ORDER BY priority ASC, id ASC`,
      );
      return result.rows.map(mapCatalogExposureRuleRow);
    } finally {
      client.release();
    }
  }

  /** The frozen rules, for the rules GET only (one release; PLAN-B v4.1 §8.4). Nothing writes them any more. */
  async listSelectionRules(
    input: ListDropshipVendorSelectionRulesInput,
  ): Promise<DropshipVendorSelectionRuleRecord[]> {
    const client = await this.dbPool.connect();
    try {
      return await listSelectionRulesWithClient(client, input);
    } finally {
      client.release();
    }
  }

  async readSelectionCounts(input: {
    vendorId: number;
    storeConnectionId: number | null;
    now: Date;
  }): Promise<DropshipVendorSelectionCountRecord> {
    const client = await this.dbPool.connect();
    try {
      // One snapshot for the revision and the counts, so the page's expected
      // revision always belongs to the count it shows. Read only: nothing here writes.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const selectionRevisionId = await readHeadSelectionRevisionId(client, input.vendorId);
      let liveIds: ReadonlySet<number> = new Set();
      if (input.storeConnectionId !== null) {
        const store = await client.query<{ id: number }>(
          `SELECT id FROM dropship.dropship_store_connections WHERE id = $1 AND vendor_id = $2`,
          [input.storeConnectionId, input.vendorId],
        );
        if (!store.rows[0]) {
          throw new DropshipError(DROPSHIP_CATALOG_READ_ERROR_CODES.storeRequired, CATALOG_READ_WORDS.storeRequired, {
            storeConnectionId: input.storeConnectionId,
            retryable: false,
          });
        }
        liveIds = await listLiveVariantIds(client, {
          vendorId: input.vendorId,
          storeConnectionId: input.storeConnectionId,
        });
      }
      const counts = await countSelectedVariants(
        selectedCatalogReaderForTransaction(client, input.vendorId),
        input.now,
        liveIds,
      );
      await client.query("COMMIT");
      return {
        selectionRevisionId,
        selectedTotal: counts.selected,
        storeLive: input.storeConnectionId === null ? null : counts.selectedAmong,
      };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async listVendorCatalogCandidates(
    input: DropshipVendorCatalogCandidateFilter,
  ): Promise<DropshipVendorCatalogCandidate[]> {
    const client = await this.dbPool.connect();
    try {
      // $1 is the vendor whose picks decide `picked` (PLAN-B v4.1 §9 row 1); the filters follow it.
      const params: unknown[] = [input.vendorId];
      const where = [
        "p.is_active = true",
        "pv.is_active = true",
        "pv.requires_shipping = true",
        "COALESCE(pv.track_inventory, true) = true",
        "pv.sales_eligibility = 'sellable'",
      ];

      if (input.search) {
        params.push(`%${input.search}%`);
        where.push(`(
          p.sku ILIKE $${params.length}
          OR pv.sku ILIKE $${params.length}
          OR p.name ILIKE $${params.length}
          OR pv.name ILIKE $${params.length}
        )`);
      }

      if (input.category) {
        params.push(input.category);
        where.push(`LOWER(p.category) = LOWER($${params.length})`);
      }

      if (input.categoryId) {
        params.push(input.categoryId);
        where.push(`p.category_id = $${params.length}`);
      }

      const productLineIds = input.productLineIds?.length
        ? input.productLineIds
        : input.productLineId
          ? [input.productLineId]
          : [];
      if (productLineIds.length > 0) {
        params.push(productLineIds);
        where.push(`EXISTS (
          SELECT 1
          FROM catalog.product_line_products plp_filter
          WHERE plp_filter.product_id = p.id
            AND plp_filter.product_line_id = ANY($${params.length}::int[])
        )`);
      }

      if (input.productId) {
        params.push(input.productId);
        where.push(`p.id = $${params.length}`);
      }

      const result = await client.query<VendorCatalogCandidateRow>(
        `SELECT
           p.id AS product_id,
           p.sku AS product_sku,
           p.name AS product_name,
           p.category AS product_category,
           p.category_id AS product_category_id,
           pc.name AS product_category_name,
           p.is_active AS product_is_active,
           pv.id AS product_variant_id,
           pv.sku AS variant_sku,
           pv.name AS variant_name,
           pv.units_per_variant,
           pv.uom_type,
           pv.is_active AS variant_is_active,
           COALESCE(line_data.product_line_ids, ARRAY[]::int[]) AS product_line_ids,
           COALESCE(line_data.product_line_names, ARRAY[]::text[]) AS product_line_names,
           -- One primary-key probe per size: whether this vendor picked it (one-time picks; no rules read).
           EXISTS (
             SELECT 1
             FROM dropship.dropship_vendor_selected_variants s
             WHERE s.vendor_id = $1
               AND s.product_variant_id = pv.id
           ) AS picked
         FROM catalog.product_variants pv
         INNER JOIN catalog.products p ON p.id = pv.product_id
         LEFT JOIN catalog.product_categories pc ON pc.id = p.category_id
         LEFT JOIN LATERAL (
           SELECT
             ARRAY_AGG(line_rows.product_line_id ORDER BY line_rows.product_line_name, line_rows.product_line_id) AS product_line_ids,
             ARRAY_AGG(line_rows.product_line_name ORDER BY line_rows.product_line_name, line_rows.product_line_id) AS product_line_names
           FROM (
             SELECT DISTINCT plp.product_line_id, pl.name AS product_line_name
             FROM catalog.product_line_products plp
             INNER JOIN catalog.product_lines pl ON pl.id = plp.product_line_id
             WHERE plp.product_id = p.id
           ) line_rows
         ) line_data ON true
         WHERE ${where.join(" AND ")}
         -- Stable: two products or sizes with one name keep their order across pages (CRIT C12).
         ORDER BY p.name ASC, pv.position ASC, pv.name ASC, p.id ASC, pv.id ASC`,
        params,
      );

      return result.rows.map(mapVendorCatalogCandidateRow);
    } finally {
      client.release();
    }
  }

  async listVariantOverrides(input: {
    vendorId: number;
    productVariantIds: readonly number[];
  }): Promise<DropshipVendorVariantOverrideRecord[]> {
    if (input.productVariantIds.length === 0) {
      return [];
    }

    const client = await this.dbPool.connect();
    try {
      const result = await client.query<VariantOverrideRow>(
        `SELECT id, vendor_id, product_variant_id, enabled_override, marketplace_quantity_cap,
                notes, created_at, updated_at
         FROM dropship.dropship_vendor_variant_overrides
         WHERE vendor_id = $1
           AND product_variant_id = ANY($2::int[])`,
        [input.vendorId, input.productVariantIds],
      );
      return result.rows.map(mapVariantOverrideRow);
    } finally {
      client.release();
    }
  }
}

async function listSelectionRulesWithClient(
  client: PoolClient,
  input: ListDropshipVendorSelectionRulesInput,
): Promise<DropshipVendorSelectionRuleRecord[]> {
  const result = await client.query<SelectionRuleRow>(
    `SELECT id, revision_id, vendor_id, scope_type, action, product_line_id,
            product_id, product_variant_id, category, auto_connect_new_skus,
            auto_list_new_skus, priority, is_active, metadata, created_at, updated_at
     FROM dropship.dropship_vendor_selection_rules
     WHERE vendor_id = $1
       AND ($2::boolean = true OR is_active = true)
     ORDER BY is_active DESC, priority DESC, id ASC`,
    [input.vendorId, input.includeInactive],
  );
  return result.rows.map(mapSelectionRuleRow);
}

function mapCatalogExposureRuleRow(row: CatalogRuleRow): DropshipCatalogExposureRule {
  return {
    id: row.id,
    scopeType: row.scope_type as DropshipCatalogExposureRule["scopeType"],
    action: row.action as DropshipCatalogExposureRule["action"],
    productLineId: row.product_line_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    category: row.category,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
  };
}

function mapSelectionRuleRow(row: SelectionRuleRow): DropshipVendorSelectionRuleRecord {
  return {
    id: row.id,
    revisionId: row.revision_id,
    vendorId: row.vendor_id,
    scopeType: row.scope_type as DropshipVendorSelectionRuleRecord["scopeType"],
    action: row.action as DropshipVendorSelectionRuleRecord["action"],
    productLineId: row.product_line_id,
    productId: row.product_id,
    productVariantId: row.product_variant_id,
    category: row.category,
    autoConnectNewSkus: row.auto_connect_new_skus,
    autoListNewSkus: row.auto_list_new_skus,
    priority: row.priority,
    isActive: row.is_active,
    metadata: row.metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapVendorCatalogCandidateRow(row: VendorCatalogCandidateRow): DropshipVendorCatalogCandidate {
  return {
    productId: row.product_id,
    productSku: row.product_sku,
    productName: row.product_name,
    productVariantId: row.product_variant_id,
    variantSku: row.variant_sku,
    variantName: row.variant_name,
    unitsPerVariant: Math.max(1, Number(row.units_per_variant)),
    category: row.product_category,
    categoryId: row.product_category_id,
    categoryName: row.product_category_name,
    productLineIds: row.product_line_ids ?? [],
    productLineNames: row.product_line_names ?? [],
    productIsActive: row.product_is_active,
    variantIsActive: row.variant_is_active,
    variantUomType: parseCatalogVariantUomType(row.uom_type, { productVariantId: row.product_variant_id }),
    picked: row.picked === true,
  };
}

function mapVariantOverrideRow(row: VariantOverrideRow): DropshipVendorVariantOverrideRecord {
  return {
    id: row.id,
    vendorId: row.vendor_id,
    productVariantId: row.product_variant_id,
    enabledOverride: row.enabled_override,
    marketplaceQuantityCap: row.marketplace_quantity_cap,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Preserve the original failure.
  }
}
