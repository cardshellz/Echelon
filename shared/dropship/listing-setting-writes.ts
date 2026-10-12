import { z } from "zod";
import { listingPriceCentsSchema } from "./listing-price";
import { listingSettingRequestKeySchema } from "./listing-setting-values";

/**
 * Route contracts of the listing-settings writers (Listing settings design
 * 8.5; plan PR 9, section 3.1), under
 * `/api/dropship/listings/stores/:storeConnectionId/listing-settings`. Every
 * write carries a request key; a retry with the same key and body answers what
 * the first one saved, and the page re-reads its views after any save, so
 * answers carry only outcomes and ids (plan P36).
 */

const id = z.number().int().positive().max(2_147_483_647);

/**
 * Size prices one request may save: W8's rows (and, in later sub-PRs, W5's
 * size prices and W7's releases). Each is one W9 price flow, measured at about
 * 28 statements on one connection (9a's PostgreSQL suite: 5,611 for 200
 * sizes, 14,008 for 500 flows), so 200 is about 11 s at a 2 ms round trip
 * against Heroku's 30 s router limit; 500 would be about 28 s. The design said
 * 500 (8.5 W8); 200 is plan P38's reversible bound, to be raised from the
 * logged timings.
 */
export const MAX_SIZE_PRICES_PER_REQUEST = 200;

/** Codes the listing-settings writes answer that no earlier route did (plan 3.3). */
export const LISTING_SETTING_WRITE_ERROR_CODES = Object.freeze({
  invalidInput: "DROPSHIP_LISTING_SETTINGS_INVALID_INPUT",
  rateLimited: "DROPSHIP_LISTING_SETTINGS_RATE_LIMITED",
  busy: "DROPSHIP_LISTING_SETTINGS_BUSY",
  replayIncomplete: "DROPSHIP_LISTING_SETTINGS_REPLAY_INCOMPLETE",
  internal: "DROPSHIP_LISTING_SETTINGS_INTERNAL_ERROR",
} as const);

// ---------------------------------------------------------------------------
// W8: exact prices for many sizes (PUT …/listing-settings/size-prices)
// ---------------------------------------------------------------------------

/**
 * "Give these sizes a price": a typed price for each size, each with the
 * price revision the vendor saw (null when the size had none). All or none:
 * one refused size leaves every size as it was.
 */
export const saveSizePricesInputSchema = z.object({
  idempotencyKey: listingSettingRequestKeySchema,
  rows: z.array(z.object({
    productVariantId: id,
    /** Integer cents, above zero and within the int4 price columns. */
    priceCents: listingPriceCentsSchema,
    expectedRevisionId: id.nullable(),
  }).strict()).min(1).max(MAX_SIZE_PRICES_PER_REQUEST)
    .refine((rows) => new Set(rows.map((row) => row.productVariantId)).size === rows.length, "Each size once."),
}).strict();

/**
 * `changed`: every size was saved now. `replayed`: the request key already
 * saved them, and these are the revisions it wrote.
 */
export const saveSizePricesResponseSchema = z.object({
  outcome: z.enum(["changed", "replayed"]),
  sizes: z.array(z.object({ productVariantId: id, revisionId: id, idempotentReplay: z.boolean() }).strict())
    .min(1).max(MAX_SIZE_PRICES_PER_REQUEST),
}).strict().superRefine((response, context) => {
  const ids = response.sizes.map((size) => size.productVariantId);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Each size once.", path: ["sizes"] });
  }
  if (response.sizes.some((size) => size.idempotentReplay !== (response.outcome === "replayed"))) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every size is replayed exactly when the request is.", path: ["sizes"] });
  }
});

export type SaveSizePricesInput = z.infer<typeof saveSizePricesInputSchema>;
export type SaveSizePricesResponse = z.infer<typeof saveSizePricesResponseSchema>;
