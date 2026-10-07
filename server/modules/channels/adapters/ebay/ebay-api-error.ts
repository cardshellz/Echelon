import { z } from "zod";

const errorResponseSchema = z.object({ errors:z.array(z.object({ errorId:z.number().int() }).passthrough()) }).passthrough();

/** Preserve the existing message while retaining the provider's actual HTTP/error identity. */
export class EbayApiRequestError extends Error {
  readonly errorIds: readonly number[];
  constructor(readonly statusCode: number | undefined, message: string, responseBody: string) {
    super(message);
    this.name = "EbayApiRequestError";
    try {
      const parsed = errorResponseSchema.safeParse(JSON.parse(responseBody));
      this.errorIds = parsed.success ? parsed.data.errors.map(error => error.errorId) : [];
    } catch { this.errorIds = []; }
  }
}

/** A path or error message containing the digits 404 is not evidence of a missing resource. */
export function isMissingEbayInventoryResource(error: unknown): boolean {
  return error instanceof EbayApiRequestError && (error.statusCode === 404
    // eBay documents these inventory-resource-not-found codes as HTTP 400.
    // https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/getInventoryItem
    || (error.statusCode === 400 && error.errorIds.some(id => id === 25702 || id === 25710)));
}
