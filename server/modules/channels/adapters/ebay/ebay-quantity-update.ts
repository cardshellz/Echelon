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
  errorId: z.number().int().nonnegative().safe().optional(),
  category: z.string().optional(),
  message: z.string().optional(),
  longMessage: z.string().optional(),
});
const operation = z.object({
  offerId: identity.optional(),
  statusCode: z.number().int().min(100).max(599),
  errors: z.array(providerError).optional(),
});
const responseSchema = z.object({
  errors: z.array(providerError).optional(),
  responses: z.array(operation.extend({
    statusCode: z.number().int().min(100).max(599).optional(),
    sku: identity.optional(),
    offers: z.array(operation.extend({ offerId: identity })).min(1).optional(),
  }).refine(row => row.statusCode !== undefined || row.offers !== undefined))
    .min(1).max(EBAY_QUANTITY_BATCH_LIMIT * 251),
});
const bulkIdentitySchema = z.object({ requests: z.array(z.object({ sku: identity,
  offers: z.array(z.object({ offerId: identity })).max(250),
})).min(1).max(EBAY_QUANTITY_BATCH_LIMIT) });
export interface EbayBulkQuantityResult {
  sku: string;
  complete: boolean;
  confirmed: boolean;
  statusCode?: number;
  errors: Partial<EbayError>[];
  operations: Array<{ statusCode?: number; errors?: Partial<EbayError>[] }>;
}

/** One protocol reader for transport evidence, admission, and caller results.
 * The provider identifies results by SKU/offer, never by array position.
 * Combined/nested responses retained by existing adapters remain supported.
 * https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/bulkUpdatePriceQuantity
 */
export function readEbayBulkQuantityResponse(value: unknown, request: unknown): EbayBulkQuantityResult[] | null {
  const expected = bulkIdentitySchema.safeParse(request);
  const parsed = responseSchema.safeParse(value);
  if (!expected.success || !parsed.success) return null;
  const requests = expected.data.requests;
  const bySku = new Map(requests.map(row => [row.sku, row]));
  const byOffer = new Map(requests.flatMap(row => row.offers.map(offer => [offer.offerId, row] as const)));
  if (bySku.size !== requests.length || byOffer.size !== requests.reduce((sum, row) => sum + row.offers.length, 0)) return null;
  const grouped = new Map<string, typeof parsed.data.responses>();
  for (const row of parsed.data.responses) {
    const owner = row.sku ? bySku.get(row.sku) : row.offerId ? byOffer.get(row.offerId) : undefined;
    if (!owner || (row.offerId !== undefined && byOffer.get(row.offerId) !== owner)
      || (row.offers !== undefined && (row.offerId !== undefined || row.offers.some(offer => byOffer.get(offer.offerId) !== owner)))) return null;
    const rows = grouped.get(owner.sku) ?? [];
    rows.push(row);
    grouped.set(owner.sku, rows);
  }
  return requests.map(requested => {
    const rows = grouped.get(requested.sku) ?? [];
    const itemRows = rows.filter(row => row.offerId === undefined && row.offers === undefined);
    const offerIds = rows.flatMap(row => row.offerId ? [row.offerId] : (row.offers ?? []).map(offer => offer.offerId));
    const complete = itemRows.length <= 1 && offerIds.length === requested.offers.length
      && new Set(offerIds).size === offerIds.length && (requested.offers.length > 0 || itemRows.length === 1);
    const operations = rows.flatMap(row => [ ...(row.statusCode === undefined ? [] : [row]), ...(row.offers ?? []) ]);
    const errors = [...(parsed.data.errors ?? []), ...rows.flatMap(row => row.errors ?? []),
      ...rows.flatMap(row => (row.offers ?? []).flatMap(offer => offer.errors ?? []))];
    const failed = operations.find(row => !SUCCESS_STATUSES.has(row.statusCode ?? 0) || row.errors?.length);
    return { sku: requested.sku, complete, confirmed: complete && errors.length === 0 && failed === undefined,
      statusCode: failed?.statusCode ?? operations.at(-1)?.statusCode, errors, operations };
  });
}

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
  const parsed = readEbayBulkQuantityResponse(value, { requests: validated.map(update => ({
    sku: update.sku, offers: [{ offerId: update.offerId }],
  })) });
  if (!parsed) return unconfirmed();
  return parsed.map((row, index) => ({ sku: row.sku, offerId: validated[index]!.offerId,
    confirmed: row.confirmed, statusCode: row.statusCode, errors: row.errors }));
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
