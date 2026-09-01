import { z } from "zod";

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
  changeReason: nonblank(1000),
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
  changeReason: nonblank(1000),
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
    }).strict()),
  }).strict()),
  publicationTargets: z.array(z.object({
    id: positiveInteger,
    channelId: positiveInteger,
    channelConnectionId: positiveInteger,
    legacyFulfillmentNodeId: positiveInteger,
    providerScopeType: z.enum(["account", "location"]),
    externalScopeId: nonblank(240),
    publicationAuthority: z.enum(["echelon", "external_provider", "manual"]),
    state: z.enum(["disabled", "preview", "live"]),
  }).strict()),
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
  runtimeAuthority: z.literal("legacy_channel_allocation_rules"),
  providerWriteEnabled: z.literal(false),
}).strict();

export const saveChannelExposurePolicyDraftRequestSchema = z.object({
  scope: channelExposurePolicyScopeSchema,
  value: channelExposurePolicyValueSchema,
  expectedHeadRevision: postgresBigintString,
  expectedDraftPolicyId: positiveInteger.nullable(),
  expectedDraftDefinitionHash: sha256Hex.nullable(),
  changeReason: nonblank(1000),
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
  changeReason: nonblank(1000),
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

export const channelExposureDraftSaveResultSchema = z.object({
  definitionId: positiveInteger,
  version: positiveInteger,
  definitionHash: sha256Hex,
  headRevision: postgresBigintString,
  alreadyApplied: z.boolean(),
  runtimeAuthorityChanged: z.literal(false),
  providerWriteAttempted: z.literal(false),
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
  channelId: positiveInteger,
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
    policy: resolvedChannelExposurePolicySchema.nullable(),
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
});

export type ChannelExposurePolicyScope = z.infer<typeof channelExposurePolicyScopeSchema>;
export type ChannelExposurePolicyValue = z.infer<typeof channelExposurePolicyValueSchema>;
export type ChannelExposurePolicyVersion = z.infer<typeof channelExposurePolicyVersionSchema>;
export type ChannelExposurePolicyHead = z.infer<typeof channelExposurePolicyHeadSchema>;
export type PublicationSourceBindingVersion = z.infer<typeof publicationSourceBindingVersionSchema>;
export type PublicationSourceBindingHead = z.infer<typeof publicationSourceBindingHeadSchema>;
export type InventoryChannelExposureAdminView = z.infer<typeof inventoryChannelExposureAdminViewSchema>;
export type SaveChannelExposurePolicyDraftRequest = z.infer<
  typeof saveChannelExposurePolicyDraftRequestSchema
>;
export type SavePublicationSourceBindingDraftRequest = z.infer<
  typeof savePublicationSourceBindingDraftRequestSchema
>;
export type ChannelExposureDraftSaveResult = z.infer<typeof channelExposureDraftSaveResultSchema>;
export type ResolvedChannelExposurePolicy = z.infer<typeof resolvedChannelExposurePolicySchema>;
export type InventoryChannelExposurePreview = z.infer<typeof inventoryChannelExposurePreviewSchema>;
