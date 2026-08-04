import { z } from "zod";

import {
  LISTING_ACTOR_TYPES,
  LISTING_MEMBER_DISPOSITIONS,
  type ListingActor,
  type ListingOwnerRef,
  type ListingOwnerSnapshot,
  type RequestedListingMember,
} from "../domain/listing-replacement-plan";
import {
  LISTING_REPLACEMENT_OPERATION_STATUSES,
  LISTING_REPLACEMENT_PHASES,
  type ListingReplacementOperationStatus,
  type ListingReplacementPhase,
} from "../domain/lifecycle";

const OPERATION_PHASES_BY_STATUS: Readonly<
  Record<ListingReplacementOperationStatus, readonly ListingReplacementPhase[]>
> = {
  planned: ["preflight"],
  running: ["preflight", "cutover", "publish", "verify", "switch_mapping"],
  compensating: ["compensate"],
  completed: ["complete"],
  failed: ["preflight", "compensate"],
  manual_recovery_required: [
    "preflight",
    "cutover",
    "publish",
    "verify",
    "switch_mapping",
    "compensate",
  ],
  cancelled: ["preflight"],
};

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const POSTGRES_INTEGER_MAX = 2_147_483_647;
const positivePostgresIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(POSTGRES_INTEGER_MAX);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const providerSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/);
const marketplaceIdSchema = z.string().trim().min(1).max(100);
const actorIdSchema = z.string().trim().min(1).max(255);
const reasonCodeSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_.:-]{0,99}$/);

export const listingActorSchema: z.ZodType<ListingActor> = z
  .object({
    type: z.enum(LISTING_ACTOR_TYPES),
    id: actorIdSchema,
  })
  .strict();

const channelListingOwnerRefSchema = z
  .object({
    kind: z.literal("channel"),
    channelId: positivePostgresIntegerSchema,
    productId: positivePostgresIntegerSchema,
    provider: providerSchema,
    marketplaceId: marketplaceIdSchema,
  })
  .strict();

const dropshipListingOwnerRefSchema = z
  .object({
    kind: z.literal("dropship"),
    storeConnectionId: positivePostgresIntegerSchema,
    productId: positivePostgresIntegerSchema,
    provider: providerSchema,
    marketplaceId: marketplaceIdSchema,
  })
  .strict();

export const listingOwnerRefSchema: z.ZodType<ListingOwnerRef> =
  z.discriminatedUnion("kind", [
    channelListingOwnerRefSchema,
    dropshipListingOwnerRefSchema,
  ]);

export const requestedListingMemberSchema: z.ZodType<RequestedListingMember> = z
  .object({
    productVariantId: positivePostgresIntegerSchema,
    disposition: z.enum(LISTING_MEMBER_DISPOSITIONS),
    reasonCode: reasonCodeSchema.nullable(),
  })
  .strict()
  .superRefine((member, context) => {
    if (member.disposition === "included" && member.reasonCode !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCode"],
        message: "Included listing members cannot have an exclusion reason.",
      });
    }
    if (member.disposition === "excluded" && member.reasonCode === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reasonCode"],
        message: "Excluded listing members require a reason code.",
      });
    }
  });

export const planListingReplacementInputSchema = z
  .object({
    owner: listingOwnerRefSchema,
    targetMembers: z.array(requestedListingMemberSchema).min(1).max(10_000),
    idempotencyKey: z.string().trim().min(1).max(200),
    requestedBy: listingActorSchema,
    correlationId: z.string().trim().min(1).max(100).nullable().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const seen = new Set<number>();
    input.targetMembers.forEach((member, index) => {
      if (seen.has(member.productVariantId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["targetMembers", index, "productVariantId"],
          message: "Each product variant may appear only once.",
        });
      }
      seen.add(member.productVariantId);
    });
    if (
      !input.targetMembers.some((member) => member.disposition === "included")
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetMembers"],
        message: "At least one product variant must be included.",
      });
    }
  });

const sourcePublicationSnapshotSchema = z
  .object({
    publicationId: positiveSafeIntegerSchema,
    generation: positivePostgresIntegerSchema,
    status: z.literal("active"),
    desiredStateHash: sha256Schema,
    providerPublicationKey: z.string().trim().min(1).max(255).nullable(),
    externalListingId: z.string().trim().min(1).max(255),
  })
  .strict();

const listingMemberCandidateSchema = z
  .object({
    productVariantId: positivePostgresIntegerSchema,
    sku: z.string().trim().min(1).max(100),
    currentlyPublished: z.boolean(),
  })
  .strict();

export const listingOwnerSnapshotSchema: z.ZodType<ListingOwnerSnapshot> = z
  .object({
    owner: listingOwnerRefSchema,
    scopeId: positiveSafeIntegerSchema,
    sourcePublication: sourcePublicationSnapshotSchema,
    nextGeneration: positivePostgresIntegerSchema,
    memberCandidates: z.array(listingMemberCandidateSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const seen = new Set<number>();
    const firstIndexBySku = new Map<string, number>();
    snapshot.memberCandidates.forEach((member, index) => {
      if (seen.has(member.productVariantId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["memberCandidates", index, "productVariantId"],
          message: "Owner snapshot contains a duplicate product variant.",
        });
      }
      seen.add(member.productVariantId);

      const firstIndex = firstIndexBySku.get(member.sku);
      if (firstIndex !== undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["memberCandidates", index, "sku"],
          message: `SKU snapshot duplicates memberCandidates.${firstIndex}.sku after normalization.`,
        });
      } else {
        firstIndexBySku.set(member.sku, index);
      }
    });
    if (snapshot.nextGeneration <= snapshot.sourcePublication.generation) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["nextGeneration"],
        message: "Next generation must be after the active source generation.",
      });
    }
    if (
      !snapshot.memberCandidates.some((member) => member.currentlyPublished)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["memberCandidates"],
        message:
          "Active source publication must contain at least one currently published member.",
      });
    }
  });

export const listingReplacementOperationSchema = z
  .object({
    operationId: positiveSafeIntegerSchema,
    scopeId: positiveSafeIntegerSchema,
    sourcePublicationId: positiveSafeIntegerSchema,
    targetPublicationId: positiveSafeIntegerSchema,
    idempotencyKey: z.string().min(1).max(200),
    requestHash: sha256Schema,
    desiredStateHash: sha256Schema,
    status: z.enum(LISTING_REPLACEMENT_OPERATION_STATUSES),
    currentPhase: z.enum(LISTING_REPLACEMENT_PHASES),
    stateVersion: positiveSafeIntegerSchema,
    createdAt: z.date(),
    updatedAt: z.date(),
  })
  .strict()
  .superRefine((operation, context) => {
    if (
      !OPERATION_PHASES_BY_STATUS[operation.status].includes(
        operation.currentPhase,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["currentPhase"],
        message: `Operation phase ${operation.currentPhase} is invalid for status ${operation.status}.`,
      });
    }
    if (operation.updatedAt.getTime() < operation.createdAt.getTime()) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["updatedAt"],
        message:
          "Operation updated timestamp cannot be before its creation timestamp.",
      });
    }
  });

export const createOrReplayListingReplacementResultSchema =
  z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("created"),
        operation: listingReplacementOperationSchema,
      })
      .strict(),
    z
      .object({
        kind: z.literal("replay"),
        operation: listingReplacementOperationSchema,
      })
      .strict(),
  ]);

export const listingReplacementLeaseTokenSchema = z.string().uuid();

export type PlanListingReplacementInput = z.infer<
  typeof planListingReplacementInputSchema
>;
export type ListingReplacementOperation = z.infer<
  typeof listingReplacementOperationSchema
>;
export type CreateOrReplayListingReplacementResult = z.infer<
  typeof createOrReplayListingReplacementResultSchema
>;
