import type { InventoryChannelExposureRuntimePlan } from "@shared/types/inventory-channel-exposure";
import type { InventoryAvailabilityRuntimeAuthority } from "./inventory-availability-runtime-atp.service";

export interface ActivePublicationVariantMapping {
  productVariantId: number;
  externalInventoryItemId: string;
  externalSku: string | null;
}

export interface ActiveInventoryPublicationTarget {
  publicationTargetId: number;
  publicationTargetRevision: string;
  channelId: number;
  channelName: string;
  providerKey: string;
  destinationKind: "channel_connection" | "dropship_store_connection";
  channelConnectionId: number | null;
  dropshipStoreConnectionId: number | null;
  providerScopeType: "account" | "location";
  externalScopeId: string;
  sourceBindingId: number | null;
  sourceWarehouseIds: number[];
  mappings: ActivePublicationVariantMapping[];
}

export interface CanonicalInventoryPublicationIntent {
  publicationTargetId: number;
  publicationTargetRevision: string;
  productVariantId: number;
  sku: string | null;
  desiredQuantity: string;
  channelId: number;
  channelName: string;
  destinationKind: "channel_connection" | "dropship_store_connection";
  channelConnectionId: number | null;
  dropshipStoreConnectionId: number | null;
  providerKey: string;
  providerScopeType: "account" | "location";
  externalScopeId: string;
  externalInventoryItemId: string;
  externalSku: string | null;
  sourceWarehouseIds: number[];
  blockerCodes: string[];
}

export interface CanonicalInventoryPublicationEnqueueResult {
  enqueuedRows: number;
  coalescedRows: number;
  enqueuedPublicationKeys: string[];
  coalescedPublicationKeys: string[];
}

/** A channel quantity read has no provider inventory identity or write authority. */
export type CanonicalInventoryChannelQuantity = Omit<CanonicalInventoryPublicationIntent,
  "externalInventoryItemId" | "externalSku">;
export type InventoryChannelQuantityRouteResult<T> =
  | { authority: "legacy"; legacyResult: T }
  | { authority: "canonical"; publication: Omit<CanonicalInventoryPublicationResult, "rows"> & {
      rows: CanonicalInventoryChannelQuantity[];
    } };

export interface InventoryAvailabilityRuntimePublicationContext {
  authority: InventoryAvailabilityRuntimeAuthority;
  authorityRevision: string;
  activationRunId: string | null;
  listActivePublicationProductIds(channelId?: number): Promise<number[]>;
  /** Retained identities for variants no longer eligible for positive stock. */
  listUnmanagedPublicationVariantIds?(productId: number): Promise<number[]>;
  planProduct(productId: number, channelId?: number,
    purpose?: "publication" | "channel_quantity_read"): Promise<InventoryChannelExposureRuntimePlan>;
  loadActivePublicationTargets(input: {
    productId: number;
    productVariantIds: readonly number[];
    channelId?: number;
  }): Promise<ActiveInventoryPublicationTarget[]>;
  enqueueFullPublications(
    activationRunId: string,
    intents: readonly CanonicalInventoryPublicationIntent[],
  ): Promise<CanonicalInventoryPublicationEnqueueResult>;
}

export interface InventoryAvailabilityRuntimePublicationExecutor {
  execute<T>(
    work: (context: InventoryAvailabilityRuntimePublicationContext) => Promise<T>,
  ): Promise<T>;
}

export interface CanonicalInventoryPublicationResult {
  authority: "canonical";
  authorityRevision: string;
  activationRunId: string;
  dryRun: boolean;
  productId: number;
  rows: CanonicalInventoryPublicationIntent[];
  enqueuedRows: number;
  coalescedRows: number;
  enqueuedPublicationKeys: string[];
  coalescedPublicationKeys: string[];
  /** Present only for `blockedTargets: "isolate"`: targets skipped this run. */
  blockedTargets?: BlockedInventoryPublicationTarget[];
}

/** A destination that is not safe to publish. Isolation skips it so it cannot
 * stop the product's other destinations, or the warehouse operation that changed
 * stock; it stays fail-closed (no quantity is sent to it) until its data is fixed. */
export interface BlockedInventoryPublicationTarget {
  publicationTargetId: number;
  channelId: number;
  channelName: string;
  errorCode: string;
  blockerCodes: string[];
  productVariantIds: number[];
}

/**
 * "reject" (default) fails the whole call on any unsafe target: listing setup,
 * enable/resume and exact-scope callers need that answer.
 * "isolate" publishes every safe target and reports the unsafe ones: inventory
 * change fan-out must never let one broken listing stop other channels or custody.
 */
export type BlockedPublicationTargetPolicy = "reject" | "isolate";

export type InventoryPublicationRouteResult<T> =
  | { authority: "legacy"; legacyResult: T }
  | { authority: "canonical"; publication: CanonicalInventoryPublicationResult };

export interface InventoryAvailabilityRuntimePublicationLogger {
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
  /** Needs a human. Optional for existing adapters; falls back to warn. */
  error?(event: Readonly<Record<string, unknown>>): void;
}

const defaultLogger: InventoryAvailabilityRuntimePublicationLogger = {
  info(event) {
    console.info(JSON.stringify(event));
  },
  warn(event) {
    console.warn(JSON.stringify(event));
  },
  error(event) {
    console.error(JSON.stringify(event));
  },
};

export class InventoryAvailabilityRuntimePublicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityRuntimePublicationError";
  }
}

/**
 * The single inventory-publication authority boundary.
 *
 * Legacy publication executes only while the executor pins legacy authority.
 * Canonical publication calculates target-aware ATP from active definitions and
 * durably hands absolute desired quantities to the canonical outbox.
 */
export class AuthorityAwareInventoryPublicationService {
  constructor(
    private readonly executor: InventoryAvailabilityRuntimePublicationExecutor,
    private readonly channelId?: number,
    private readonly logger: InventoryAvailabilityRuntimePublicationLogger = defaultLogger,
  ) {
    if (channelId != null) positiveInteger(channelId, "channelId");
  }

  async readAuthority(): Promise<InventoryAvailabilityRuntimeAuthority> {
    return this.executor.execute(async (context) => context.authority);
  }

  /** Display and listing preparation use the same target-aware quantity planner
   * without constructing publication intents or visiting retained-stock cleanup.
   * An exact provider mapping is required later by the publication command. */
  async readProductQuantities<T>(input: {
    productId: number; dryRun: true; triggeredBy: string;
  }, legacyReader: () => Promise<T>): Promise<InventoryChannelQuantityRouteResult<T>> {
    const productId = positiveInteger(input.productId, "productId");
    nonblank(input.triggeredBy, "triggeredBy", 200);
    if (input.dryRun !== true) throw new InventoryAvailabilityRuntimePublicationError(
      "CHANNEL_QUANTITY_READ_ONLY_REQUIRED", "A channel quantity read cannot publish.");
    return this.executor.execute(async context => {
      if (context.authority === "legacy") return { authority: "legacy", legacyResult: await legacyReader() };
      const activationRunId = canonicalActivationRunId(context);
      const plan = await context.planProduct(productId, this.channelId, "channel_quantity_read");
      if (plan.authority !== "canonical" || plan.productId !== productId
        || plan.authorityRevision !== context.authorityRevision || plan.activationRunId !== activationRunId) {
        throw publicationError("CANONICAL_CHANNEL_QUANTITY_PLAN_MISMATCH",
          "The channel quantity plan does not match its pinned authority and product.", context, { productId });
      }
      const rows: CanonicalInventoryChannelQuantity[] = plan.targets
        .flatMap(target => target.rows.map(row => ({
          publicationTargetId: target.publicationTargetId,
          publicationTargetRevision: target.publicationTargetRevision,
          productVariantId: row.productVariantId, sku: row.sku, desiredQuantity: row.publishedUnits,
          channelId: target.channelId, channelName: target.channelName,
          destinationKind: target.destinationKind, channelConnectionId: target.channelConnectionId,
          dropshipStoreConnectionId: target.dropshipStoreConnectionId,
          providerKey: target.channelProvider.toLowerCase(), providerScopeType: target.providerScopeType,
          externalScopeId: target.externalScopeId,
          sourceWarehouseIds: row.sourceWarehouseBreakdown.map(source => source.warehouseId),
          blockerCodes: uniqueStrings([...target.blockers, ...row.blockers].map(blocker => blocker.code)),
        })));
      return { authority: "canonical", publication: {
        authority: "canonical", authorityRevision: context.authorityRevision, activationRunId,
        dryRun: true, productId, rows, enqueuedRows: 0, coalescedRows: 0,
        enqueuedPublicationKeys: [], coalescedPublicationKeys: [],
      } };
    });
  }

  async listProductIds(
    legacyReader: () => Promise<number[]>,
    channelId?: number,
  ): Promise<number[]> {
    const selectedChannelId = channelId == null
      ? this.channelId
      : positiveInteger(channelId, "channelId");
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") return uniquePositiveIntegers(await legacyReader(), "productId");
      return uniquePositiveIntegers(
        await context.listActivePublicationProductIds(selectedChannelId),
        "productId",
      );
    });
  }

  async publishProduct<T>(input: {
    productId: number;
    dryRun: boolean;
    channelId?: number;
    publicationTargetId?: number;
    /** Exact owner-reviewed members, including retained zero obligations. ATP
     * still uses the full product; this only limits emitted publication work. */
    productVariantIds?: readonly number[];
    triggeredBy?: string;
    blockedTargets?: BlockedPublicationTargetPolicy;
  }, legacyPublisher: () => Promise<T>): Promise<InventoryPublicationRouteResult<T>> {
    const productId = positiveInteger(input.productId, "productId");
    const dryRun = boolean(input.dryRun, "dryRun");
    const blockedTargets = input.blockedTargets ?? "reject";
    if (blockedTargets !== "reject" && blockedTargets !== "isolate") {
      throw new InventoryAvailabilityRuntimePublicationError("INVALID_INVENTORY_PUBLICATION_SCOPE",
        "Blocked-target policy must be reject or isolate.");
    }
    const channelId = input.channelId == null
      ? this.channelId
      : positiveInteger(input.channelId, "channelId");
    const publicationTargetId = input.publicationTargetId == null
      ? undefined
      : positiveInteger(input.publicationTargetId, "publicationTargetId");
    const productVariantIds = input.productVariantIds === undefined ? undefined
      : uniquePositiveIntegers(input.productVariantIds, "productVariantIds");
    if (productVariantIds && (publicationTargetId === undefined || productVariantIds.length === 0
      || productVariantIds.length !== input.productVariantIds!.length)) {
      throw new InventoryAvailabilityRuntimePublicationError("INVALID_INVENTORY_PUBLICATION_SCOPE",
        "Scoped publication requires one exact target and a nonempty set of unique variant IDs.");
    }
    // An exact-target caller asked about that target; isolating it would hide the answer.
    if (blockedTargets === "isolate" && (publicationTargetId !== undefined || productVariantIds)) {
      throw new InventoryAvailabilityRuntimePublicationError("INVALID_INVENTORY_PUBLICATION_SCOPE",
        "Blocked-target isolation applies only to whole-product fan-out publication.");
    }
    const triggeredBy = nonblank(input.triggeredBy ?? "inventory_publication", "triggeredBy", 200);
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        if (productVariantIds) throw new InventoryAvailabilityRuntimePublicationError("CANONICAL_PUBLICATION_SCOPE_REQUIRED",
          "An exact member publication scope requires canonical inventory authority.");
        return { authority: "legacy", legacyResult: await legacyPublisher() };
      }
      const publication = await this.planAndPublishCanonical(context, {
         productId,
         channelId,
         publicationTargetId,
          productVariantIds,
         dryRun,
        triggeredBy,
        blockedTargets,
      });
      return { authority: "canonical", publication };
    });
  }

  async publishVariantAvailability<T>(input: {
    productId: number;
    productVariantId: number;
    channelId: number;
    desiredActive: boolean;
    triggeredBy?: string;
  }, legacyPublisher: () => Promise<T>): Promise<InventoryPublicationRouteResult<T>> {
    const productId = positiveInteger(input.productId, "productId");
    const productVariantId = positiveInteger(input.productVariantId, "productVariantId");
    const channelId = positiveInteger(input.channelId, "channelId");
    const desiredActive = boolean(input.desiredActive, "desiredActive");
    const triggeredBy = nonblank(
      input.triggeredBy ?? "variant_availability_change",
      "triggeredBy",
      200,
    );
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        return { authority: "legacy", legacyResult: await legacyPublisher() };
      }
      const publication = desiredActive
        ? await this.planAndPublishCanonical(context, {
            productId,
            productVariantId,
            channelId,
            dryRun: false,
            triggeredBy,
          })
        : await this.publishCanonicalZero(context, {
            productId,
            productVariantId,
            channelId,
            triggeredBy,
          });
      return { authority: "canonical", publication };
    });
  }

  private async planAndPublishCanonical(
    context: InventoryAvailabilityRuntimePublicationContext,
    input: {
      productId: number;
      productVariantId?: number;
      channelId?: number;
      publicationTargetId?: number;
      productVariantIds?: readonly number[];
      dryRun: boolean;
      triggeredBy: string;
      blockedTargets?: BlockedPublicationTargetPolicy;
    },
  ): Promise<CanonicalInventoryPublicationResult> {
    const activationRunId = canonicalActivationRunId(context);
    const plan = await context.planProduct(
      input.productId,
      input.channelId ?? this.channelId,
    );
    const isolate = input.blockedTargets === "isolate";
    const blocked = new Map<number, BlockedInventoryPublicationTarget>();
    const block = isolate ? (target: BlockedInventoryPublicationTarget) => {
      const existing = blocked.get(target.publicationTargetId);
      blocked.set(target.publicationTargetId, existing ? { ...existing,
        blockerCodes: uniqueStrings([...existing.blockerCodes, ...target.blockerCodes]),
        productVariantIds: [...new Set([...existing.productVariantIds, ...target.productVariantIds])].sort((a, b) => a - b),
      } : target);
    } : undefined;
    const planned = publicationIntentsFromPlan(
      plan,
      context,
      input.productVariantId,
      input.publicationTargetId,
      input.productVariantIds,
      block,
    );
    for (const variantId of await context.listUnmanagedPublicationVariantIds?.(input.productId) ?? []) {
      if (input.productVariantId != null && input.productVariantId !== variantId) continue;
      if (input.productVariantIds && !input.productVariantIds.includes(variantId)) continue;
      planned.push(...await zeroPublicationIntents(context, input.productId, variantId,
        input.channelId ?? this.channelId, input.publicationTargetId, block));
    }
    // A target blocked for any member publishes nothing this run: a partial
    // projection of one destination is not a safe quantity either.
    const rows = planned.filter(row => !blocked.has(row.publicationTargetId));
    for (const target of blocked.values()) {
      (this.logger.error ?? this.logger.warn).call(this.logger, {
        event: "canonical_inventory_publication_target_isolated",
        level: "error",
        outcome: "target_skipped",
        error_code: target.errorCode,
        productId: input.productId,
        publicationTargetId: target.publicationTargetId,
        channelId: target.channelId,
        blockerCodes: target.blockerCodes,
        productVariantIds: target.productVariantIds,
        triggeredBy: input.triggeredBy,
        authorityRevision: context.authorityRevision,
        activationRunId,
      });
    }
    if (input.productVariantIds?.some(variantId => !rows.some(row => row.productVariantId === variantId
      && row.publicationTargetId === input.publicationTargetId))) {
      throw publicationError("CANONICAL_PUBLICATION_VARIANT_NOT_ELIGIBLE",
        "Every requested variant must belong to this product and exact publication target.", context,
        { productId: input.productId, publicationTargetId: input.publicationTargetId, productVariantIds: input.productVariantIds });
    }
    assertUnambiguousProviderScopes(rows, context, input.productId);
    for (const row of rows.filter((candidate) => candidate.blockerCodes.length > 0)) {
      this.logger.warn({
        event: "canonical_inventory_publication_projection_blocked",
        productId: input.productId,
        productVariantId: row.productVariantId,
        publicationTargetId: row.publicationTargetId,
        blockerCodes: row.blockerCodes,
        desiredQuantity: row.desiredQuantity,
        authorityRevision: context.authorityRevision,
        activationRunId,
      });
    }
    const queued = input.dryRun
      ? {
          enqueuedRows: 0,
          coalescedRows: 0,
          enqueuedPublicationKeys: [],
          coalescedPublicationKeys: [],
        }
      : await context.enqueueFullPublications(activationRunId, rows);
    const result = {
      authority: "canonical" as const,
      authorityRevision: context.authorityRevision,
      activationRunId,
      dryRun: input.dryRun,
      productId: input.productId,
      rows,
      ...queued,
      ...(isolate ? { blockedTargets: [...blocked.values()].sort((a, b) => a.publicationTargetId - b.publicationTargetId) } : {}),
    };
    this.logger.info({
      event: "canonical_inventory_publication_routed",
      productId: input.productId,
      productVariantId: input.productVariantId ?? null,
      channelId: input.channelId ?? this.channelId ?? null,
      publicationTargetId: input.publicationTargetId ?? null,
      dryRun: input.dryRun,
      triggeredBy: input.triggeredBy,
      plannedRows: rows.length,
      enqueuedRows: queued.enqueuedRows,
      coalescedRows: queued.coalescedRows,
      authorityRevision: context.authorityRevision,
      activationRunId,
    });
    return result;
  }

  private async publishCanonicalZero(
    context: InventoryAvailabilityRuntimePublicationContext,
    input: {
      productId: number;
      productVariantId: number;
      channelId: number;
      triggeredBy: string;
    },
  ): Promise<CanonicalInventoryPublicationResult> {
    const activationRunId = canonicalActivationRunId(context);
    const rows = await zeroPublicationIntents(context, input.productId, input.productVariantId, input.channelId);
    assertUnambiguousProviderScopes(rows, context, input.productId);
    const queued = await context.enqueueFullPublications(activationRunId, rows);
    this.logger.info({
      event: "canonical_inventory_variant_zero_routed",
      productId: input.productId,
      productVariantId: input.productVariantId,
      channelId: input.channelId,
      triggeredBy: input.triggeredBy,
      plannedRows: rows.length,
      enqueuedRows: queued.enqueuedRows,
      coalescedRows: queued.coalescedRows,
      authorityRevision: context.authorityRevision,
      activationRunId,
    });
    return {
      authority: "canonical",
      authorityRevision: context.authorityRevision,
      activationRunId,
      dryRun: false,
      productId: input.productId,
      rows,
      ...queued,
    };
  }
}

/** Shared retained-listing projection for publication and exact mapping review.
 * The loader must return only destinations selected by the listing owner. */
export async function zeroPublicationIntents(context: Pick<InventoryAvailabilityRuntimePublicationContext,
  "authority" | "authorityRevision" | "activationRunId" | "loadActivePublicationTargets">,
  productId: number, productVariantId: number, channelId?: number, publicationTargetId?: number,
  block?: (target: BlockedInventoryPublicationTarget) => void,
): Promise<CanonicalInventoryPublicationIntent[]> {
  const targets = await context.loadActivePublicationTargets({ productId, productVariantIds: [productVariantId], channelId });
  return targets.filter(target => publicationTargetId == null || target.publicationTargetId === publicationTargetId)
    .flatMap(target => {
      const mapping = target.mappings.find(candidate => candidate.productVariantId === productVariantId);
      if (!mapping && block) {
        block({ publicationTargetId: target.publicationTargetId, channelId: target.channelId, channelName: target.channelName,
          errorCode: "CANONICAL_PUBLICATION_MAPPING_MISSING", blockerCodes: ["PUBLICATION_TARGET_VARIANT_MAPPING_MISSING"],
          productVariantIds: [productVariantId] });
        return [];
      }
      if (!mapping) throw publicationError("CANONICAL_PUBLICATION_MAPPING_MISSING",
        "A retained listing has no exact provider identity to clear. Correct its saved listing link before retrying.",
        context, { productId, productVariantId, publicationTargetId: target.publicationTargetId });
      return [intent(target, mapping, productVariantId, null, "0", [])];
    });
}

function publicationIntentsFromPlan(
  plan: InventoryChannelExposureRuntimePlan,
  context: InventoryAvailabilityRuntimePublicationContext,
  productVariantId?: number,
  publicationTargetId?: number,
  productVariantIds?: readonly number[],
  block?: (target: BlockedInventoryPublicationTarget) => void,
): CanonicalInventoryPublicationIntent[] {
  if (plan.authority !== "canonical"
    || plan.activationRunId !== context.activationRunId
    || plan.authorityRevision !== context.authorityRevision) {
    throw publicationError(
      "CANONICAL_PUBLICATION_PLAN_AUTHORITY_MISMATCH",
      "The channel-exposure plan does not match the pinned canonical publication authority.",
      context,
      {
        planAuthority: plan.authority,
        planAuthorityRevision: plan.authorityRevision,
        planActivationRunId: plan.activationRunId,
      },
    );
  }

  const rows: CanonicalInventoryPublicationIntent[] = [];
  for (const target of plan.targets) {
    if (publicationTargetId != null && target.publicationTargetId !== publicationTargetId) continue;
    if ((!target.publishable && (!productVariantIds || target.blockers.length > 0)) || !target.sourceBinding) {
      const blockerCodes = uniqueStrings([
        ...target.blockers.map((blocker) => blocker.code),
        ...target.rows.flatMap((row) => row.blockers.map((blocker) => blocker.code)),
      ]);
      if (block) {
        block({ publicationTargetId: target.publicationTargetId, channelId: target.channelId, channelName: target.channelName,
          errorCode: publicationBlockerErrorCode(blockerCodes), blockerCodes,
          productVariantIds: blockedTargetVariantIds(target.rows) });
        continue;
      }
      throw publicationError(
        publicationBlockerErrorCode(blockerCodes),
        "The canonical channel-exposure plan contains a target that is not safe to publish.",
        context,
        {
          productId: plan.productId,
          publicationTargetId: target.publicationTargetId,
          blockerCodes,
        },
      );
    }
    for (const row of target.rows) {
      if (productVariantId != null && row.productVariantId !== productVariantId) continue;
      if (productVariantIds && !productVariantIds.includes(row.productVariantId)) continue;
      if (!row.mapping || row.blockers.length > 0) {
        throw publicationError(
          "CANONICAL_PUBLICATION_ROW_BLOCKED",
          "The canonical channel-exposure plan contains a row that is not safe to publish.",
          context,
          {
            productId: plan.productId,
            productVariantId: row.productVariantId,
            publicationTargetId: target.publicationTargetId,
            blockerCodes: row.blockers.map((blocker) => blocker.code),
          },
        );
      }
      rows.push(intent(
        {
          publicationTargetId: target.publicationTargetId,
          publicationTargetRevision: target.publicationTargetRevision,
          channelId: target.channelId,
          channelName: target.channelName,
          providerKey: target.channelProvider.toLowerCase(),
          destinationKind: target.destinationKind,
          channelConnectionId: target.channelConnectionId,
          dropshipStoreConnectionId: target.dropshipStoreConnectionId,
          providerScopeType: target.providerScopeType,
          externalScopeId: target.externalScopeId,
          sourceBindingId: target.sourceBinding.bindingId,
          sourceWarehouseIds: row.sourceWarehouseBreakdown.map(source => source.warehouseId),
          mappings: [],
        },
        {
          productVariantId: row.productVariantId,
          externalInventoryItemId: row.mapping.externalInventoryItemId,
          externalSku: row.mapping.externalSku,
        },
        row.productVariantId,
        row.sku,
        row.publishedUnits,
        uniqueStrings(row.warnings.map((warning) => warning.code)),
      ));
    }
  }
  if (productVariantId != null && !rows.some((row) => row.productVariantId === productVariantId)) {
    throw publicationError(
      "CANONICAL_PUBLICATION_VARIANT_NOT_ELIGIBLE",
      "The requested canonical publication variant is missing, inactive, or not eligible.",
      context,
      { productId: plan.productId, productVariantId },
    );
  }
  assertUnambiguousProviderScopes(rows, context, plan.productId);
  return rows;
}

/** The members a blocked target withholds: its unsafe rows, or every row when
 * the blocker is target-wide (source binding, policy, node). */
function blockedTargetVariantIds(rows: InventoryChannelExposureRuntimePlan["targets"][number]["rows"]): number[] {
  const unsafe = rows.filter(row => row.blockers.length > 0 || !row.mapping);
  return (unsafe.length > 0 ? unsafe : rows).map(row => row.productVariantId).sort((a, b) => a - b);
}

function publicationBlockerErrorCode(blockerCodes: readonly string[]): string {
  if (blockerCodes.includes("PUBLICATION_TARGET_VARIANT_MAPPING_MISSING")) {
    return "CANONICAL_PUBLICATION_MAPPING_MISSING";
  }
  if (blockerCodes.includes("CHANNEL_SOURCE_BINDING_MISSING")) {
    return "CANONICAL_PUBLICATION_SOURCE_BINDING_MISSING";
  }
  if (blockerCodes.includes("CHANNEL_EXPOSURE_POLICY_INCOMPLETE")) {
    return "CANONICAL_PUBLICATION_POLICY_INCOMPLETE";
  }
  return "CANONICAL_PUBLICATION_TARGET_BLOCKED";
}

function intent(
  target: ActiveInventoryPublicationTarget,
  mapping: ActivePublicationVariantMapping,
  productVariantId: number,
  sku: string | null,
  desiredQuantity: string,
  blockerCodes: string[],
): CanonicalInventoryPublicationIntent {
  return {
    publicationTargetId: target.publicationTargetId,
    publicationTargetRevision: target.publicationTargetRevision,
    productVariantId,
    sku,
    desiredQuantity,
    channelId: target.channelId,
    channelName: target.channelName,
    destinationKind: target.destinationKind,
    channelConnectionId: target.channelConnectionId,
    dropshipStoreConnectionId: target.dropshipStoreConnectionId,
    providerKey: target.providerKey,
    providerScopeType: target.providerScopeType,
    externalScopeId: target.externalScopeId,
    externalInventoryItemId: mapping.externalInventoryItemId,
    externalSku: mapping.externalSku,
    sourceWarehouseIds: [...target.sourceWarehouseIds],
    blockerCodes,
  };
}

function assertUnambiguousProviderScopes(
  rows: readonly CanonicalInventoryPublicationIntent[],
  context: InventoryAvailabilityRuntimePublicationContext,
  productId: number,
): void {
  const scopesByDestinationVariant = new Map<string, CanonicalInventoryPublicationIntent[]>();
  for (const row of rows) {
    const destinationId = row.destinationKind === "channel_connection"
      ? row.channelConnectionId
      : row.dropshipStoreConnectionId;
    const key = `${row.destinationKind}:${destinationId}:${row.productVariantId}`;
    const values = scopesByDestinationVariant.get(key) ?? [];
    values.push(row);
    scopesByDestinationVariant.set(key, values);
  }
  for (const values of scopesByDestinationVariant.values()) {
    if (values.length <= 1 || !values.some((row) => row.providerScopeType === "account")) continue;
    throw publicationError(
      "CANONICAL_PUBLICATION_TARGET_SCOPE_AMBIGUOUS",
      "An account-scoped publication target overlaps another live target for the same destination and variant.",
      context,
      {
        productId,
        channelId: values[0]!.channelId,
        destinationKind: values[0]!.destinationKind,
        channelConnectionId: values[0]!.channelConnectionId,
        dropshipStoreConnectionId: values[0]!.dropshipStoreConnectionId,
        productVariantId: values[0]!.productVariantId,
        publicationTargetIds: values.map((row) => row.publicationTargetId).sort((a, b) => a - b),
      },
    );
  }
}

function canonicalActivationRunId(context: InventoryAvailabilityRuntimePublicationContext): string {
  if (context.authority !== "canonical" || context.activationRunId === null
    || !/^[1-9]\d*$/.test(context.activationRunId)) {
    throw publicationError(
      "CANONICAL_PUBLICATION_AUTHORITY_INVALID",
      "Canonical publication requires an active activation lineage.",
      context,
      {},
    );
  }
  return context.activationRunId;
}

function publicationError(
  code: string,
  message: string,
  context: Pick<InventoryAvailabilityRuntimePublicationContext, "authority" | "authorityRevision" | "activationRunId">,
  details: Readonly<Record<string, unknown>>,
): InventoryAvailabilityRuntimePublicationError {
  return new InventoryAvailabilityRuntimePublicationError(code, message, {
    ...details,
    authority: context.authority,
    authorityRevision: context.authorityRevision,
    activationRunId: context.activationRunId,
  });
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw new InventoryAvailabilityRuntimePublicationError(
      "INVALID_INVENTORY_PUBLICATION_IDENTIFIER",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return parsed;
}

function uniquePositiveIntegers(values: readonly number[], field: string): number[] {
  if (!Array.isArray(values)) {
    throw new InventoryAvailabilityRuntimePublicationError(
      "INVALID_INVENTORY_PUBLICATION_IDENTIFIERS",
      `${field} must be an array of positive PostgreSQL integers.`,
      { field },
    );
  }
  return [...new Set(values.map((value) => positiveInteger(value, field)))].sort((a, b) => a - b);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new InventoryAvailabilityRuntimePublicationError(
      "INVALID_INVENTORY_PUBLICATION_INPUT",
      `${field} must be a boolean.`,
      { field, value },
    );
  }
  return value;
}

function nonblank(value: unknown, field: string, maximumLength: number): string {
  const parsed = typeof value === "string" ? value.trim() : "";
  if (parsed.length === 0 || parsed.length > maximumLength) {
    throw new InventoryAvailabilityRuntimePublicationError(
      "INVALID_INVENTORY_PUBLICATION_INPUT",
      `${field} must contain between 1 and ${maximumLength} characters.`,
      { field },
    );
  }
  return parsed;
}
