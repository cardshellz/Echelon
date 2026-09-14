import type {
  AuthorityAwareInventoryPublicationService,
  CanonicalInventoryPublicationIntent,
} from "./inventory-availability-runtime-publication.service";

export interface LegacyInventoryChannelQuantity {
  productVariantId: number;
  quantity: number;
}

export interface InventoryChannelQuantityTarget {
  destinationKind: "channel_connection" | "dropship_store_connection";
  connectionId?: number;
  providerKey?: string;
  providerScopeType?: "account" | "location";
  externalScopeId?: string;
}

export interface InventoryChannelQuantityRequest {
  productId: number;
  channelId: number;
  target: InventoryChannelQuantityTarget;
  /**
   * A channel-level read may collapse multiple destinations only when every
   * destination independently resolves to the same quantity for the SKU.
   * It never sums or otherwise combines overlapping promise capacity.
   */
  allowEquivalentDestinationRows?: boolean;
  triggeredBy: string;
}

export interface InventoryChannelQuantityRow {
  productVariantId: number;
  quantity: number;
  publicationTargetIds: readonly number[];
}

export interface InventoryChannelQuantityResult {
  authority: "legacy" | "canonical";
  productId: number;
  rows: readonly InventoryChannelQuantityRow[];
}

interface NormalizedInventoryChannelQuantityTarget {
  destinationKind: InventoryChannelQuantityTarget["destinationKind"];
  connectionId?: number;
  providerKey?: string;
  providerScopeType?: NonNullable<InventoryChannelQuantityTarget["providerScopeType"]>;
  externalScopeId?: string;
}

type PublicationRouter = Pick<AuthorityAwareInventoryPublicationService, "publishProduct">;

export class InventoryChannelQuantityRuntimeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly context: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryChannelQuantityRuntimeError";
  }
}

/**
 * One read-only authority boundary for quantities displayed or embedded by a
 * channel listing flow. Legacy authority executes the caller's deployed
 * calculation under the publication authority lock. Canonical authority uses
 * the exact same target-aware exposure rows that feed the publication outbox.
 */
export class InventoryChannelQuantityRuntimeService {
  constructor(
    private readonly publicationForChannel: (channelId: number) => PublicationRouter,
  ) {}

  async readProduct(
    request: InventoryChannelQuantityRequest,
    legacyReader: () => Promise<readonly LegacyInventoryChannelQuantity[]>,
  ): Promise<InventoryChannelQuantityResult> {
    const productId = positiveInteger(request.productId, "productId");
    const channelId = positiveInteger(request.channelId, "channelId");
    const target = normalizeTarget(request.target);
    const triggeredBy = nonblank(request.triggeredBy, "triggeredBy", 200);
    const routed = await this.publicationForChannel(channelId).publishProduct(
      { productId, dryRun: true, triggeredBy },
      legacyReader,
    );

    if (routed.authority === "legacy") {
      return {
        authority: "legacy",
        productId,
        rows: normalizeLegacyRows(routed.legacyResult, productId),
      };
    }

    if (routed.publication.productId !== productId || routed.publication.dryRun !== true) {
      throw runtimeError(
        "CANONICAL_CHANNEL_QUANTITY_PUBLICATION_MISMATCH",
        "The canonical publication preview does not match the requested product or read-only mode.",
        {
          requestedProductId: productId,
          publicationProductId: routed.publication.productId,
          publicationDryRun: routed.publication.dryRun,
        },
      );
    }

    const rows = routed.publication.rows.filter((row) =>
      row.channelId === channelId && targetMatches(row, target));
    return {
      authority: "canonical",
      productId,
      rows: normalizeCanonicalRows(
        rows,
        productId,
        channelId,
        target,
        request.allowEquivalentDestinationRows === true,
      ),
    };
  }
}

function normalizeLegacyRows(
  rows: readonly LegacyInventoryChannelQuantity[],
  productId: number,
): InventoryChannelQuantityRow[] {
  const result = new Map<number, InventoryChannelQuantityRow>();
  for (const row of rows) {
    const productVariantId = positiveInteger(row.productVariantId, "productVariantId");
    if (result.has(productVariantId)) {
      throw runtimeError(
        "LEGACY_CHANNEL_QUANTITY_VARIANT_DUPLICATE",
        "The legacy channel quantity reader returned a duplicate SKU.",
        { productId, productVariantId },
      );
    }
    result.set(productVariantId, {
      productVariantId,
      quantity: nonnegativeSafeInteger(row.quantity, "quantity"),
      publicationTargetIds: [],
    });
  }
  return [...result.values()].sort((left, right) => left.productVariantId - right.productVariantId);
}

function normalizeCanonicalRows(
  rows: readonly CanonicalInventoryPublicationIntent[],
  productId: number,
  channelId: number,
  target: NormalizedInventoryChannelQuantityTarget,
  allowEquivalentDestinationRows: boolean,
): InventoryChannelQuantityRow[] {
  const grouped = new Map<number, CanonicalInventoryPublicationIntent[]>();
  for (const row of rows) {
    const productVariantId = positiveInteger(row.productVariantId, "productVariantId");
    const current = grouped.get(productVariantId) ?? [];
    current.push(row);
    grouped.set(productVariantId, current);
  }

  const result: InventoryChannelQuantityRow[] = [];
  for (const [productVariantId, candidates] of grouped) {
    const publicationTargetIds = candidates
      .map((candidate) => positiveInteger(candidate.publicationTargetId, "publicationTargetId"))
      .sort((left, right) => left - right);
    if (new Set(publicationTargetIds).size !== publicationTargetIds.length) {
      throw runtimeError(
        "CANONICAL_CHANNEL_QUANTITY_TARGET_DUPLICATE",
        "The canonical publication preview returned a duplicate destination for one SKU.",
        { productId, channelId, productVariantId, publicationTargetIds },
      );
    }
    const quantities = candidates.map((candidate) =>
      nonnegativeSafeIntegerString(candidate.desiredQuantity, "desiredQuantity"));
    const uniqueQuantities = [...new Set(quantities)];
    if (candidates.length > 1 && (!allowEquivalentDestinationRows || uniqueQuantities.length !== 1)) {
      throw runtimeError(
        "CANONICAL_CHANNEL_QUANTITY_TARGET_AMBIGUOUS",
        "More than one canonical publication destination resolves this SKU; select one exact destination.",
        {
          productId,
          channelId,
          productVariantId,
          destinationKind: target.destinationKind,
          connectionId: target.connectionId ?? null,
          publicationTargetIds,
          desiredQuantities: uniqueQuantities,
        },
      );
    }
    result.push({
      productVariantId,
      quantity: quantities[0]!,
      publicationTargetIds,
    });
  }
  return result.sort((left, right) => left.productVariantId - right.productVariantId);
}

function targetMatches(
  row: CanonicalInventoryPublicationIntent,
  target: NormalizedInventoryChannelQuantityTarget,
): boolean {
  if (row.destinationKind !== target.destinationKind) return false;
  const connectionId = row.destinationKind === "channel_connection"
    ? row.channelConnectionId
    : row.dropshipStoreConnectionId;
  if (target.connectionId != null && connectionId !== target.connectionId) return false;
  if (target.providerKey != null && row.providerKey.toLowerCase() !== target.providerKey) return false;
  if (target.providerScopeType != null && row.providerScopeType !== target.providerScopeType) return false;
  if (target.externalScopeId != null && row.externalScopeId !== target.externalScopeId) return false;
  return true;
}

function normalizeTarget(
  target: InventoryChannelQuantityTarget,
): NormalizedInventoryChannelQuantityTarget {
  if (target.destinationKind !== "channel_connection"
    && target.destinationKind !== "dropship_store_connection") {
    throw runtimeError(
      "CHANNEL_QUANTITY_DESTINATION_KIND_INVALID",
      "The channel quantity destination kind is invalid.",
      { destinationKind: target.destinationKind },
    );
  }
  if (target.providerScopeType != null
    && target.providerScopeType !== "account"
    && target.providerScopeType !== "location") {
    throw runtimeError(
      "CHANNEL_QUANTITY_PROVIDER_SCOPE_TYPE_INVALID",
      "The channel quantity provider scope type is invalid.",
      { providerScopeType: target.providerScopeType },
    );
  }
  return {
    destinationKind: target.destinationKind,
    ...(target.connectionId == null
      ? {}
      : { connectionId: positiveInteger(target.connectionId, "connectionId") }),
    ...(target.providerKey == null
      ? {}
      : { providerKey: nonblank(target.providerKey, "providerKey", 60).toLowerCase() }),
    ...(target.providerScopeType == null
      ? {}
      : { providerScopeType: target.providerScopeType }),
    ...(target.externalScopeId == null
      ? {}
      : { externalScopeId: nonblank(target.externalScopeId, "externalScopeId", 255) }),
  };
}

function positiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2_147_483_647) {
    throw runtimeError(
      "CHANNEL_QUANTITY_IDENTIFIER_INVALID",
      `${field} must be a positive PostgreSQL integer.`,
      { field, value },
    );
  }
  return parsed;
}

function nonnegativeSafeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw runtimeError(
      "CHANNEL_QUANTITY_VALUE_INVALID",
      `${field} must be a nonnegative safe integer.`,
      { field, value },
    );
  }
  return parsed;
}

function nonnegativeSafeIntegerString(value: unknown, field: string): number {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) {
    throw runtimeError(
      "CHANNEL_QUANTITY_VALUE_INVALID",
      `${field} must be a nonnegative integer string.`,
      { field, value },
    );
  }
  return nonnegativeSafeInteger(Number(value), field);
}

function nonblank(value: unknown, field: string, maximumLength: number): string {
  const parsed = typeof value === "string" ? value.trim() : "";
  if (parsed.length === 0 || parsed.length > maximumLength) {
    throw runtimeError(
      "CHANNEL_QUANTITY_TEXT_INVALID",
      `${field} must contain between 1 and ${maximumLength} characters.`,
      { field },
    );
  }
  return parsed;
}

function runtimeError(
  code: string,
  message: string,
  context: Readonly<Record<string, unknown>>,
): InventoryChannelQuantityRuntimeError {
  return new InventoryChannelQuantityRuntimeError(code, message, context);
}
