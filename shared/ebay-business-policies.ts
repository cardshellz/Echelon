import { z } from "zod";
export const EBAY_BUSINESS_POLICY_CHANNEL_ID = 67;

export const EBAY_POLICY_KINDS = ["fulfillment", "return", "payment"] as const;
export type EbayPolicyKind = (typeof EBAY_POLICY_KINDS)[number];
export const EBAY_POLICY_LABELS: Readonly<Record<EbayPolicyKind, string>> = {
  fulfillment: "Shipping",
  return: "Return",
  payment: "Payment",
};
export const EBAY_POLICY_FIELDS = {
  fulfillment: "fulfillmentPolicyId",
  return: "returnPolicyId",
  payment: "paymentPolicyId",
} as const;
const policyId = z
  .string()
  .min(1)
  .max(100)
  .refine(
    (value) => value === value.trim(),
    "Policy IDs cannot contain surrounding whitespace",
  );
// Stored values remain exact, including malformed historical strings, so users
// can see and clear them. Only a new non-null selection must satisfy policyId.
export const ebayPolicyValuesSchema = z
  .object({
    fulfillmentPolicyId: z.string().nullable(),
    returnPolicyId: z.string().nullable(),
    paymentPolicyId: z.string().nullable(),
  })
  .strict();
export type EbayPolicyValues = z.infer<typeof ebayPolicyValuesSchema>;
export const ebayAvailablePolicyValuesSchema = z
  .object({
    fulfillmentPolicyId: policyId,
    returnPolicyId: policyId,
    paymentPolicyId: policyId,
  })
  .strict();
export type EbayAvailablePolicyValues = z.infer<
  typeof ebayAvailablePolicyValuesSchema
>;
export const ebayPolicyPatchSchema = z
  .object({
    fulfillmentPolicyId: policyId.nullable().optional(),
    returnPolicyId: policyId.nullable().optional(),
    paymentPolicyId: policyId.nullable().optional(),
  })
  .strict();
export type EbayPolicyPatch = z.infer<typeof ebayPolicyPatchSchema>;
export const ebayPolicyScopeSchema = z
  .object({
    channelId: z.number().int().positive(),
    connectionId: z.number().int().positive(),
    accountId: z.string().trim().min(1),
    environment: z.enum(["production", "sandbox"]),
    marketplaceId: z
      .string()
      .trim()
      .regex(/^EBAY_[A-Z0-9_]+$/),
  })
  .strict();
export const ebayPolicyWriteSchema = ebayPolicyPatchSchema
  .extend({
    expectedPolicies: ebayPolicyValuesSchema.optional(),
    expectedScope: ebayPolicyScopeSchema.optional(),
  })
  .strict();
export type EbayPolicyScope = z.infer<typeof ebayPolicyScopeSchema>;
export interface EbayPolicyOption {
  id: string;
  name: string;
  description?: string;
  marketplaceId?: string;
  packageRequirements?: import("./catalog/shipping-package").ChannelPackageRequirements;
}
export interface EbayPolicyCatalog {
  scope: EbayPolicyScope;
  fulfillmentPolicies: readonly EbayPolicyOption[];
  returnPolicies: readonly EbayPolicyOption[];
  paymentPolicies: readonly EbayPolicyOption[];
}
export type EbayPolicyCatalogOptions = Pick<
  EbayPolicyCatalog,
  "fulfillmentPolicies" | "returnPolicies" | "paymentPolicies"
>;
export interface EbayPolicySource {
  scope: "store" | "category" | "product" | "variant";
  productId?: number;
  variantId?: number;
  productTypeSlug?: string;
}
const sourceId = z.number().int().positive().max(2147483647);
export const ebayPolicySourceSchema = z.discriminatedUnion("scope", [
  z.object({ scope: z.literal("store") }).strict(),
  z
    .object({
      scope: z.literal("category"),
      productTypeSlug: z.string().min(1).max(50),
    })
    .strict(),
  z.object({ scope: z.literal("product"), productId: sourceId }).strict(),
  z
    .object({
      scope: z.literal("variant"),
      productId: sourceId.optional(),
      variantId: sourceId,
    })
    .strict(),
]);
export interface EbayResolvedPolicy {
  id: string | null;
  source: EbayPolicySource;
}
export type EbayResolvedPolicies = Record<EbayPolicyKind, EbayResolvedPolicy>;
export const EMPTY_EBAY_POLICIES: Readonly<EbayPolicyValues> = {
  fulfillmentPolicyId: null,
  returnPolicyId: null,
  paymentPolicyId: null,
};

export class EbayBusinessPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly statusCode = 400,
    readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EbayBusinessPolicyError";
  }
}

export function getEbayPolicySelectionState(
  kind: EbayPolicyKind,
  savedId: string | null | undefined,
  catalog: EbayPolicyCatalogOptions,
): {
  status: "inherit" | "available" | "unavailable";
  id: string | null;
  name?: string;
} {
  if (savedId === null || savedId === undefined)
    return { status: "inherit", id: null };
  const option = catalog[`${kind}Policies`].find(
    (candidate) => candidate.id === savedId,
  );
  return option
    ? { status: "available", id: savedId, name: option.name }
    : { status: "unavailable", id: savedId };
}

/** Null inherits; a saved unavailable ID remains selected and must never fall back. */
export function resolveEbayPolicies(
  layers: readonly { source: EbayPolicySource; policies: EbayPolicyValues }[],
): EbayResolvedPolicies {
  const resolved: EbayResolvedPolicies = {
    fulfillment: { id: null, source: { scope: "store" } },
    return: { id: null, source: { scope: "store" } },
    payment: { id: null, source: { scope: "store" } },
  };
  for (const layer of layers)
    for (const kind of EBAY_POLICY_KINDS) {
      const id = layer.policies[EBAY_POLICY_FIELDS[kind]];
      if (id !== null) resolved[kind] = { id, source: { ...layer.source } };
    }
  return resolved;
}

export function resolvedEbayPolicyValues(
  resolved: EbayResolvedPolicies,
): EbayPolicyValues {
  return {
    fulfillmentPolicyId: resolved.fulfillment.id,
    returnPolicyId: resolved.return.id,
    paymentPolicyId: resolved.payment.id,
  };
}

export function assertEbayPolicyScope(
  expected: EbayPolicyScope,
  actual: EbayPolicyScope,
): void {
  if (
    Object.keys(expected).some(
      (key) =>
        expected[key as keyof EbayPolicyScope] !==
        actual[key as keyof EbayPolicyScope],
    )
  )
    throw new EbayBusinessPolicyError(
      "EBAY_POLICY_SCOPE_CHANGED",
      "The eBay account or marketplace changed. Refresh Connection settings before continuing.",
      409,
    );
}

export function assertResolvedEbayPolicies(
  resolved: EbayResolvedPolicies,
  catalog: EbayPolicyCatalog,
): void {
  for (const kind of EBAY_POLICY_KINDS) {
    const { id, source } = resolved[kind];
    const context = {
      policyKind: kind,
      policyId: id,
      policySource: source,
      marketplaceId: catalog.scope.marketplaceId,
    };
    if (id === null)
      throw new EbayBusinessPolicyError(
        "EBAY_POLICY_REQUIRED",
        `Choose a ${EBAY_POLICY_LABELS[kind].toLowerCase()} policy in eBay Connection settings before publishing.`,
        422,
        context,
      );
    if (getEbayPolicySelectionState(kind, id, catalog).status !== "available")
      throw new EbayBusinessPolicyError(
        "EBAY_POLICY_UNAVAILABLE",
        `The saved ${EBAY_POLICY_LABELS[kind].toLowerCase()} policy (${id}) is unavailable for this eBay account and marketplace. Choose an available policy or use the inherited policy in the ${source.scope} settings.`,
        422,
        context,
      );
  }
}

/** Catalog creation can inherit; policy changes belong to the audited channel owner. */
export function assertEbayPolicyWriteOwned(
  payload: unknown,
  options: { operation: "create" | "update" },
): void {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
  const record = payload as Record<string, unknown>;
  for (const key of [
    "ebayFulfillmentPolicyOverride",
    "ebayReturnPolicyOverride",
    "ebayPaymentPolicyOverride",
    "ebay_fulfillment_policy_override",
    "ebay_return_policy_override",
    "ebay_payment_policy_override",
  ]) {
    if (
      !Object.prototype.hasOwnProperty.call(record, key) ||
      record[key] === undefined ||
      (options.operation === "create" && record[key] === null)
    )
      continue;
    throw new EbayBusinessPolicyError(
      "EBAY_POLICY_OWNER_REQUIRED",
      "Change eBay business policies through the eBay channel policy settings so the account, policy and change history can be verified.",
    );
  }
}

export function assertEbayStorePolicyMetadataWriteOwned(
  metadata: unknown,
): void {
  if (metadata === undefined) return;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata))
    throw new EbayBusinessPolicyError(
      "EBAY_POLICY_OWNER_REQUIRED",
      "Update eBay connection fields individually. Business policies must be changed through eBay policy settings.",
    );
  const record = metadata as Record<string, unknown>;
  for (const key of [
    "fulfillmentPolicyId",
    "returnPolicyId",
    "paymentPolicyId",
    "businessPolicies",
  ])
    if (
      Object.prototype.hasOwnProperty.call(record, key) &&
      record[key] !== undefined
    )
      throw new EbayBusinessPolicyError(
        "EBAY_POLICY_OWNER_REQUIRED",
        "Change eBay business policies through eBay policy settings so account validity and change history are verified.",
      );
}
