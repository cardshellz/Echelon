import { z } from "zod";

const id = z.number().int().positive().max(2_147_483_647);
const externalId = z.string().min(1).max(255);

/** A retained remote identity, independent of an active ATP mapping or sync job. */
export const listingMemberIdentitySchema = z.object({
  destinationKind: z.enum(["channel_connection", "dropship_store_connection"]),
  connectionId: id,
  channelId: id.nullable(),
  vendorId: id.nullable(),
  provider: z.string().min(1).max(30),
  accountId: externalId.nullable(),
  environment: z.enum(["production", "sandbox"]),
  market: externalId,
  productId: id,
  productVariantId: id,
  externalSku: externalId.nullable(),
  externalProductId: externalId.nullable(),
  externalVariantId: externalId.nullable(),
  externalInventoryItemId: externalId.nullable(),
  identityConflict: z.boolean(),
}).strict();
export type ListingMemberIdentity = z.infer<typeof listingMemberIdentitySchema>;

export const listingMemberRetirementSchema = z.object({
  operationId: z.string().uuid(),
  identity: listingMemberIdentitySchema,
  sourceRevision: z.string().min(1),
  state: z.enum(["pending", "retiring", "retired", "failed", "superseded"]),
  code: z.string().nullable(),
  message: z.string().nullable(),
  verifiedAt: z.string().datetime().nullable(),
}).strict();
export type ListingMemberRetirement = z.infer<typeof listingMemberRetirementSchema>;

/** Completion may have no live listing ID: an exact unpublished offer is valid
 * evidence. Never manufacture an ID just to satisfy inventory's old contract. */
export const listingRetirementEvidenceSchema = z.object({
  operationId: z.string().uuid(),
  externalAccountId: externalId,
  externalSku: externalId,
  externalOfferId: externalId.nullable(),
  externalListingId: externalId.nullable(),
  externalInventoryItemId: externalId.nullable().optional(),
}).strict();
