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

export interface InventoryAvailabilityRuntimePublicationContext {
  authority: InventoryAvailabilityRuntimeAuthority;
  authorityRevision: string;
  activationRunId: string | null;
  listActivePublicationProductIds(channelId?: number): Promise<number[]>;
  planProduct(productId: number, channelId?: number): Promise<InventoryChannelExposureRuntimePlan>;
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
}

export type InventoryPublicationRouteResult<T> =
  | { authority: "legacy"; legacyResult: T }
  | { authority: "canonical"; publication: CanonicalInventoryPublicationResult };

export interface InventoryAvailabilityRuntimePublicationLogger {
  info(event: Readonly<Record<string, unknown>>): void;
  warn(event: Readonly<Record<string, unknown>>): void;
}

const defaultLogger: InventoryAvailabilityRuntimePublicationLogger = {
  info(event) {
    console.info(JSON.stringify(event));
  },
  warn(event) {
    console.warn(JSON.stringify(event));
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

  async listProductIds(legacyReader: () => Promise<number[]>): Promise<number[]> {
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") return uniquePositiveIntegers(await legacyReader(), "productId");
      return uniquePositiveIntegers(
        await context.listActivePublicationProductIds(this.channelId),
        "productId",
      );
    });
  }

  async publishProduct<T>(input: {
    productId: number;
    dryRun: boolean;
    triggeredBy?: string;
  }, legacyPublisher: () => Promise<T>): Promise<InventoryPublicationRouteResult<T>> {
    const productId = positiveInteger(input.productId, "productId");
    const dryRun = boolean(input.dryRun, "dryRun");
    const triggeredBy = nonblank(input.triggeredBy ?? "inventory_publication", "triggeredBy", 200);
    return this.executor.execute(async (context) => {
      if (context.authority === "legacy") {
        return { authority: "legacy", legacyResult: await legacyPublisher() };
      }
      const publication = await this.planAndPublishCanonical(context, {
        productId,
        dryRun,
        triggeredBy,
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
      dryRun: boolean;
      triggeredBy: string;
    },
  ): Promise<CanonicalInventoryPublicationResult> {
    const activationRunId = canonicalActivationRunId(context);
    const plan = await context.planProduct(
      input.productId,
      input.channelId ?? this.channelId,
    );
    const rows = publicationIntentsFromPlan(plan, context, input.productVariantId);
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
    };
    this.logger.info({
      event: "canonical_inventory_publication_routed",
      productId: input.productId,
      productVariantId: input.productVariantId ?? null,
      channelId: input.channelId ?? this.channelId ?? null,
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
    const targets = await context.loadActivePublicationTargets({
      productId: input.productId,
      productVariantIds: [input.productVariantId],
      channelId: input.channelId,
    });
    const rows = targets.map((target) => {
      const mapping = target.mappings.find((candidate) =>
        candidate.productVariantId === input.productVariantId);
      if (!mapping) {
        throw publicationError(
          "CANONICAL_PUBLICATION_MAPPING_MISSING",
          "A live Echelon publication target has no active provider identity for the inactive variant.",
          context,
          {
            productId: input.productId,
            productVariantId: input.productVariantId,
            publicationTargetId: target.publicationTargetId,
          },
        );
      }
      return intent(target, mapping, input.productVariantId, null, "0", []);
    });
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

function publicationIntentsFromPlan(
  plan: InventoryChannelExposureRuntimePlan,
  context: InventoryAvailabilityRuntimePublicationContext,
  productVariantId?: number,
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
    if (!target.publishable || !target.sourceBinding) {
      const blockerCodes = uniqueStrings([
        ...target.blockers.map((blocker) => blocker.code),
        ...target.rows.flatMap((row) => row.blockers.map((blocker) => blocker.code)),
      ]);
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
      if (!row.policy?.eligible) continue;
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
          sourceWarehouseIds: target.sourceBinding.warehouseIds,
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
  context: InventoryAvailabilityRuntimePublicationContext,
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
