import { z } from "zod";

import type { CanonicalJsonValue } from "../domain/canonical-hash";
import {
  MARKETPLACE_PROVIDER_IDENTITY_SCHEME,
  type ListingRegistrationOwnerSnapshot,
  type MarketplaceObservedListingPublication,
} from "../domain/listing-registration-plan";
import { listingActorSchema, listingOwnerRefSchema } from "./dtos";

const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const positivePostgresIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647);
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/);
const providerSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/);
const trimmedText = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength);
const nullableTrimmedText = (maxLength: number) =>
  trimmedText(maxLength).nullable();

export const listingRegistrationLocatorSchema = z
  .object({
    providerPublicationKey: nullableTrimmedText(255),
    externalListingId: nullableTrimmedText(255),
  })
  .strict()
  .refine(
    (locator) =>
      locator.providerPublicationKey !== null ||
      locator.externalListingId !== null,
    "A provider publication key or external listing ID is required.",
  );

const listingRegistrationBaseInputShape = {
  owner: listingOwnerRefSchema,
  locator: listingRegistrationLocatorSchema,
  idempotencyKey: trimmedText(200),
  requestedBy: listingActorSchema,
  correlationId: nullableTrimmedText(100).optional(),
} as const;

export const previewListingRegistrationInputSchema = z
  .object(listingRegistrationBaseInputShape)
  .strict();

export const confirmListingRegistrationInputSchema = z
  .object({
    ...listingRegistrationBaseInputShape,
    expectedObservationHash: sha256Schema,
  })
  .strict();

export const listingRegistrationOwnerSnapshotSchema: z.ZodType<ListingRegistrationOwnerSnapshot> =
  z
    .object({
      owner: listingOwnerRefSchema,
      memberCandidates: z
        .array(
          z
            .object({
              productVariantId: positivePostgresIntegerSchema,
              sku: trimmedText(100),
              isActive: z.boolean(),
              availableQuantity: z
                .number()
                .int()
                .min(Number.MIN_SAFE_INTEGER)
                .max(Number.MAX_SAFE_INTEGER),
            })
            .strict(),
        )
        .min(1)
        .max(10_000),
    })
    .strict();

const observedIdentitySchema = z
  .object({
    externalId: trimmedText(255),
    identityNamespace: trimmedText(160),
  })
  .strict();

function isCanonicalJsonValue(value: unknown): value is CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(isCanonicalJsonValue);
  if (typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.values(value).every(isCanonicalJsonValue)
  );
}

const evidenceSchema = z.custom<Readonly<Record<string, CanonicalJsonValue>>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    isCanonicalJsonValue(value),
  "Provider evidence must be a canonical JSON object.",
);

export const marketplaceObservedListingPublicationSchema: z.ZodType<MarketplaceObservedListingPublication> =
  z
    .object({
      providerAccount: z
        .object({
          provider: providerSchema,
          accountNamespace: trimmedText(100),
          externalAccountId: trimmedText(255),
          identityScheme: z.literal(MARKETPLACE_PROVIDER_IDENTITY_SCHEME),
          externalDisplayNameSnapshot: nullableTrimmedText(255),
          evidenceHash: sha256Schema,
        })
        .strict(),
      marketplaceId: trimmedText(100),
      publicationKeyIdentity: observedIdentitySchema.nullable(),
      listingIdentity: observedIdentitySchema,
      externalUrl: nullableTrimmedText(2_000),
      isPublished: z.boolean(),
      members: z
        .array(
          z
            .object({
              sku: trimmedText(100),
              variantIdentity: observedIdentitySchema.nullable(),
              offerIdentity: observedIdentitySchema.nullable(),
              inventoryItemIdentity: observedIdentitySchema.nullable(),
            })
            .strict(),
        )
        .max(10_000),
      evidence: evidenceSchema,
      observedAt: z.date(),
    })
    .strict();

export const listingRegistrationReceiptSchema = z
  .object({
    registrationId: positiveSafeIntegerSchema,
    scopeId: positiveSafeIntegerSchema,
    providerAccountId: positiveSafeIntegerSchema,
    publicationId: positiveSafeIntegerSchema,
    idempotencyKey: trimmedText(200),
    requestHash: sha256Schema,
    observationHash: sha256Schema,
    desiredStateHash: sha256Schema,
    observedAt: z.date(),
    registeredAt: z.date(),
  })
  .strict()
  .refine(
    (receipt) => receipt.registeredAt.getTime() >= receipt.observedAt.getTime(),
    "Registration cannot precede the provider observation.",
  );

export const listingRegistrationStatusSchema = z
  .object({
    status: z.literal("registered"),
    productId: positivePostgresIntegerSchema,
    registrationId: positiveSafeIntegerSchema,
    scopeId: positiveSafeIntegerSchema,
    providerAccountId: positiveSafeIntegerSchema,
    publicationId: positiveSafeIntegerSchema,
    providerPublicationKey: nullableTrimmedText(255),
    externalListingId: trimmedText(255),
    registeredAt: z.date(),
  })
  .strict();

export const listingRegistrationResultSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("created"),
      receipt: listingRegistrationReceiptSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("replay"),
      receipt: listingRegistrationReceiptSchema,
    })
    .strict(),
]);

export const providerAccountClaimResultSchema = z
  .object({
    kind: z.enum(["claimed", "replay"]),
    owner: listingOwnerRefSchema,
    provider: providerSchema,
    accountNamespace: trimmedText(100),
    externalAccountId: trimmedText(255),
    identityScheme: z.literal(MARKETPLACE_PROVIDER_IDENTITY_SCHEME),
    verifiedAt: z.date(),
  })
  .strict();

export type PreviewListingRegistrationInput = z.infer<
  typeof previewListingRegistrationInputSchema
>;
export type ConfirmListingRegistrationInput = z.infer<
  typeof confirmListingRegistrationInputSchema
>;
export type ListingRegistrationReceipt = z.infer<
  typeof listingRegistrationReceiptSchema
>;
export type ListingRegistrationResult = z.infer<
  typeof listingRegistrationResultSchema
>;
export type ListingRegistrationStatus = z.infer<
  typeof listingRegistrationStatusSchema
>;
export type ProviderAccountClaimResult = z.infer<
  typeof providerAccountClaimResultSchema
>;
