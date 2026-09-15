import { z } from "zod";
import {
  inventoryRuntimeAuthorityRevisionSchema,
  inventoryRuntimeAuthoritySchema,
} from "./inventory-runtime-authority";

import {
  plannerNonnegativeQuantitySchema,
  plannerPositiveQuantitySchema,
} from "./inventory-availability-planner";

const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positiveInteger = z.number().int().positive().max(POSTGRES_INTEGER_MAX);
const nonnegativeInteger = z.number().int().nonnegative().max(POSTGRES_INTEGER_MAX);
const nonblank = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const postgresBigintString = z.string().regex(/^(0|[1-9]\d*)$/);

/**
 * Routine draft saves (channel rules, supply scope, SKU identities, and
 * destination registration) are audited automatically from the authenticated
 * actor, time, scope, request identity, and before/after values. A written
 * note is optional context for the audit trail, never a gate on the save.
 * Blank or whitespace-only notes normalize to null so no fabricated reason is
 * ever persisted on the operator's behalf.
 *
 * Sensitive publication commands (readiness inclusion, stop, resume, global
 * control, cutover) keep their required reasons in their own contracts.
 */
const optionalChangeNote = z.string().trim().max(1000).nullable().optional()
  .transform((value) => (value ? value : null));

export const channelExposurePolicyScopeSchema = z.discriminatedUnion("scopeType", [
  z.object({
    scopeType: z.literal("channel"),
    channelId: positiveInteger,
  }).strict(),
  z.object({
    scopeType: z.literal("product"),
    channelId: positiveInteger,
    productId: positiveInteger,
  }).strict(),
  z.object({
    scopeType: z.literal("variant"),
    channelId: positiveInteger,
    productId: positiveInteger,
    productVariantId: positiveInteger,
  }).strict(),
]);

export const channelExposurePolicyValueSchema = z.object({
  allocationSemantics: z.enum(["exposure", "partitioned"]).nullable(),
  eligible: z.boolean().nullable(),
  shareBps: z.number().int().min(0).max(10_000).nullable(),
  holdbackSellableUnits: postgresBigintString.nullable(),
  maxPublish: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("unlimited") }).strict(),
    z.object({ mode: z.literal("units"), units: postgresBigintString }).strict(),
  ]).nullable(),
  minPublishSellableUnits: postgresBigintString.nullable(),
}).strict().superRefine((value, context) => {
  if (Object.values(value).every((field) => field === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one channel-exposure field must be set at this scope.",
    });
  }
});

export const channelExposurePolicyVersionSchema = z.object({
  policyId: positiveInteger,
  version: positiveInteger,
  lifecycleStatus: z.enum(["draft", "sealed", "retired"]),
  scope: channelExposurePolicyScopeSchema,
  value: channelExposurePolicyValueSchema,
  definitionHash: sha256Hex,
  changeReason: nonblank(1000).nullable(),
  createdBy: nonblank(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const channelExposurePolicyHeadSchema = z.object({
  scopeKey: nonblank(200),
  channelId: positiveInteger,
  revision: postgresBigintString,
  activePolicy: channelExposurePolicyVersionSchema.nullable(),
  draftPolicy: channelExposurePolicyVersionSchema.nullable(),
}).strict();

export const publicationSourceBindingVersionSchema = z.object({
  bindingId: positiveInteger,
  publicationTargetId: positiveInteger,
  version: positiveInteger,
  lifecycleStatus: z.enum(["draft", "sealed", "retired"]),
  definitionHash: sha256Hex,
  fulfillmentNodeIds: z.array(positiveInteger).min(1).max(100),
  changeReason: nonblank(1000).nullable(),
  createdBy: nonblank(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict().superRefine((binding, context) => {
  if (new Set(binding.fulfillmentNodeIds).size !== binding.fulfillmentNodeIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fulfillmentNodeIds"],
      message: "A fulfillment node may appear only once in a source binding.",
    });
  }
});

export const publicationSourceBindingHeadSchema = z.object({
  publicationTargetId: positiveInteger,
  revision: postgresBigintString,
  activeBinding: publicationSourceBindingVersionSchema.nullable(),
  draftBinding: publicationSourceBindingVersionSchema.nullable(),
}).strict();

export const publicationVariantMappingVersionSchema = z.object({
  mappingId: positiveInteger,
  publicationTargetId: positiveInteger,
  productVariantId: positiveInteger,
  version: positiveInteger,
  lifecycleStatus: z.enum(["draft", "sealed", "retired"]),
  externalInventoryItemId: nonblank(240),
  externalSku: z.string().trim().min(1).max(100).nullable(),
  definitionHash: sha256Hex,
  changeReason: nonblank(1000).nullable(),
  createdBy: nonblank(100),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
}).strict();

export const publicationVariantMappingHeadSchema = z.object({
  publicationTargetId: positiveInteger,
  productVariantId: positiveInteger,
  revision: postgresBigintString,
  activeMapping: publicationVariantMappingVersionSchema.nullable(),
  draftMapping: publicationVariantMappingVersionSchema.nullable(),
}).strict();

export const inventoryPublicationTargetAdminSchema = z.object({
  id: positiveInteger,
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  channelId: positiveInteger,
  channelConnectionId: positiveInteger.nullable(),
  dropshipStoreConnectionId: positiveInteger.nullable(),
  legacyFulfillmentNodeId: positiveInteger,
  providerScopeType: z.enum(["account", "location"]),
  externalScopeId: nonblank(240),
  publicationAuthority: z.enum(["echelon", "external_provider", "manual"]),
  state: z.enum(["disabled", "preview", "live"]),
  revision: postgresBigintString,
}).strict().superRefine(validatePublicationDestination);

export const legacyPublicationMappingCandidateSchema = z.object({
  channelId: positiveInteger,
  productVariantId: positiveInteger,
  feedId: positiveInteger,
  mappingState: z.enum(["inactive", "active", "quarantined"]),
  externalInventoryItemId: z.string().trim().min(1).max(240).nullable(),
  externalSku: z.string().trim().min(1).max(100).nullable(),
}).strict();

export const inventoryChannelExposureAdminViewSchema = z.object({
  products: z.array(z.object({
    id: positiveInteger,
    sku: z.string().max(100).nullable(),
    name: z.string(),
  }).strict()),
  selectedProduct: z.object({
    id: positiveInteger,
    sku: z.string().max(100).nullable(),
    name: z.string(),
    variants: z.array(z.object({
      id: positiveInteger,
      sku: z.string().max(100).nullable(),
      name: z.string(),
      unitsPerVariant: positiveInteger,
      salesEligibility: z.enum(["sellable", "internal_only"]),
      isActive: z.boolean(),
    }).strict()),
  }).strict().nullable(),
  channels: z.array(z.object({
    id: positiveInteger,
    name: nonblank(100),
    provider: nonblank(30),
    status: nonblank(20),
    connections: z.array(z.object({
      id: positiveInteger,
      externalAccountLabel: z.string().max(255).nullable(),
      // Shopify only: the primary inventory location saved on the connection.
      // A suggestion for destination setup, never an implicit target scope.
      shopifyLocationId: z.string().trim().min(1).max(50).nullable(),
      // eBay only: the provider-verified seller account behind the OAuth
      // credential. Account-scoped destinations must name exactly this id.
      providerAccount: z.object({
        externalAccountId: nonblank(255),
        displayName: z.string().max(255).nullable(),
        verifiedAt: z.string().datetime(),
      }).strict().nullable(),
    }).strict()),
  }).strict()),
  // The single internal channel that hosts every dropship storefront
  // (migrations/0106_dropship_internal_channel_seed.sql seeds exactly one, and
  // the dropship resolver refuses to run when more than one exists). Dropship
  // stores are destinations of THAT channel only, never of a marketplace
  // channel, so setup must not offer them anywhere else. Null when the channel
  // is not configured, in which case no dropship destination can be registered.
  dropshipDestinationChannelId: positiveInteger.nullable(),
  dropshipStores: z.array(z.object({
    id: positiveInteger,
    vendorId: positiveInteger,
    // dropship.dropship_vendors.business_name is nullable, so a vendor may
    // genuinely have no trading name. The contract carries that honestly rather
    // than letting a String(null) coercion launder it into the text "null",
    // which reads as a real name to an operator. Callers label such a store
    // from its account or id instead of inventing a name for it.
    vendorName: z.string().trim().max(255).nullable(),
    platform: z.enum(["ebay", "shopify", "tiktok", "instagram", "bigcommerce"]),
    status: nonblank(30),
    externalAccountLabel: z.string().max(255).nullable(),
    // The verified provider account id when the store credential carries one
    // under the provider_user_id scheme; otherwise null (setup must not guess).
    verifiedExternalAccountId: z.string().trim().min(1).max(255).nullable(),
  }).strict()),
  // Catalog labels for every product/SKU that carries a saved rule on any
  // channel, keyed by the rule's scope key, so the exceptions list can be
  // rendered without a product being selected.
  policySubjects: z.array(z.object({
    scopeKey: nonblank(200),
    productId: positiveInteger,
    productSku: z.string().max(100).nullable(),
    productName: z.string(),
    productVariantId: positiveInteger.nullable(),
    variantSku: z.string().max(100).nullable(),
    variantName: z.string().nullable(),
    unitsPerVariant: positiveInteger.nullable(),
  }).strict()),
  publicationTargets: z.array(inventoryPublicationTargetAdminSchema),
  fulfillmentNodes: z.array(z.object({
    id: positiveInteger,
    code: nonblank(60),
    name: nonblank(200),
    nodeType: z.enum(["internal_warehouse", "third_party_logistics", "virtual"]),
    warehouseId: positiveInteger,
    warehouseCode: nonblank(20),
    lifecycleStatus: z.enum(["draft", "active", "retired"]),
  }).strict()),
  policyHeads: z.array(channelExposurePolicyHeadSchema),
  sourceBindingHeads: z.array(publicationSourceBindingHeadSchema),
  variantMappingHeads: z.array(publicationVariantMappingHeadSchema),
  legacyMappingCandidates: z.array(legacyPublicationMappingCandidateSchema),
  // Read from the inventory.availability_runtime_authority singleton at view
  // time, never asserted: after cutover the exposure dials are what publishes.
  runtimeAuthority: inventoryRuntimeAuthoritySchema,
  runtimeAuthorityRevision: inventoryRuntimeAuthorityRevisionSchema,
  providerWriteEnabled: z.literal(false),
}).strict();

/**
 * What the `inventory`-schema store alone can answer. The internal dropship
 * channel is resolved by the dropship module, so the store validates against
 * this shape and the application layer adds that field to build the full view.
 */
export const inventoryChannelExposureAdminStoreViewSchema =
  inventoryChannelExposureAdminViewSchema.omit({ dropshipDestinationChannelId: true });

export const saveChannelExposurePolicyDraftRequestSchema = z.object({
  scope: channelExposurePolicyScopeSchema,
  value: channelExposurePolicyValueSchema,
  expectedHeadRevision: postgresBigintString,
  expectedDraftPolicyId: positiveInteger.nullable(),
  expectedDraftDefinitionHash: sha256Hex.nullable(),
  changeReason: optionalChangeNote,
  idempotencyKey: nonblank(120),
}).strict().superRefine((request, context) => {
  if ((request.expectedDraftPolicyId === null) !== (request.expectedDraftDefinitionHash === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedDraftPolicyId"],
      message: "Expected draft id and definition hash must be both present or both absent.",
    });
  }
});

export const savePublicationSourceBindingDraftRequestSchema = z.object({
  publicationTargetId: positiveInteger,
  fulfillmentNodeIds: z.array(positiveInteger).min(1).max(100),
  expectedHeadRevision: postgresBigintString,
  expectedDraftBindingId: positiveInteger.nullable(),
  expectedDraftDefinitionHash: sha256Hex.nullable(),
  changeReason: optionalChangeNote,
  idempotencyKey: nonblank(120),
}).strict().superRefine((request, context) => {
  if (new Set(request.fulfillmentNodeIds).size !== request.fulfillmentNodeIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["fulfillmentNodeIds"],
      message: "A fulfillment node may appear only once.",
    });
  }
  if ((request.expectedDraftBindingId === null) !== (request.expectedDraftDefinitionHash === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedDraftBindingId"],
      message: "Expected draft id and definition hash must be both present or both absent.",
    });
  }
});

export const createInventoryPublicationTargetRequestSchema = z.object({
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"])
    .default("channel_connection"),
  channelId: positiveInteger,
  channelConnectionId: positiveInteger.nullable().default(null),
  dropshipStoreConnectionId: positiveInteger.nullable().default(null),
  legacyFulfillmentNodeId: positiveInteger,
  providerScopeType: z.enum(["account", "location"]),
  externalScopeId: nonblank(240),
  publicationAuthority: z.enum(["echelon", "external_provider", "manual"]),
  changeReason: optionalChangeNote,
  idempotencyKey: nonblank(120),
}).strict().superRefine(validatePublicationDestination);

/**
 * Provider to the scope a quantity write must name.
 *
 * Shopify has no store-level inventory write: `inventory_levels/set.json`
 * requires a location. eBay's Sell Inventory API writes against the seller
 * account. Shared so the server's destination derivation and the page's setup
 * can never disagree about which of the two a provider needs.
 */
export const PUBLICATION_PROVIDER_SCOPE_TYPES = {
  shopify: "location",
  ebay: "account",
} as const satisfies Record<string, "account" | "location">;
export type PublicationAdapterProvider = keyof typeof PUBLICATION_PROVIDER_SCOPE_TYPES;

export function publicationScopeTypeFor(
  provider: string,
): "account" | "location" | null {
  return Object.prototype.hasOwnProperty.call(PUBLICATION_PROVIDER_SCOPE_TYPES, provider)
    ? PUBLICATION_PROVIDER_SCOPE_TYPES[provider as PublicationAdapterProvider]
    : null;
}

/**
 * Register every destination a channel's existing connections already imply, in
 * one reviewed step.
 *
 * Registering destinations one at a time does not scale: a tenant with a
 * hundred dropship vendors would need a hundred passes through a dialog whose
 * only genuinely free choices are the same every time. The identity half of a
 * destination is never a choice at all — an eBay connection has exactly one
 * verified seller account, a Shopify connection already stores the location it
 * writes inventory to, and a dropship storefront is described entirely by its
 * vendor record — so the server derives it rather than asking.
 *
 * What is NOT derivable, and so is asked once here for the whole channel:
 *   - the warehouses that supply these destinations. A target's
 *     `fulfillment_node_id` is NOT NULL, part of its unique identity, and
 *     immutable by database trigger, so this cannot be chosen later or guessed.
 *   - who publishes the quantity.
 *
 * The command never derives from a caller-supplied candidate list: the server
 * re-reads the connections itself, so a tampered request cannot invent a
 * destination. Every target is created `disabled`, exactly as single
 * registration does; nothing here publishes or changes runtime authority.
 */
export const setUpChannelDestinationsRequestSchema = z.object({
  channelId: positiveInteger,
  // Ordered: the first is written to the legacy single-node shadow column, and
  // the whole set becomes the versioned source binding the planner reads.
  supplyFulfillmentNodeIds: z.array(positiveInteger).min(1).max(50)
    .refine((ids) => new Set(ids).size === ids.length, "Supply warehouses must be distinct"),
  publicationAuthority: z.enum(["echelon", "external_provider", "manual"]),
  changeReason: optionalChangeNote,
  idempotencyKey: nonblank(120),
}).strict();
export type SetUpChannelDestinationsRequest =
  z.infer<typeof setUpChannelDestinationsRequestSchema>;

/** Why a derivable-looking destination was left alone, in operator language. */
export const CHANNEL_DESTINATION_SKIP_REASONS = [
  "already_registered",
  "no_publishing_adapter",
  "no_verified_account",
  "no_shopify_location",
] as const;
export const channelDestinationSkipReasonSchema = z.enum(CHANNEL_DESTINATION_SKIP_REASONS);
export type ChannelDestinationSkipReason = z.infer<typeof channelDestinationSkipReasonSchema>;

const channelDestinationOutcomeSchema = z.object({
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  channelConnectionId: positiveInteger.nullable(),
  dropshipStoreConnectionId: positiveInteger.nullable(),
  providerScopeType: z.enum(["account", "location"]),
  externalScopeId: nonblank(240),
}).strict();

export const setUpChannelDestinationsResultSchema = z.object({
  channelId: positiveInteger,
  created: z.array(channelDestinationOutcomeSchema.extend({
    publicationTargetId: positiveInteger,
  }).strict()),
  // Reported rather than silently dropped: an operator who expected a storefront
  // to appear must be able to see exactly why it did not.
  skipped: z.array(channelDestinationOutcomeSchema.partial({
    providerScopeType: true,
    externalScopeId: true,
  }).extend({
    reason: channelDestinationSkipReasonSchema,
    label: nonblank(300),
  }).strict()),
  alreadyApplied: z.boolean(),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
  outboxEnqueued: z.literal(false),
}).strict();
export type SetUpChannelDestinationsResult =
  z.infer<typeof setUpChannelDestinationsResultSchema>;

export const setInventoryPublicationTargetPreviewStateRequestSchema = z.object({
  publicationTargetId: positiveInteger,
  expectedRevision: postgresBigintString,
  state: z.enum(["disabled", "preview"]),
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict();

export const stopInventoryPublicationTargetRequestSchema = z.object({
  publicationTargetId: positiveInteger,
  expectedRevision: postgresBigintString,
  changeReason: nonblank(1000),
  idempotencyKey: nonblank(120),
}).strict();

export const savePublicationVariantMappingDraftRequestSchema = z.object({
  publicationTargetId: positiveInteger,
  productVariantId: positiveInteger,
  externalInventoryItemId: nonblank(240),
  externalSku: z.string().trim().min(1).max(100).nullable(),
  expectedHeadRevision: postgresBigintString,
  expectedDraftMappingId: positiveInteger.nullable(),
  expectedDraftDefinitionHash: sha256Hex.nullable(),
  changeReason: optionalChangeNote,
  idempotencyKey: nonblank(120),
}).strict().superRefine((request, context) => {
  if ((request.expectedDraftMappingId === null) !== (request.expectedDraftDefinitionHash === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedDraftMappingId"],
      message: "Expected mapping draft id and definition hash must be both present or both absent.",
    });
  }
});

export const channelExposureDraftSaveResultSchema = z.object({
  definitionId: positiveInteger,
  version: positiveInteger,
  definitionHash: sha256Hex,
  headRevision: postgresBigintString,
  alreadyApplied: z.boolean(),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
}).strict();

export const inventoryPublicationTargetCommandResultSchema = z.object({
  publicationTargetId: positiveInteger,
  revision: postgresBigintString,
  state: z.enum(["disabled", "preview"]),
  alreadyApplied: z.boolean(),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
  outboxEnqueued: z.literal(false),
}).strict();

export const resolvedChannelExposurePolicySchema = z.object({
  allocationSemantics: z.enum(["exposure", "partitioned"]),
  eligible: z.boolean(),
  shareBps: z.number().int().min(0).max(10_000),
  holdbackSellableUnits: plannerNonnegativeQuantitySchema,
  maxPublishSellableUnits: plannerNonnegativeQuantitySchema.nullable(),
  minPublishSellableUnits: plannerNonnegativeQuantitySchema,
  sources: z.object({
    allocationSemantics: nonblank(200),
    eligible: nonblank(200),
    shareBps: nonblank(200),
    holdbackSellableUnits: nonblank(200),
    maxPublishSellableUnits: nonblank(200),
    minPublishSellableUnits: nonblank(200),
  }).strict(),
}).strict();

export const inventoryChannelExposurePreviewSchema = z.object({
  publicationTargetId: positiveInteger,
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  channelId: positiveInteger,
  channelConnectionId: positiveInteger.nullable(),
  dropshipStoreConnectionId: positiveInteger.nullable(),
  providerScopeType: z.enum(["account", "location"]),
  externalScopeId: nonblank(240),
  publicationAuthority: z.enum(["echelon", "external_provider", "manual"]),
  publicationTargetState: z.enum(["disabled", "preview", "live"]),
  publicationTargetRevision: postgresBigintString,
  productId: positiveInteger,
  shadowRunId: plannerPositiveQuantitySchema,
  snapshotFingerprint: sha256Hex,
  shadowCapturedAt: z.string().datetime(),
  modelId: positiveInteger.nullable(),
  modelVersion: positiveInteger.nullable(),
  modelDefinitionHash: sha256Hex.nullable(),
  sourceBindingId: positiveInteger.nullable(),
  sourceBindingVersion: positiveInteger.nullable(),
  sourceBindingDefinitionHash: sha256Hex.nullable(),
  sourceBindingAuthority: z.enum(["draft", "active", "missing"]),
  fulfillmentNodeIds: z.array(positiveInteger),
  warehouseIds: z.array(positiveInteger),
  selectedPolicies: z.array(z.object({
    scopeKey: nonblank(200),
    policyId: positiveInteger,
    version: positiveInteger,
    definitionHash: sha256Hex,
    authority: z.enum(["draft", "active"]),
  }).strict()),
  rows: z.array(z.object({
    productVariantId: positiveInteger,
    sku: z.string().max(100).nullable(),
    unitsPerVariant: positiveInteger,
    canonicalAtpUnits: plannerNonnegativeQuantitySchema,
    sharedUnits: plannerNonnegativeQuantitySchema,
    afterHoldbackUnits: plannerNonnegativeQuantitySchema,
    cappedUnits: plannerNonnegativeQuantitySchema,
    publishedUnits: plannerNonnegativeQuantitySchema,
    sourceWarehouseBreakdown: z.array(z.object({
      warehouseId: positiveInteger,
      canonicalAtpUnits: plannerNonnegativeQuantitySchema,
    }).strict()),
    policy: resolvedChannelExposurePolicySchema.nullable(),
    mapping: z.object({
      mappingId: positiveInteger,
      version: positiveInteger,
      definitionHash: sha256Hex,
      authority: z.enum(["draft", "active"]),
      externalInventoryItemId: nonblank(240),
      externalSku: z.string().trim().min(1).max(100).nullable(),
    }).strict().nullable(),
  }).strict()),
  blockers: z.array(z.object({
    code: nonblank(100),
    message: nonblank(1000),
    context: z.record(z.unknown()),
  }).strict()),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
  outboxEnqueued: z.literal(false),
}).strict().superRefine((preview, context) => {
  validatePublicationDestination(preview, context);
  const modelEvidence = [preview.modelId, preview.modelVersion, preview.modelDefinitionHash];
  if (![0, 3].includes(modelEvidence.filter((value) => value !== null).length)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["modelId"],
      message: "Transformation model evidence must be all present or all absent.",
    });
  }
  const bindingEvidence = [
    preview.sourceBindingId,
    preview.sourceBindingVersion,
    preview.sourceBindingDefinitionHash,
  ];
  const bindingCount = bindingEvidence.filter((value) => value !== null).length;
  if ((preview.sourceBindingAuthority === "missing" && bindingCount !== 0)
    || (preview.sourceBindingAuthority !== "missing" && bindingCount !== 3)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceBindingId"],
      message: "Source-binding evidence must match its selected authority.",
    });
  }
  preview.rows.forEach((row, index) => {
    const warehouseIds = row.sourceWarehouseBreakdown.map((entry) => entry.warehouseId);
    const warehouseTotal = row.sourceWarehouseBreakdown.reduce(
      (total, entry) => total + BigInt(entry.canonicalAtpUnits),
      BigInt(0),
    );
    if (new Set(warehouseIds).size !== warehouseIds.length
      || warehouseTotal !== BigInt(row.canonicalAtpUnits)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rows", index, "sourceWarehouseBreakdown"],
        message: "Warehouse ATP rows must be unique and sum to target canonical ATP.",
      });
    }
  });
});

const inventoryChannelExposureRuntimeIssueSchema = z.object({
  code: nonblank(100),
  message: nonblank(1000),
  context: z.record(z.unknown()),
}).strict();

const activeChannelExposurePolicyEvidenceSchema = z.object({
  scopeKey: nonblank(200),
  policyId: positiveInteger,
  version: positiveInteger,
  definitionHash: sha256Hex,
}).strict();

const activePublicationVariantMappingEvidenceSchema = z.object({
  mappingId: positiveInteger,
  version: positiveInteger,
  definitionHash: sha256Hex,
  externalInventoryItemId: nonblank(240),
  externalSku: z.string().trim().min(1).max(100).nullable(),
}).strict();

const inventoryChannelExposureRuntimeRowSchema = z.object({
  productVariantId: positiveInteger,
  sku: z.string().max(100).nullable(),
  unitsPerVariant: positiveInteger,
  canonicalAtpUnits: plannerNonnegativeQuantitySchema,
  sharedUnits: plannerNonnegativeQuantitySchema,
  afterHoldbackUnits: plannerNonnegativeQuantitySchema,
  cappedUnits: plannerNonnegativeQuantitySchema,
  publishedUnits: plannerNonnegativeQuantitySchema,
  sourceWarehouseBreakdown: z.array(z.object({
    warehouseId: positiveInteger,
    canonicalAtpUnits: plannerNonnegativeQuantitySchema,
  }).strict()),
  policy: resolvedChannelExposurePolicySchema.nullable(),
  mapping: activePublicationVariantMappingEvidenceSchema.nullable(),
  blockers: z.array(inventoryChannelExposureRuntimeIssueSchema),
  warnings: z.array(inventoryChannelExposureRuntimeIssueSchema),
}).strict().superRefine((row, context) => {
  const warehouseIds = row.sourceWarehouseBreakdown.map((entry) => entry.warehouseId);
  const warehouseTotal = row.sourceWarehouseBreakdown.reduce(
    (total, entry) => total + BigInt(entry.canonicalAtpUnits),
    BigInt(0),
  );
  if (new Set(warehouseIds).size !== warehouseIds.length
    || warehouseTotal !== BigInt(row.canonicalAtpUnits)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceWarehouseBreakdown"],
      message: "Runtime warehouse ATP rows must be unique and sum to exact-target canonical ATP.",
    });
  }
});

export const inventoryChannelExposureRuntimeTargetSchema = z.object({
  publicationTargetId: positiveInteger,
  publicationTargetRevision: plannerPositiveQuantitySchema,
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  channelId: positiveInteger,
  channelName: nonblank(100),
  channelProvider: nonblank(30),
  channelConnectionId: positiveInteger.nullable(),
  dropshipStoreConnectionId: positiveInteger.nullable(),
  providerScopeType: z.enum(["account", "location"]),
  externalScopeId: nonblank(240),
  publicationAuthority: z.literal("echelon"),
  publicationTargetState: z.literal("live"),
  sourceBinding: z.object({
    bindingId: positiveInteger,
    version: positiveInteger,
    definitionHash: sha256Hex,
    fulfillmentNodeIds: z.array(positiveInteger).min(1),
    warehouseIds: z.array(positiveInteger).min(1),
  }).strict().nullable(),
  selectedPolicies: z.array(activeChannelExposurePolicyEvidenceSchema),
  rows: z.array(inventoryChannelExposureRuntimeRowSchema),
  blockers: z.array(inventoryChannelExposureRuntimeIssueSchema),
  publishable: z.boolean(),
}).strict().superRefine((target, context) => {
  validatePublicationDestination(target, context);
  const actuallyPublishable = target.rows.length > 0
    && target.blockers.length === 0
    && target.rows.every((row) => row.blockers.length === 0
      && row.policy !== null
      && row.mapping !== null);
  if (target.publishable !== actuallyPublishable) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["publishable"],
      message: "Runtime target publishability must match its complete active evidence.",
    });
  }
});

/**
 * Snapshot-bound calculation output for a canonical, exact publication target.
 * This contract does not itself enqueue or send provider writes.
 */
export const inventoryChannelExposureRuntimePlanSchema = z.object({
  authority: z.enum(["legacy", "canonical"]),
  authorityRevision: plannerPositiveQuantitySchema,
  activationRunId: plannerPositiveQuantitySchema.nullable(),
  productId: positiveInteger,
  snapshotFingerprint: sha256Hex.nullable(),
  snapshotCapturedAt: z.string().datetime().nullable(),
  targets: z.array(inventoryChannelExposureRuntimeTargetSchema),
  providerWriteAttempted: z.literal(false),
  outboxEnqueued: z.literal(false),
}).strict().superRefine((plan, context) => {
  const legacyShapeValid = plan.authority !== "legacy"
    || (plan.activationRunId === null
      && plan.snapshotFingerprint === null
      && plan.snapshotCapturedAt === null
      && plan.targets.length === 0);
  const canonicalShapeValid = plan.authority !== "canonical"
    || (plan.activationRunId !== null
      && plan.snapshotFingerprint !== null
      && plan.snapshotCapturedAt !== null);
  if (!legacyShapeValid || !canonicalShapeValid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Runtime channel-exposure evidence does not match the selected ATP authority.",
    });
  }
  const targetIds = plan.targets.map((target) => target.publicationTargetId);
  if (new Set(targetIds).size !== targetIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targets"],
      message: "A runtime publication target may appear only once.",
    });
  }
});

export type ChannelExposurePolicyScope = z.infer<typeof channelExposurePolicyScopeSchema>;
export type ChannelExposurePolicyValue = z.infer<typeof channelExposurePolicyValueSchema>;
export type ChannelExposurePolicyVersion = z.infer<typeof channelExposurePolicyVersionSchema>;
export type ChannelExposurePolicyHead = z.infer<typeof channelExposurePolicyHeadSchema>;
export type PublicationSourceBindingVersion = z.infer<typeof publicationSourceBindingVersionSchema>;
export type PublicationSourceBindingHead = z.infer<typeof publicationSourceBindingHeadSchema>;
export type PublicationVariantMappingVersion = z.infer<typeof publicationVariantMappingVersionSchema>;
export type PublicationVariantMappingHead = z.infer<typeof publicationVariantMappingHeadSchema>;
export type InventoryPublicationTargetAdmin = z.infer<typeof inventoryPublicationTargetAdminSchema>;
export type StopInventoryPublicationTargetRequest = z.infer<
  typeof stopInventoryPublicationTargetRequestSchema
>;
export type LegacyPublicationMappingCandidate = z.infer<typeof legacyPublicationMappingCandidateSchema>;
export type InventoryChannelExposureAdminView = z.infer<typeof inventoryChannelExposureAdminViewSchema>;
export type SaveChannelExposurePolicyDraftRequest = z.infer<
  typeof saveChannelExposurePolicyDraftRequestSchema
>;
export type SavePublicationSourceBindingDraftRequest = z.infer<
  typeof savePublicationSourceBindingDraftRequestSchema
>;
export type CreateInventoryPublicationTargetRequest = z.infer<
  typeof createInventoryPublicationTargetRequestSchema
>;
export type SetInventoryPublicationTargetPreviewStateRequest = z.infer<
  typeof setInventoryPublicationTargetPreviewStateRequestSchema
>;
export type SavePublicationVariantMappingDraftRequest = z.infer<
  typeof savePublicationVariantMappingDraftRequestSchema
>;
export type ChannelExposureDraftSaveResult = z.infer<typeof channelExposureDraftSaveResultSchema>;
export type InventoryPublicationTargetCommandResult = z.infer<
  typeof inventoryPublicationTargetCommandResultSchema
>;
export type ResolvedChannelExposurePolicy = z.infer<typeof resolvedChannelExposurePolicySchema>;
export type InventoryChannelExposurePreview = z.infer<typeof inventoryChannelExposurePreviewSchema>;
export type InventoryChannelExposureRuntimePlan = z.infer<
  typeof inventoryChannelExposureRuntimePlanSchema
>;

function validatePublicationDestination(
  value: {
    destinationKind: "channel_connection" | "dropship_store_connection";
    channelConnectionId: number | null;
    dropshipStoreConnectionId: number | null;
  },
  context: z.RefinementCtx,
): void {
  const valid = value.destinationKind === "channel_connection"
    ? value.channelConnectionId !== null && value.dropshipStoreConnectionId === null
    : value.channelConnectionId === null && value.dropshipStoreConnectionId !== null;
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["destinationKind"],
      message: "Publication destination kind must have exactly its matching connection identifier.",
    });
  }
}
