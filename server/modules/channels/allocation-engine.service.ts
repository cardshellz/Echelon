/**
 * Inventory Allocation Engine — Parallel Percentage Model
 *
 * Three-layer parallel allocation:
 *
 *   Layer 1: Warehouse → Channel Assignment
 *     Each channel sees ATP only from its assigned warehouses.
 *     If no assignments exist, all fulfillment warehouses are used.
 *
 *   Layer 2: Channel Allocation Rules
 *     Three modes: mirror (100%), share (X%), fixed (N units)
 *     Rules are scoped: channel default → product override → variant override
 *     Most-specific rule wins. Includes floor/ceiling/eligible controls.
 *
 *   Layer 3: ATP Calculation (parallel, not serial)
 *     Each channel computes its ATP independently — no drawdown.
 *     Channels see independent parallel views of inventory.
 *
 * Failure contract: the engine never returns a partially computed allocation.
 * A failed or invalid input raises a classified AllocationEngineError and the
 * caller must not publish anything for that product on this run. Audit logging
 * is deliberately best-effort (see logAllocation); the allocation itself is a
 * pure read.
 */

import { eq, and, sql, inArray } from "drizzle-orm";
import {
  channels,
  channelWarehouseAssignments,
  channelAllocationRules,
  channelProductLines,
  channelProductOverrides,
  channelVariantOverrides,
  productLineProducts,
  allocationAuditLog,
  warehouses,
  type Channel,
  type ChannelAllocationRule,
} from "@shared/schema";
import {
  isCustomerSellableVariant,
  type VariantSalesEligibility,
} from "@shared/catalog/variant-sales-eligibility";
import { logger } from "../../platform/observability/logger";
import { ALLOCATION_ERROR_CODES, AllocationEngineError } from "./allocation-engine.errors";

// ---------------------------------------------------------------------------
// Sales velocity — read at most once per allocation run
// ---------------------------------------------------------------------------

/** Window over which outbound demand is averaged for days-of-cover floors. */
export const VELOCITY_LOOKBACK_DAYS = 90;

/** Highest share percentage a rule may request; shares are whole percents. */
const MAX_SHARE_PERCENT = 100;

/**
 * Velocity provenance carried on every allocation row and audit entry so a
 * days-of-cover decision can be explained after the fact. A row never carries a
 * fabricated reading: when the query fails the whole run fails (see
 * queryAvgDailyUsage), so "read" always means a real successful read.
 */
export type AllocationVelocity =
  | { status: "read"; avgDailyUsage: number; lookbackDays: number }
  | { status: "not_required" };

const VELOCITY_NOT_REQUIRED: AllocationVelocity = { status: "not_required" };

/**
 * Query average daily outbound usage in base units for a product over the
 * lookback window.
 *
 * Fail-closed by design: any query failure raises a transient
 * AllocationEngineError instead of returning 0. Returning 0 here used to make a
 * days-of-cover floor evaluate to zero units and publish inventory the rule was
 * meant to hold back, and the poisoned zero was cached process-wide.
 */
async function queryAvgDailyUsage(db: DrizzleDb, productId: number): Promise<AllocationVelocity> {
  let rows: unknown;
  try {
    const result: any = await (db as any).execute(sql`
      SELECT COALESCE(SUM(oi.quantity * pv.units_per_variant), 0)::numeric AS total_outbound
      FROM wms.order_items oi
      JOIN wms.orders o ON o.id = oi.order_id
      JOIN catalog.product_variants pv ON pv.sku = oi.sku AND pv.is_active = true
      WHERE pv.product_id = ${productId}
        AND o.cancelled_at IS NULL
        AND o.warehouse_status != 'cancelled'
        AND oi.status != 'cancelled'
        AND o.order_placed_at > NOW() - MAKE_INTERVAL(days => ${VELOCITY_LOOKBACK_DAYS})
    `);
    rows = result?.rows ?? result;
  } catch (err: unknown) {
    throw new AllocationEngineError(
      ALLOCATION_ERROR_CODES.VELOCITY_UNAVAILABLE,
      "transient",
      "Sales velocity could not be read; days-of-cover floors cannot be evaluated for this product on this run.",
      { productId, lookbackDays: VELOCITY_LOOKBACK_DAYS, cause: err instanceof Error ? err.message : String(err) },
    );
  }

  // The aggregate has no GROUP BY, so a successful read is exactly one row with
  // a numeric total (COALESCE makes "no orders" a 0, never a NULL). Anything else
  // is a malformed result and is refused rather than read as zero demand.
  const firstRow = Array.isArray(rows) ? rows[0] : undefined;
  const rawTotal = (firstRow as { total_outbound?: unknown } | undefined)?.total_outbound;
  const totalOutbound = rawTotal === null || rawTotal === undefined ? Number.NaN : Number(rawTotal);
  if (!Number.isFinite(totalOutbound) || totalOutbound < 0) {
    throw new AllocationEngineError(
      ALLOCATION_ERROR_CODES.VELOCITY_INVALID,
      "permanent",
      "Sales velocity query returned no row or a value that is not a finite non-negative number.",
      { productId, totalOutbound: rawTotal ?? null },
    );
  }

  return {
    status: "read",
    avgDailyUsage: totalOutbound / VELOCITY_LOOKBACK_DAYS,
    lookbackDays: VELOCITY_LOOKBACK_DAYS,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DrizzleDb = {
  select: (...args: any[]) => any;
  insert: (...args: any[]) => any;
  update: (...args: any[]) => any;
  delete: (...args: any[]) => any;
  transaction: <T>(fn: (tx: any) => Promise<T>) => Promise<T>;
};

type AtpVariantRow = {
  productVariantId: number;
  sku: string;
  name: string;
  unitsPerVariant: number;
  salesEligibility?: VariantSalesEligibility | null;
  atpUnits: number;
  atpBase: number;
};

type AtpService = {
  getAtpBase(productId: number): Promise<number>;
  getAtpPerVariant(productId: number): Promise<AtpVariantRow[]>;
  getAtpPerVariantByWarehouse(productId: number, warehouseId: number): Promise<AtpVariantRow[]>;
  getAtpBaseByWarehouse?(productId: number, warehouseId: number): Promise<number>;
};

/** Per-channel allocation result for a single variant */
export interface VariantChannelAllocation {
  channelId: number;
  channelName: string;
  channelProvider: string;
  channelPriority: number;
  productVariantId: number;
  sku: string;
  unitsPerVariant: number;
  /** Allocated sellable units of this variant for this channel */
  allocatedUnits: number;
  /** Allocated base units */
  allocatedBase: number;
  /** Method used: mirror, share, fixed, zero (blocked/floor/ineligible) */
  method: string;
  /** Why this amount was allocated */
  reason: string;
  /** Whether warehouse scope is configured or inherited from the legacy fallback. */
  warehouseScopeSource: "explicit" | "legacy_all_active_fallback";
  /** Sales-velocity provenance for days-of-cover evaluation on this row. */
  velocity: AllocationVelocity;
  /** Disaggregated sub-quantities per target warehouse */
  warehouseBreakdown: Array<{ warehouseId: number; qty: number }>;
}

/** Full allocation result for a product across all channels */
export interface ProductAllocationResult {
  productId: number;
  totalAtpBase: number;
  allocations: VariantChannelAllocation[];
  /** Channels that were blocked from this product */
  blocked: Array<{ channelId: number; reason: string }>;
}

/** Resolved allocation rule after scope resolution */
interface ResolvedRule {
  mode: "mirror" | "share" | "fixed";
  sharePct: number | null;
  fixedQty: number | null;
  floorAtp: number;
  floorType: "units" | "days";
  ceilingQty: number | null;
  eligible: boolean;
  scope: "channel" | "product" | "variant";
}

/** Default rule when no rules exist for a channel */
const DEFAULT_RULE: ResolvedRule = {
  mode: "mirror",
  sharePct: null,
  fixedQty: null,
  floorAtp: 0,
  floorType: "units",
  ceilingQty: null,
  eligible: true,
  scope: "channel",
};

const ALLOCATION_MODES = new Set<ResolvedRule["mode"]>(["mirror", "share", "fixed"]);

// ---------------------------------------------------------------------------
// Input validation — fail closed on anything that cannot be a real quantity
// ---------------------------------------------------------------------------

function assertSafeNonNegativeInteger(
  value: unknown,
  field: string,
  context: Readonly<Record<string, unknown>>,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AllocationEngineError(
      ALLOCATION_ERROR_CODES.INPUT_INVALID,
      "permanent",
      `${field} must be a safe non-negative integer.`,
      { ...context, field, value },
    );
  }
  return value;
}

function assertVariantInputs(variant: AtpVariantRow, productId: number): void {
  const context = { productId, productVariantId: variant.productVariantId, sku: variant.sku };
  const unitsPerVariant = assertSafeNonNegativeInteger(variant.unitsPerVariant, "unitsPerVariant", context);
  if (unitsPerVariant < 1) {
    throw new AllocationEngineError(
      ALLOCATION_ERROR_CODES.INPUT_INVALID,
      "permanent",
      "unitsPerVariant must be at least 1; a zero pack size cannot be allocated.",
      { ...context, field: "unitsPerVariant", value: unitsPerVariant },
    );
  }
  assertSafeNonNegativeInteger(variant.atpBase, "atpBase", context);
}

function optionalSafeNonNegativeInteger(
  value: unknown,
  field: string,
  context: Readonly<Record<string, unknown>>,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AllocationEngineError(
      ALLOCATION_ERROR_CODES.RULE_INVALID,
      "permanent",
      `Allocation rule ${field} must be a safe non-negative integer when set.`,
      { ...context, field, value },
    );
  }
  return value;
}

/**
 * Validate a stored rule before it can influence a published quantity. The
 * schema has no CHECK constraints on these columns, so an out-of-range share or
 * a negative cap would otherwise silently over- or under-allocate.
 */
function validateRule(rule: ChannelAllocationRule, channelId: number): ResolvedRule["mode"] {
  const context = { ruleId: rule.id, channelId, productId: rule.productId, productVariantId: rule.productVariantId };
  if (!ALLOCATION_MODES.has(rule.mode as ResolvedRule["mode"])) {
    throw new AllocationEngineError(
      ALLOCATION_ERROR_CODES.RULE_INVALID,
      "permanent",
      "Allocation rule mode must be mirror, share, or fixed.",
      { ...context, field: "mode", value: rule.mode },
    );
  }
  const sharePct = optionalSafeNonNegativeInteger(rule.sharePct, "sharePct", context);
  if (sharePct !== null && sharePct > MAX_SHARE_PERCENT) {
    throw new AllocationEngineError(
      ALLOCATION_ERROR_CODES.RULE_INVALID,
      "permanent",
      `Allocation rule sharePct must not exceed ${MAX_SHARE_PERCENT}.`,
      { ...context, field: "sharePct", value: sharePct },
    );
  }
  optionalSafeNonNegativeInteger(rule.fixedQty, "fixedQty", context);
  optionalSafeNonNegativeInteger(rule.ceilingQty, "ceilingQty", context);
  optionalSafeNonNegativeInteger(rule.floorAtp, "floorAtp", context);
  return rule.mode as ResolvedRule["mode"];
}

/**
 * Fixed and ceiling caps are drawn down warehouse by warehouse (see
 * computeAllocation), so the walk order decides which warehouse's stock is
 * published. Higher priority first, then lower warehouse id, so the same inputs
 * always produce the same per-warehouse breakdown regardless of the order rows
 * come back from the database. Never mutates its input.
 */
export function orderWarehouseAssignments<T extends { warehouseId: number; priority?: number | null }>(
  assignments: readonly T[],
): T[] {
  // A missing priority is the column default (0); anything else that is not a
  // safe integer would make the sort unpredictable, so it is refused.
  const priorityOf = (assignment: T): number => assignment.priority ?? 0;
  for (const assignment of assignments) {
    if (!Number.isSafeInteger(priorityOf(assignment)) || !Number.isSafeInteger(assignment.warehouseId)) {
      throw new AllocationEngineError(
        ALLOCATION_ERROR_CODES.INPUT_INVALID,
        "permanent",
        "Warehouse assignment priority and warehouse id must be safe integers.",
        { warehouseId: assignment.warehouseId, priority: assignment.priority ?? null },
      );
    }
  }
  return [...assignments].sort(
    (left, right) => priorityOf(right) - priorityOf(left) || left.warehouseId - right.warehouseId,
  );
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class AllocationEngine {
  constructor(
    private readonly db: DrizzleDb,
    private readonly atpService: AtpService,
  ) {}

  // -------------------------------------------------------------------------
  // 1. ALLOCATE — compute parallel allocations for a product
  // -------------------------------------------------------------------------

  /**
   * Calculate inventory allocation for all active channels for a product.
   *
   * Algorithm (parallel — each channel independently):
   * 1. Load active channels
   * 2. For each channel:
   *    a. Determine assigned warehouses (or all fulfillment warehouses)
   *    b. Sum ATP across assigned warehouses → base_atp
   *    c. Load allocation rules (channel default, product override, variant override)
   *    d. For each variant, resolve most-specific rule and compute channel ATP
   * 3. Audit log all decisions (best-effort)
   *
   * @throws AllocationEngineError (transient) when sales velocity cannot be read
   *   and a days-of-cover rule needs it; nothing is returned for the product.
   * @throws AllocationEngineError (permanent) when an input or rule is invalid.
   */
  async allocateProduct(
    productId: number,
    triggeredBy?: string,
  ): Promise<ProductAllocationResult> {
    const result = await this.calculateProduct(productId);
    await this.logAllocation(result, triggeredBy);
    return result;
  }

  /**
   * Calculate the exact legacy channel allocation without persisting allocation
   * audit rows or invoking a provider adapter. Safe to call from read paths.
   */
  async previewProduct(productId: number): Promise<ProductAllocationResult> {
    return this.calculateProduct(productId);
  }

  private async calculateProduct(productId: number): Promise<ProductAllocationResult> {
    const result: ProductAllocationResult = {
      productId,
      totalAtpBase: 0,
      allocations: [],
      blocked: [],
    };

    // Sales velocity is read lazily, at most once per run, and only when some
    // channel carries a days-of-cover rule for this product.
    let velocityReading: AllocationVelocity | null = null;
    const readVelocity = async (): Promise<AllocationVelocity> => {
      if (velocityReading === null) {
        velocityReading = await queryAvgDailyUsage(this.db, productId);
      }
      return velocityReading;
    };

    // 1. Get global ATP (for the result summary)
    const authoritativeVariantAtp = await this.atpService.getAtpPerVariant(productId);
    // Keep internal-only inventory inside the authoritative ATP calculation as
    // build/component supply, but never emit it as a channel allocation target.
    const globalVariantAtp = authoritativeVariantAtp.filter(isCustomerSellableVariant);
    if (globalVariantAtp.length === 0) return result;
    for (const variant of globalVariantAtp) assertVariantInputs(variant, productId);

    result.totalAtpBase = globalVariantAtp[0].atpBase;

    // 2. Load active channels
    const activeChannels: Channel[] = await this.db
      .select()
      .from(channels)
      .where(eq(channels.status, "active"))
      .orderBy(sql`${channels.priority} DESC`);

    if (activeChannels.length === 0) return result;

    const channelIds = activeChannels.map((c) => c.id);

    // 3. Product line gate check
    const productLineRows = await this.db
      .select({ productLineId: productLineProducts.productLineId })
      .from(productLineProducts)
      .where(eq(productLineProducts.productId, productId));
    const productLineIds = new Set(productLineRows.map((r: any) => r.productLineId));

    let eligibleChannelIds: Set<number> | null = null;
    if (productLineIds.size > 0) {
      const channelLineRows = await this.db
        .select({
          channelId: channelProductLines.channelId,
          productLineId: channelProductLines.productLineId,
        })
        .from(channelProductLines)
        .where(
          and(
            inArray(channelProductLines.channelId, channelIds),
            eq(channelProductLines.isActive, true),
          ),
        );

      eligibleChannelIds = new Set<number>();
      for (const row of channelLineRows) {
        if (productLineIds.has(row.productLineId)) {
          eligibleChannelIds.add(row.channelId);
        }
      }
    }

    // 4. Load warehouse assignments for all channels
    const warehouseAssignments: Array<{ channelId: number; warehouseId: number; priority: number }> =
      await this.db
        .select()
        .from(channelWarehouseAssignments)
        .where(
          and(
            inArray(channelWarehouseAssignments.channelId, channelIds),
            eq(channelWarehouseAssignments.enabled, true),
          ),
        );

    // Group warehouse IDs by channel in a fixed order: caps are drawn down
    // warehouse by warehouse, so database row order must never decide which
    // warehouse's stock gets published.
    const warehousesByChannel = new Map<number, number[]>();
    for (const wa of orderWarehouseAssignments(warehouseAssignments)) {
      const list = warehousesByChannel.get(wa.channelId) ?? [];
      list.push(wa.warehouseId);
      warehousesByChannel.set(wa.channelId, list);
    }

    // 5. Load all fulfillment warehouses (fallback when no assignments)
    let allFulfillmentWarehouseIds: number[] | null = null;
    const channelsNeedingDefault = activeChannels.filter(
      (c) => !warehousesByChannel.has(c.id),
    );
    if (channelsNeedingDefault.length > 0) {
      const fulfillmentWarehouses = await this.db
        .select({ id: warehouses.id })
        .from(warehouses)
        .where(
          and(
            eq(warehouses.isActive, 1),
            inArray(warehouses.warehouseType, ["operations", "3pl"]),
          ),
        );
      // Same determinism for the fallback: lowest warehouse id first.
      allFulfillmentWarehouseIds = fulfillmentWarehouses
        .map((w: any) => w.id)
        .sort((left: number, right: number) => left - right);
    }

    // 6. Load allocation rules for all channels + global rules (channelId IS NULL)
    const allRules: ChannelAllocationRule[] = await this.db
      .select()
      .from(channelAllocationRules)
      .where(
        sql`${channelAllocationRules.channelId} IN (${sql.join(channelIds.map(id => sql`${id}`), sql`, `)}) OR ${channelAllocationRules.channelId} IS NULL`
      );

    // Separate global rules (channelId === null) from per-channel rules
    const globalRules: ChannelAllocationRule[] = [];
    const rulesByChannel = new Map<number, ChannelAllocationRule[]>();
    for (const rule of allRules) {
      if (rule.channelId === null) {
        globalRules.push(rule);
      } else {
        const list = rulesByChannel.get(rule.channelId) ?? [];
        list.push(rule);
        rulesByChannel.set(rule.channelId, list);
      }
    }

    // 6.5 Load channel product + variant overrides (is_listed = false blocks allocation)
    const productOverrides = await this.db
      .select({
        channelId: channelProductOverrides.channelId,
        productId: channelProductOverrides.productId,
        isListed: channelProductOverrides.isListed,
      })
      .from(channelProductOverrides)
      .where(
        and(
          inArray(channelProductOverrides.channelId, channelIds),
          eq(channelProductOverrides.productId, productId),
        ),
      );

    const listedOverridesByChannelProduct = new Map<string, boolean>();
    for (const row of productOverrides) {
      if (row.channelId && row.productId) {
        listedOverridesByChannelProduct.set(`${row.channelId}:${row.productId}`, row.isListed !== 0);
      }
    }

    const variantOverrides = await this.db
      .select({
        channelId: channelVariantOverrides.channelId,
        productVariantId: channelVariantOverrides.productVariantId,
        isListed: channelVariantOverrides.isListed,
      })
      .from(channelVariantOverrides)
      .where(inArray(channelVariantOverrides.channelId, channelIds));

    const listedOverridesByChannelVariant = new Map<string, boolean>();
    for (const row of variantOverrides) {
      if (row.channelId && row.productVariantId) {
        listedOverridesByChannelVariant.set(`${row.channelId}:${row.productVariantId}`, row.isListed !== 0);
      }
    }

    // 7. For each channel, compute ATP independently (parallel model)
    for (const channel of activeChannels) {
      const warehouseScopeSource = warehousesByChannel.has(channel.id)
        ? "explicit" as const
        : "legacy_all_active_fallback" as const;
      // Product line gate
      if (eligibleChannelIds !== null && !eligibleChannelIds.has(channel.id)) {
        result.blocked.push({
          channelId: channel.id,
          reason: "Product line not assigned to this channel",
        });
        continue;
      }

      const productIsListed = listedOverridesByChannelProduct.get(`${channel.id}:${productId}`);
      if (productIsListed === false) {
        result.blocked.push({
          channelId: channel.id,
          reason: "Product is explicitly unlisted for this channel (via overrides)",
        });
        for (const variant of globalVariantAtp) {
          result.allocations.push(zeroAllocation(
            channel,
            variant,
            "Product is explicitly unlisted for this channel (via overrides)",
            warehouseScopeSource,
            VELOCITY_NOT_REQUIRED,
          ));
        }
        continue;
      }

      // Determine assigned warehouses
      const assignedWarehouseIds = warehousesByChannel.get(channel.id)
        ?? allFulfillmentWarehouseIds
        ?? [];

      // Calculate each variant's ATP across assigned warehouses. Fungible
      // strategies return the same base pool for every variant; physical-only
      // products return an exact per-variant pool.
      const channelBaseAtpByVariant = new Map<number, number>();
      const warehouseRawAtpByVariant = new Map<number, Map<number, number>>();
      for (const variant of globalVariantAtp) {
        channelBaseAtpByVariant.set(variant.productVariantId, 0);
        warehouseRawAtpByVariant.set(variant.productVariantId, new Map());
      }

      for (const whId of assignedWarehouseIds) {
        const whVariants = await this.atpService.getAtpPerVariantByWarehouse(productId, whId);
        const warehouseAtpByVariant = new Map(
          whVariants.map((variant) => [variant.productVariantId, variant.atpBase]),
        );
        for (const variant of globalVariantAtp) {
          const variantAtpBase = assertSafeNonNegativeInteger(
            warehouseAtpByVariant.get(variant.productVariantId) ?? 0,
            "warehouseAtpBase",
            { productId, productVariantId: variant.productVariantId, warehouseId: whId },
          );
          channelBaseAtpByVariant.set(
            variant.productVariantId,
            (channelBaseAtpByVariant.get(variant.productVariantId) ?? 0) + variantAtpBase,
          );
          warehouseRawAtpByVariant.get(variant.productVariantId)!.set(whId, variantAtpBase);
        }
      }

      // Get channel's rules + merge with global rules (per-channel takes priority)
      const channelRules = rulesByChannel.get(channel.id) ?? [];

      // Resolve channel-level default rule (per-channel > global)
      const channelDefaultRule = channelRules.find(
        (r) => r.productId === null && r.productVariantId === null,
      ) ?? globalRules.find(
        (r) => r.productId === null && r.productVariantId === null,
      );

      // Resolve product-level rule (per-channel > global)
      const productRule = channelRules.find(
        (r) => r.productId === productId && r.productVariantId === null,
      ) ?? globalRules.find(
        (r) => r.productId === productId && r.productVariantId === null,
      );

      // A days-of-cover rule anywhere in this channel's rule set needs the
      // product's velocity. The read happens once per run and fails closed.
      const allChannelAndGlobalRules = [...channelRules, ...globalRules];
      const needsVelocity = allChannelAndGlobalRules.some(
        (r) => r.floorType === "days" && (r.floorAtp ?? 0) > 0,
      );
      const velocity: AllocationVelocity = needsVelocity ? await readVelocity() : VELOCITY_NOT_REQUIRED;

      // Check product-level eligibility first
      const productResolvedRule = this.resolveRule(channel.id, channelDefaultRule, productRule, undefined);
      if (!productResolvedRule.eligible) {
        result.blocked.push({
          channelId: channel.id,
          reason: "Product ineligible for this channel",
        });
        // Push zero allocations for all variants
        for (const variant of globalVariantAtp) {
          result.allocations.push(zeroAllocation(
            channel,
            variant,
            "Product ineligible for this channel",
            warehouseScopeSource,
            velocity,
          ));
        }
        continue;
      }

      // Per-variant allocation
      for (const variant of globalVariantAtp) {
        // Consult channel variant override
        const isListed = listedOverridesByChannelVariant.get(`${channel.id}:${variant.productVariantId}`);
        if (isListed === false) {
          result.allocations.push(zeroAllocation(
            channel,
            variant,
            "Variant is explicitly unlisted for this channel (via overrides)",
            warehouseScopeSource,
            velocity,
          ));
          continue;
        }

        // Find variant-level rule (per-channel > global)
        const variantRule = channelRules.find(
          (r) => r.productVariantId === variant.productVariantId,
        ) ?? globalRules.find(
          (r) => r.productVariantId === variant.productVariantId,
        );

        const resolved = this.resolveRule(channel.id, channelDefaultRule, productRule, variantRule);
        const channelBaseAtp = channelBaseAtpByVariant.get(variant.productVariantId) ?? 0;
        const warehouseRawAtp = warehouseRawAtpByVariant.get(variant.productVariantId) ?? new Map();
        const allocation = this.computeAllocation(
          channelBaseAtp,
          warehouseRawAtp,
          variant,
          resolved,
          channel,
          assignedWarehouseIds,
          velocity,
          warehouseScopeSource,
        );

        result.allocations.push(allocation);
      }
    }

    return result;
  }

  // -------------------------------------------------------------------------
  // Rule Resolution — most specific wins
  // -------------------------------------------------------------------------

  /**
   * Resolve the most specific rule. Variant > Product > Channel default.
   * If no rules exist at all, returns the DEFAULT_RULE (mirror, 100%).
   * The winning rule is validated before it can influence a quantity.
   */
  private resolveRule(
    channelId: number,
    channelDefault?: ChannelAllocationRule | null,
    productOverride?: ChannelAllocationRule | null,
    variantOverride?: ChannelAllocationRule | null,
  ): ResolvedRule {
    // Most specific wins
    const rule = variantOverride ?? productOverride ?? channelDefault;
    if (!rule) return { ...DEFAULT_RULE };

    const scope = variantOverride ? "variant"
      : productOverride ? "product"
      : "channel";

    const mode = validateRule(rule, channelId);

    return {
      mode,
      sharePct: rule.sharePct,
      fixedQty: rule.fixedQty,
      floorAtp: rule.floorAtp ?? 0,
      floorType: rule.floorType === "days" ? "days" : "units",
      ceilingQty: rule.ceilingQty,
      eligible: rule.eligible,
      scope,
    };
  }

  // -------------------------------------------------------------------------
  // ATP Computation — single variant, single channel
  // -------------------------------------------------------------------------

  private computeAllocation(
    channelBaseAtp: number,
    warehouseRawAtp: Map<number, number>,
    variant: { productVariantId: number; sku: string; name: string; unitsPerVariant: number },
    rule: ResolvedRule,
    channel: Channel,
    assignedWarehouseIds: number[],
    velocity: AllocationVelocity,
    warehouseScopeSource: VariantChannelAllocation["warehouseScopeSource"],
  ): VariantChannelAllocation {
    const base = {
      channelId: channel.id,
      channelName: channel.name,
      channelProvider: channel.provider,
      channelPriority: channel.priority,
      productVariantId: variant.productVariantId,
      sku: variant.sku,
      unitsPerVariant: variant.unitsPerVariant,
      warehouseScopeSource,
      velocity,
    };

    // Step 1: Eligibility check
    if (!rule.eligible) {
      return {
        ...base,
        allocatedUnits: 0,
        allocatedBase: 0,
        method: "zero",
        reason: "Variant ineligible for this channel",
        warehouseBreakdown: [],
      };
    }

    // Step 2: Floor check — if base ATP below threshold, zero out
    if (rule.floorAtp > 0) {
      let effectiveFloor: number;
      let floorReason: string;

      if (rule.floorType === "days") {
        if (velocity.status !== "read") {
          // Engine invariant: needsVelocity covers every days rule in scope. Reaching
          // here means a days floor would be evaluated against no reading, which is
          // exactly the fail-open this engine must never do.
          throw new AllocationEngineError(
            ALLOCATION_ERROR_CODES.VELOCITY_REQUIRED,
            "permanent",
            "A days-of-cover floor was evaluated without a sales-velocity reading.",
            { channelId: channel.id, productVariantId: variant.productVariantId, floorDays: rule.floorAtp },
          );
        }
        effectiveFloor = Math.ceil(rule.floorAtp * velocity.avgDailyUsage);
        floorReason = `Floor triggered (days-of-cover): ATP ${channelBaseAtp} < floor ${effectiveFloor} (${rule.floorAtp} days × ${Math.round(velocity.avgDailyUsage * 100) / 100}/day)`;
      } else {
        effectiveFloor = rule.floorAtp;
        floorReason = `Floor triggered: ATP ${channelBaseAtp} < floor ${rule.floorAtp}`;
      }

      if (channelBaseAtp < effectiveFloor) {
        return {
          ...base,
          allocatedUnits: 0,
          allocatedBase: 0,
          method: "zero",
          reason: floorReason,
          warehouseBreakdown: [],
        };
      }
    }

    // Step 3 & 4: Determine global limit caps
    let remainingFixedOrCeiling = -1;
    let limitReason = "";

    if (rule.ceilingQty != null && rule.ceilingQty >= 0) {
      remainingFixedOrCeiling = rule.ceilingQty;
      limitReason = "Ceiling Cap";
    }
    if (rule.mode === "fixed") {
      const fixed = rule.fixedQty ?? 0;
      if (remainingFixedOrCeiling === -1 || fixed < remainingFixedOrCeiling) {
        remainingFixedOrCeiling = fixed;
        limitReason = "Fixed Cap";
      }
    }

    // Step 5: Apply allocation modes PER WAREHOUSE to assemble parts safely
    let totalAllocatedUnits = 0;
    const warehouseBreakdown: Array<{ warehouseId: number, qty: number }> = [];

    for (const whId of assignedWarehouseIds) {
      const whBaseAtp = warehouseRawAtp.get(whId) ?? 0;
      let locationBaseToUse = whBaseAtp;

      if (rule.mode === "share") {
        const pct = rule.sharePct ?? MAX_SHARE_PERCENT;
        locationBaseToUse = Math.floor(whBaseAtp * pct / MAX_SHARE_PERCENT);
      } else if (rule.mode === "mirror" || rule.mode === "fixed") {
        locationBaseToUse = whBaseAtp;
      }

      // Convert local piece pool into strictly assembled variant units
      let variantQty = Math.max(0, Math.floor(locationBaseToUse / variant.unitsPerVariant));

      // Apply the global limit constraint geometrically by case sizes
      if (remainingFixedOrCeiling !== -1) {
        const variantLimit = Math.floor(remainingFixedOrCeiling / variant.unitsPerVariant);
        if (variantQty > variantLimit) {
           variantQty = variantLimit;
        }
        // Draw down the remaining piece pool using the assembled cases
        remainingFixedOrCeiling -= (variantQty * variant.unitsPerVariant);
        remainingFixedOrCeiling = Math.max(0, remainingFixedOrCeiling);
      }

      warehouseBreakdown.push({ warehouseId: whId, qty: variantQty });
      totalAllocatedUnits += variantQty;
    }

    const allocatedBase = totalAllocatedUnits * variant.unitsPerVariant;
    if (!Number.isSafeInteger(totalAllocatedUnits) || !Number.isSafeInteger(allocatedBase)) {
      throw new AllocationEngineError(
        ALLOCATION_ERROR_CODES.RESULT_UNSAFE,
        "permanent",
        "Computed allocation left the safe integer range.",
        { channelId: channel.id, productVariantId: variant.productVariantId, totalAllocatedUnits, allocatedBase },
      );
    }

    let method = rule.mode;
    let reason = "Multi-warehouse breakdown.";
    if (limitReason) reason += ` Applied ${limitReason}.`;

    return {
      ...base,
      allocatedUnits: totalAllocatedUnits,
      allocatedBase,
      method,
      reason,
      warehouseBreakdown,
    };
  }

  // -------------------------------------------------------------------------
  // 2. GET ALLOCATED QTY — quick lookup for a specific variant+channel
  // -------------------------------------------------------------------------

  async getAllocatedQty(
    productId: number,
    productVariantId: number,
    channelId: number,
  ): Promise<number> {
    const allocation = await this.allocateProduct(productId);
    const match = allocation.allocations.find(
      (a) => a.productVariantId === productVariantId && a.channelId === channelId,
    );
    return match?.allocatedUnits ?? 0;
  }

  // -------------------------------------------------------------------------
  // 3. ALLOCATE AND GET SYNC TARGETS
  // -------------------------------------------------------------------------

  async allocateAndGetSyncTargets(
    productId: number,
    triggeredBy?: string,
  ): Promise<{
    allocation: ProductAllocationResult;
    syncTargets: Array<{
      channelId: number;
      provider: string;
      variantAllocations: Array<{
        productVariantId: number;
        allocatedUnits: number;
      }>;
    }>;
  }> {
    const allocation = await this.allocateProduct(productId, triggeredBy);

    const byChannel = new Map<number, {
      provider: string;
      variants: Array<{ productVariantId: number; allocatedUnits: number }>;
    }>();

    for (const a of allocation.allocations) {
      if (!byChannel.has(a.channelId)) {
        byChannel.set(a.channelId, {
          provider: a.channelProvider,
          variants: [],
        });
      }
      byChannel.get(a.channelId)!.variants.push({
        productVariantId: a.productVariantId,
        allocatedUnits: a.allocatedUnits,
      });
    }

    const syncTargets = Array.from(byChannel.entries()).map(([channelId, data]) => ({
      channelId,
      provider: data.provider,
      variantAllocations: data.variants,
    }));

    return { allocation, syncTargets };
  }

  // -------------------------------------------------------------------------
  // PRIVATE: Audit Logging
  // -------------------------------------------------------------------------

  /**
   * Best-effort audit trail. This is a deliberate side-channel: the allocation
   * result is already computed and returned to the caller, and a failed audit
   * insert must not block publication. The failure is logged with a structured
   * code so it is visible, never silently swallowed.
   */
  private async logAllocation(
    result: ProductAllocationResult,
    triggeredBy?: string,
  ): Promise<void> {
    if (result.allocations.length === 0) return;

    try {
      const entries = result.allocations.map((a) => ({
        productId: result.productId,
        productVariantId: a.productVariantId,
        channelId: a.channelId,
        totalAtpBase: result.totalAtpBase,
        allocatedQty: a.allocatedUnits,
        previousQty: null as number | null,
        allocationMethod: a.method,
        details: {
          reason: a.reason,
          channelPriority: a.channelPriority,
          unitsPerVariant: a.unitsPerVariant,
          allocatedBase: a.allocatedBase,
          warehouseScopeSource: a.warehouseScopeSource,
          warehouseBreakdown: a.warehouseBreakdown,
          velocity: a.velocity,
        },
        triggeredBy: triggeredBy ?? null,
      }));

      for (let i = 0; i < entries.length; i += 100) {
        const chunk = entries.slice(i, i + 100);
        await this.db.insert(allocationAuditLog).values(chunk);
      }
    } catch (err: unknown) {
      logger.warn("allocation_audit_write", {
        outcome: "failed",
        error_code: "ALLOCATION_AUDIT_WRITE_FAILED",
        product_id: result.productId,
        triggered_by: triggeredBy ?? null,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function zeroAllocation(
  channel: Channel,
  variant: AtpVariantRow,
  reason: string,
  warehouseScopeSource: VariantChannelAllocation["warehouseScopeSource"],
  velocity: AllocationVelocity,
): VariantChannelAllocation {
  return {
    channelId: channel.id,
    channelName: channel.name,
    channelProvider: channel.provider,
    channelPriority: channel.priority,
    productVariantId: variant.productVariantId,
    sku: variant.sku,
    unitsPerVariant: variant.unitsPerVariant,
    allocatedUnits: 0,
    allocatedBase: 0,
    method: "zero",
    reason,
    warehouseScopeSource,
    velocity,
    warehouseBreakdown: [],
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAllocationEngine(db: any, atpService: any) {
  return new AllocationEngine(db, atpService);
}

export type { AllocationEngine };
