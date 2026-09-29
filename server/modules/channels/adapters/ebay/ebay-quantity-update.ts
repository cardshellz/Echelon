import { z } from "zod";
import type { EbayBulkPriceQuantityRequest, EbayError } from "./ebay-types";

export const EBAY_QUANTITY_BATCH_LIMIT = 25;
const SUCCESS_STATUSES = new Set([200, 201, 204]);

const identity = z.string().min(1).refine(value => value === value.trim());
const updateSchema = z.object({
  sku: identity,
  offerId: identity,
  quantity: z.number().int().nonnegative().safe(),
});
const providerError = z.object({
  errorId: z.number().int().optional(),
  message: z.string().optional(),
  longMessage: z.string().optional(),
});
const operation = z.object({
  offerId: identity.optional(),
  statusCode: z.number().int(),
  errors: z.array(providerError).optional(),
});
const responseSchema = z.object({
  errors: z.array(providerError).optional(),
  responses: z.array(operation.extend({
    statusCode: z.number().int().optional(),
    sku: identity.optional(),
    offers: z.array(operation.extend({ offerId: identity })).min(1).optional(),
  }).refine(row => row.statusCode !== undefined || row.offers !== undefined))
    .min(1).max(EBAY_QUANTITY_BATCH_LIMIT * 2),
});

export type EbayQuantityUpdate = z.infer<typeof updateSchema>;
export interface EbayQuantityUpdateResult {
  sku: string;
  offerId: string;
  confirmed: boolean;
  statusCode?: number;
  errors: Partial<EbayError>[];
}

export class EbayQuantityUpdateInputError extends Error {
  readonly code = "EBAY_QUANTITY_UPDATE_INPUT_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "EbayQuantityUpdateInputError";
  }
}

/** Shared bulk quantity sender for legacy, canonical and Dropship callers. */
export async function sendEbayQuantityUpdates(
  send: (request: EbayBulkPriceQuantityRequest) => Promise<unknown>,
  updates: readonly EbayQuantityUpdate[],
): Promise<EbayQuantityUpdateResult[]> {
  const validated = validateUpdates(updates);
  const response = await send({ requests: validated.map(update => ({
    sku: update.sku,
    shipToLocationAvailability: { quantity: update.quantity },
    offers: [{ offerId: update.offerId, availableQuantity: update.quantity }],
  })) });
  return readEbayQuantityUpdateResults(response, validated);
}

/**
 * eBay returns flat per-item/per-offer responses. Older transports also return
 * one combined or nested result. Reconcile by identity, never array position;
 * an item error must not be hidden by a successful offer result (or vice versa).
 */
export function readEbayQuantityUpdateResults(
  value: unknown,
  updates: readonly EbayQuantityUpdate[],
): EbayQuantityUpdateResult[] {
  const validated = validateUpdates(updates);
  const unconfirmed = (): EbayQuantityUpdateResult[] => validated.map(update => ({
    sku: update.sku, offerId: update.offerId, confirmed: false, errors: [],
  }));
  const parsed = responseSchema.safeParse(value);
  if (!parsed.success) return unconfirmed();
  const bySku = new Map(validated.map(update => [update.sku, update]));
  const byOffer = new Map(validated.map(update => [update.offerId, update]));
  const grouped = new Map<string, typeof parsed.data.responses>();
  for (const row of parsed.data.responses) {
    const update = row.sku ? bySku.get(row.sku) : row.offerId ? byOffer.get(row.offerId) : undefined;
    if (!update || (row.offerId !== undefined && row.offerId !== update.offerId)
      || (row.offers !== undefined && (row.offerId !== undefined || row.offers.length !== 1
        || row.offers[0]!.offerId !== update.offerId))) return unconfirmed();
    const group = grouped.get(update.sku) ?? [];
    group.push(row);
    grouped.set(update.sku, group);
  }
  return validated.map(update => {
    const rows = grouped.get(update.sku) ?? [];
    const itemRows = rows.filter(row => row.offerId === undefined && row.offers === undefined);
    const offerRows = rows.filter(row => row.offerId !== undefined || row.offers !== undefined);
    // One combined acknowledgement OR a distinct item plus offer acknowledgement.
    const complete = offerRows.length === 1 && itemRows.length <= 1 && rows.length <= 2;
    const operations = rows.flatMap(row => [row, ...(row.offers ?? [])]);
    const errors = [...(parsed.data.errors ?? []), ...operations.flatMap(row => row.errors ?? [])];
    const failed = operations.find(row => (row.statusCode !== undefined && !SUCCESS_STATUSES.has(row.statusCode)) || row.errors?.length);
    return {
      sku: update.sku, offerId: update.offerId,
      confirmed: complete && errors.length === 0 && failed === undefined,
      statusCode: failed?.statusCode ?? offerRows[0]?.offers?.[0]?.statusCode ?? offerRows[0]?.statusCode,
      errors,
    };
  });
}

function validateUpdates(updates: readonly EbayQuantityUpdate[]): EbayQuantityUpdate[] {
  const parsed = z.array(updateSchema).min(1).max(EBAY_QUANTITY_BATCH_LIMIT).safeParse(updates);
  if (!parsed.success) throw new EbayQuantityUpdateInputError(
    `An eBay quantity batch requires 1-${EBAY_QUANTITY_BATCH_LIMIT} valid SKU/offer identities and nonnegative safe integer quantities.`,
  );
  const validated = parsed.data;
  if (new Set(validated.map(update => update.sku)).size !== validated.length
    || new Set(validated.map(update => update.offerId)).size !== validated.length) {
    throw new EbayQuantityUpdateInputError("An eBay quantity batch must contain distinct SKU and offer identities.");
  }
  return validated;
}
