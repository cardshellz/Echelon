import { z } from "zod";
import {
  LISTING_END_OPS_DEFAULT_LIMIT,
  LISTING_END_OPS_DEFAULT_STATE,
  LISTING_END_OPS_MAX_LIMIT,
  LISTING_END_OPS_MAX_PAGE,
  LISTING_END_REQUEST_STATES,
  listingEndResolveRequestSchema,
  listingEndRetryRequestSchema,
} from "../../../../shared/dropship/listing-end-ops";

/**
 * The staff surface's service inputs (PR C, PLAN-C v4.1 §10). The routes pass what they read (query values, the body's
 * fields, the key from the body or the header, the session's actor) and the service parses it here; the wire bodies
 * are the shared contract's (shared/dropship/listing-end-ops.ts).
 */

const positiveId = z.number().int().positive().max(2_147_483_647);
/** End request ids are bigint identities, read as safe integers (dropship-listing-end.repository.ts). */
const endRequestId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const listListingEndsInputSchema = z.object({
  state: z.enum(LISTING_END_REQUEST_STATES).default(LISTING_END_OPS_DEFAULT_STATE),
  vendorId: positiveId.optional(),
  storeConnectionId: positiveId.optional(),
  page: z.number().int().positive().max(LISTING_END_OPS_MAX_PAGE).default(1),
  limit: z.number().int().positive().max(LISTING_END_OPS_MAX_LIMIT).default(LISTING_END_OPS_DEFAULT_LIMIT),
}).strict();

/** Staff are admins with a session user; the audit row names them (CLAUDE.md §10: who). */
export const listingEndOpsActorSchema = z.object({
  actorType: z.literal("admin"),
  actorId: z.string().trim().min(1).max(255),
}).strict();

export const retryListingEndInputSchema = listingEndRetryRequestSchema.extend({
  endRequestId,
  actor: listingEndOpsActorSchema,
}).strict();

export const resolveListingEndInputSchema = listingEndResolveRequestSchema.extend({
  endRequestId,
  actor: listingEndOpsActorSchema,
}).strict();

export type ListListingEndsInput = z.infer<typeof listListingEndsInputSchema>;
export type ListingEndOpsActor = z.infer<typeof listingEndOpsActorSchema>;
export type RetryListingEndInput = z.infer<typeof retryListingEndInputSchema>;
export type ResolveListingEndInput = z.infer<typeof resolveListingEndInputSchema>;
