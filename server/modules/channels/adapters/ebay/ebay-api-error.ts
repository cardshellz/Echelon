import { z } from "zod";
import { channelProviderReadDiagnosticSchema, providerHttpReadFailureKind, type ChannelProviderReadDiagnostic } from "@shared/channel-provider-read";

const errorResponseSchema = z.object({ errors:z.array(z.object({ errorId:z.number().int() }).passthrough()) }).passthrough();

/** Preserve the existing message while retaining the provider's actual HTTP/error identity. */
export class EbayApiRequestError extends Error {
  readonly errorIds: readonly number[];
  readonly context?: { providerRead: ChannelProviderReadDiagnostic };
  constructor(readonly statusCode: number | undefined, message: string, responseBody: string, readResource?: string) {
    super(message);
    this.name = "EbayApiRequestError";
    try {
      const parsed = errorResponseSchema.safeParse(JSON.parse(responseBody));
      this.errorIds = parsed.success ? parsed.data.errors.map(error => error.errorId) : [];
    } catch { this.errorIds = []; }
    // Only the transport's explicit read boundary supplies this argument. A
    // rejected write must never acquire read-only retry or recovery semantics.
    if (readResource) this.context = { providerRead: channelProviderReadDiagnosticSchema.parse({
      provider: "ebay", resource: readResource, method: "GET",
      kind: statusCode === undefined ? "unavailable" : providerHttpReadFailureKind(statusCode),
      ...(statusCode !== undefined && Number.isInteger(statusCode) && statusCode >= 100 && statusCode <= 599 ? { httpStatus: statusCode } : {}),
    }) };
  }
}

/** A path or error message containing the digits 404 is not evidence of a missing resource. */
export function isMissingEbayInventoryResource(error: unknown): boolean {
  return error instanceof EbayApiRequestError && (error.statusCode === 404
    // eBay documents these inventory-resource-not-found codes as HTTP 400.
    // https://developer.ebay.com/api-docs/sell/inventory/resources/inventory_item/methods/getInventoryItem
    || (error.statusCode === 400 && error.errorIds.some(id => id === 25702 || id === 25710)));
}

/** A missing offer collection is an authoritative 404/25713 response. Mixed
 * error results and unknown 404s remain failures, never permission to create. */
export function isMissingEbayOfferCollection(status: number | undefined, errorIds: readonly number[]): boolean {
  return status === 404 && errorIds.length > 0 && errorIds.every(id => id === 25713);
}
