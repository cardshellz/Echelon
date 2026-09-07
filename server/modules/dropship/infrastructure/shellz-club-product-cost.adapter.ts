import type { PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import type { DropshipProductCost, DropshipProductCostIssue, DropshipProductCostReader } from "../application/dropship-product-cost";
import { DropshipError } from "../domain/errors";
import {
  normalizeShopifyCostIdentity, resolveDropshipProductCost, unavailableDropshipProductCost,
  type ShellzClubCostOverride, type ShellzClubWholesaleAssignment,
} from "../domain/dropship-product-cost";

type CostClient = Pick<PoolClient, "query" | "release">;
type CostPool = { connect(): Promise<CostClient> };
interface VendorPlanRow {
  plan_id: string | null; entitlement_status: string; plan_is_active: boolean | null;
  includes_dropship: boolean | null; subscription_is_coherent: boolean;
  flat_discount_bp: number | null; flat_discount_percent: string | null;
}
interface ChannelAccessRow { channel_id: number; enabled: boolean; name: string; provider: string; status: string }
interface CatalogRow { id: number; shopify_variant_id: string | null; shopify_product_id: string | null }
interface ShopifyVariantRow { id: string; product_id: string; price: string | null }
interface OverrideRow { id: string; variant_id: string; product_id: string; override_type: string; fixed_price: string | null; discount_percent: string | null }
interface AssignmentRow { id: string; enabled: boolean; percentage_bp: number | null }
interface PolicyRow { plan_benefit_assignment_id: string; channel_id: number; mode: string | null; enabled: boolean; percentage_bp_override: number | null }

const MAX_COST_BATCH_SIZE = 10_000;

function groupBy<T, Key>(rows: readonly T[], key: (row: T) => Key): Map<Key, T[]> {
  const groups = new Map<Key, T[]>();
  for (const row of rows) {
    const id = key(row);
    const group = groups.get(id);
    if (group) group.push(row);
    else groups.set(id, [row]);
  }
  return groups;
}

/** Read the membership-owned source, not the asynchronous Shopify display projection.
 * Repeatable read keeps identity, exclusions and overrides from different edits apart. */
export class PgShellzClubProductCostAdapter implements DropshipProductCostReader {
  /** The caller owns the transaction/snapshot and commit. No nested BEGIN/COMMIT. */
  static forTransaction(client: Pick<PoolClient, "query">): PgShellzClubProductCostAdapter {
    return new PgShellzClubProductCostAdapter({ connect: async () => ({ query: client.query.bind(client), release: () => undefined }) }, undefined, false);
  }
  constructor(
    private readonly dbPool: CostPool = defaultPool,
    private readonly reportReadFailure: (input: { vendorId: number; variantCount: number; code: "source_read_failed"; sqlState: string | null; stage: string }) => void =
      (input) => console.warn("[dropship-product-cost] source read unavailable", input),
    private readonly ownsTransaction = true,
  ) {}

  async loadProductCosts(input: { vendorId: number; productVariantIds: readonly number[] }): Promise<ReadonlyMap<number, DropshipProductCost>> {
    if (!Number.isSafeInteger(input.vendorId) || input.vendorId <= 0
      || !Array.isArray(input.productVariantIds) || input.productVariantIds.length > MAX_COST_BATCH_SIZE
      || input.productVariantIds.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 2_147_483_647)) {
      throw new DropshipError("DROPSHIP_PRODUCT_COST_INPUT_INVALID", "A valid vendor and bounded catalog variant IDs are required.");
    }
    const ids = [...new Set(input.productVariantIds)];
    if (ids.length === 0) return new Map();
    const unavailable = (issue: DropshipProductCostIssue, planId: string | null = null) =>
      new Map(ids.map((id) => [id, unavailableDropshipProductCost(issue, planId)]));
    let client: CostClient | undefined;
    let discardClient = false;
    let planId: string | null = null;
    let stage = "connect";
    try {
      client = await this.dbPool.connect();
      stage = "begin_snapshot";
      if (this.ownsTransaction) await client.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      else await client.query("SAVEPOINT dropship_product_cost_read");
      stage = "vendor_plan";
      const result = await client.query<VendorPlanRow>(
        `SELECT v.current_plan_id::text AS plan_id, v.entitlement_status,
           p.is_active AS plan_is_active, p.includes_dropship, p.flat_discount_bp,
           p.flat_discount_percent::text,
           EXISTS (SELECT 1 FROM membership.member_subscriptions ms
             WHERE ms.id::text = v.current_subscription_id::text
               AND ms.member_id::text = v.member_id::text
               AND ms.plan_id::text = v.current_plan_id::text) AS subscription_is_coherent
         FROM dropship.dropship_vendors v
         LEFT JOIN membership.plans p ON p.id::text = v.current_plan_id::text
         WHERE v.id = $1`, [input.vendorId],
      );
      const vendor = result.rows[0];
      planId = vendor?.plan_id ?? null;
      let planIssue: DropshipProductCostIssue | null = null;
      if (!vendor) planIssue = "vendor_unavailable";
      else if (vendor.entitlement_status !== "active") planIssue = "entitlement_inactive";
      else if (!planId || vendor.plan_is_active !== true || vendor.subscription_is_coherent !== true) planIssue = "plan_unavailable";
      if (planIssue) {
        if (this.ownsTransaction) await client.query("COMMIT");
        else await client.query("RELEASE SAVEPOINT dropship_product_cost_read");
        return unavailable(planIssue, planId);
      }
      // No name/tier subscription selection: current_plan_id was written by the
      // entitlement owner. Verify its channel access without replacing that plan.
      stage = "channel_settings";
      const settings = await client.query<{ dropship_channel_id: number | null }>(
        `SELECT dropship_channel_id FROM public.app_settings LIMIT 2`,
      );
      if (settings.rows.length > 1) throw new Error("Ambiguous membership settings");
      const configuredChannelId = settings.rows[0]?.dropship_channel_id ?? null;
      stage = "plan_channel_access";
      const access = await client.query<ChannelAccessRow>(
        `SELECT a.channel_id, a.enabled, c.name, c.provider, c.status
         FROM membership.plan_channel_access a
         INNER JOIN channels.channels c ON c.id = a.channel_id
         WHERE a.plan_id::text = $1`, [planId],
      );
      const activeAccess = access.rows.filter((row) => row.enabled === true
        && ["", "active"].includes(String(row.status ?? "").trim().toLowerCase()));
      const eligibleAccess = activeAccess.filter((row) => configuredChannelId !== null
        ? row.channel_id === configuredChannelId
        : String(row.provider ?? "").trim().toLowerCase() === "dropship"
          || String(row.name ?? "").trim().toLowerCase().includes("dropship"));
      const planEligible = access.rows.length > 0 ? eligibleAccess.length > 0 : vendor!.includes_dropship === true;
      if (!planEligible) {
        if (this.ownsTransaction) await client.query("COMMIT");
        else await client.query("RELEASE SAVEPOINT dropship_product_cost_read");
        return unavailable("plan_unavailable", planId);
      }
      const channelId = configuredChannelId ?? (eligibleAccess.length === 1 ? eligibleAccess[0].channel_id : null);
      stage = "catalog_identity";
      const catalog = await client.query<CatalogRow>(
        `SELECT pv.id, pv.shopify_variant_id::text, p.shopify_product_id::text
         FROM catalog.product_variants pv
         INNER JOIN catalog.products p ON p.id = pv.product_id
         WHERE pv.id = ANY($1::int[])`, [ids],
      );
      const variantIds = [...new Set(catalog.rows.map((row) => normalizeShopifyCostIdentity(row.shopify_variant_id, "ProductVariant"))
        .filter((id): id is string => id !== null))];
      const productIds = [...new Set(catalog.rows.map((row) => normalizeShopifyCostIdentity(row.shopify_product_id, "Product"))
        .filter((id): id is string => id !== null))];
      stage = "shopify_variants";
      const variants = await client.query<ShopifyVariantRow>(
        `SELECT id::text, product_id::text, price::text FROM public.shopify_variants
         WHERE regexp_replace(id::text, '^gid://shopify/ProductVariant/', '') = ANY($1::text[])`, [variantIds],
      );
      stage = "variant_overrides";
      const overrides = await client.query<OverrideRow>(
        `SELECT id::text, variant_id, product_id, override_type, fixed_price::text, discount_percent::text
         FROM membership.plan_variant_overrides
         WHERE plan_id::text = $1 AND is_active = true
           AND regexp_replace(variant_id, '^gid://shopify/ProductVariant/', '') = ANY($2::text[])`, [planId, variantIds],
      );
      stage = "collection_exclusions";
      const exclusions = await client.query<{ collection_id: string }>(
        `SELECT collection_id FROM membership.plan_collection_exclusions WHERE plan_id::text = $1`, [planId],
      );
      stage = "product_collections";
      const collections = await client.query<{ product_id: string; collection_id: string }>(
        `SELECT product_id, collection_id FROM membership.product_collections
         WHERE regexp_replace(product_id, '^gid://shopify/Product/', '') = ANY($1::text[])`, [productIds],
      );
      stage = "wholesale_assignments";
      const assignments = await client.query<AssignmentRow>(
        `SELECT a.id::text, a.enabled, a.percentage_bp
         FROM membership.plan_benefit_assignments a
         INNER JOIN membership.plan_benefits b ON b.id = a.benefit_id
         WHERE a.plan_id::text = $1 AND b.kind = 'wholesale_percent' AND a.shipping_group_id IS NULL`, [planId],
      );
      stage = "wholesale_channel_policies";
      const policies = assignments.rows.length === 0 ? { rows: [] as PolicyRow[] } : await client.query<PolicyRow>(
        `SELECT plan_benefit_assignment_id::text, channel_id, mode, enabled, percentage_bp_override
         FROM membership.plan_benefit_channel_policies
         WHERE plan_benefit_assignment_id::text = ANY($1::text[]) AND channel_id = $2`,
        [assignments.rows.map((row) => row.id), channelId],
      );
      const wholesaleAssignments: ShellzClubWholesaleAssignment[] = assignments.rows.map((row) => ({
        enabled: row.enabled, percentageBp: row.percentage_bp,
        channelPolicies: policies.rows.filter((policy) => policy.plan_benefit_assignment_id === row.id).map((policy) => ({
          mode: policy.mode, enabled: policy.enabled, percentageBpOverride: policy.percentage_bp_override,
        })),
      }));
      const catalogById = groupBy(catalog.rows, (row) => row.id);
      const variantsById = groupBy(variants.rows, (row) => normalizeShopifyCostIdentity(row.id, "ProductVariant"));
      const overridesByVariant = groupBy(overrides.rows, (row) => normalizeShopifyCostIdentity(row.variant_id, "ProductVariant"));
      const collectionsByProduct = groupBy(collections.rows, (row) => normalizeShopifyCostIdentity(row.product_id, "Product"));
      const excludedCollectionIds = exclusions.rows.map((row) => row.collection_id);
      const resolved = new Map<number, DropshipProductCost>();
      stage = "resolve_costs";
      for (const id of ids) {
        const catalogRows = catalogById.get(id) ?? [];
        if (catalogRows.length !== 1) {
          resolved.set(id, unavailableDropshipProductCost(catalogRows.length === 0 ? "variant_unmapped" : "variant_ambiguous", planId));
          continue;
        }
        const row = catalogRows[0];
        const variantId = normalizeShopifyCostIdentity(row.shopify_variant_id, "ProductVariant");
        const productId = normalizeShopifyCostIdentity(row.shopify_product_id, "Product");
        const matchingOverrides: ShellzClubCostOverride[] = (overridesByVariant.get(variantId) ?? [])
          .map((override) => ({ id: override.id, variantId: override.variant_id, productId: override.product_id,
            overrideType: override.override_type, fixedPrice: override.fixed_price, discountPercent: override.discount_percent }));
        resolved.set(id, resolveDropshipProductCost({
          planId: planId!, shopifyVariantId: row.shopify_variant_id, shopifyProductId: row.shopify_product_id,
          variants: (variantsById.get(variantId) ?? [])
            .map((variant) => ({ id: variant.id, productId: variant.product_id, price: variant.price })),
          overrides: matchingOverrides,
          productCollectionIds: (collectionsByProduct.get(productId) ?? [])
            .map((collection) => collection.collection_id),
          excludedCollectionIds,
          wholesaleAssignments, legacyFlatDiscountBp: vendor!.flat_discount_bp,
          legacyFlatDiscountPercent: vendor!.flat_discount_percent,
          fallbackChannelAvailable: channelId !== null,
        }));
      }
      stage = "commit_snapshot";
      if (this.ownsTransaction) await client.query("COMMIT");
      else await client.query("RELEASE SAVEPOINT dropship_product_cost_read");
      return resolved;
    } catch (error: unknown) {
      if (client && this.ownsTransaction) {
        try { await client.query("ROLLBACK"); } catch { discardClient = true; }
      } else if (client) {
        // Preserve the caller's transaction when an advisory cost source is
        // unavailable. Cost-based recipes still block; retail-based ones need
        // not fail because an unrelated cost read failed.
        await client.query("ROLLBACK TO SAVEPOINT dropship_product_cost_read");
        await client.query("RELEASE SAVEPOINT dropship_product_cost_read");
      }
      // Never log SQL, connection strings, or raw database errors to the vendor.
      const rawCode = error && typeof error === "object" && "code" in error ? error.code : null;
      const sqlState = typeof rawCode === "string" && /^[0-9A-Z]{5}$/.test(rawCode) ? rawCode : null;
      try { this.reportReadFailure({ vendorId: input.vendorId, variantCount: ids.length, code: "source_read_failed", sqlState, stage }); } catch { /* Diagnostic sinks cannot manufacture a cost. */ }
      return unavailable("source_read_failed", planId);
    } finally {
      client?.release(discardClient);
    }
  }
}
