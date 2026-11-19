/**
 * Shared eBay Fulfillment REST Order Transport & Offset Pager (`P3.2`)
 *
 * Centralizes eBay REST API base URLs, `Retry-After` / exponential backoff
 * GET transport, and offset-based Fulfillment API order pagination so peer
 * modules (`oms`, `dropship`) do not duplicate eBay HTTP/paging plumbing.
 */

import type { EbayOrder, EbayOrdersResponse } from "./ebay-types";

export type EbayRestEnvironment = "sandbox" | "production";

export const EBAY_REST_API_BASE_URLS: Record<EbayRestEnvironment, string> = {
  sandbox: "https://api.sandbox.ebay.com",
  production: "https://api.ebay.com",
};

export function resolveEbayRetryDelayMs(
  response: Response | null,
  attempt: number,
  maxDelayMs = 10_000,
): number {
  const retryAfter = response?.headers.get("Retry-After");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1_000;
    }
  }
  return Math.min(1_000 * Math.pow(2, attempt - 1), maxDelayMs);
}

function defaultDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchEbayFulfillmentResourceInput<TError extends Error = Error> {
  environment: EbayRestEnvironment;
  accessToken: string;
  marketplaceId?: string;
  path: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  delayImpl?: (ms: number) => Promise<void>;
  onHttpFailure?: (status: number, bodyText: string) => Promise<void> | void;
  createNetworkError: (cause: unknown) => TError;
  createInvalidJsonError: (bodyText: string) => TError;
  createHttpError: (status: number, bodyText: string, retryable: boolean) => TError;
  createRetryExhaustedError?: () => TError;
}

export async function fetchEbayFulfillmentResource<
  TResponse,
  TError extends Error = Error,
>(input: FetchEbayFulfillmentResourceInput<TError>): Promise<TResponse> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const maxAttempts = input.maxAttempts ?? 3;
  const delayImpl = input.delayImpl ?? defaultDelay;
  const marketplaceId = input.marketplaceId?.trim() || "EBAY_US";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await fetchImpl(
        `${EBAY_REST_API_BASE_URLS[input.environment]}${input.path}`,
        {
          method: "GET",
          headers: {
            Authorization: `Bearer ${input.accessToken}`,
            Accept: "application/json",
            "X-EBAY-C-MARKETPLACE-ID": marketplaceId,
          },
        },
      );
    } catch (error) {
      if (attempt < maxAttempts) {
        await delayImpl(resolveEbayRetryDelayMs(null, attempt));
        continue;
      }
      throw input.createNetworkError(error);
    }

    const text = await response.text();
    if (response.ok) {
      try {
        return JSON.parse(text) as TResponse;
      } catch {
        throw input.createInvalidJsonError(text);
      }
    }

    if (input.onHttpFailure) {
      await input.onHttpFailure(response.status, text);
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < maxAttempts) {
      await delayImpl(resolveEbayRetryDelayMs(response, attempt));
      continue;
    }

    throw input.createHttpError(response.status, text, retryable);
  }

  if (input.createRetryExhaustedError) {
    throw input.createRetryExhaustedError();
  }
  throw input.createHttpError(503, "retry attempts exhausted", true);
}

export interface PaginateEbayFulfillmentOrdersInput<TError extends Error = Error>
  extends Omit<FetchEbayFulfillmentResourceInput<TError>, "path"> {
  filter: string;
  pageSize?: number;
}

export async function paginateEbayFulfillmentOrders<TError extends Error = Error>(
  input: PaginateEbayFulfillmentOrdersInput<TError>,
): Promise<EbayOrder[]> {
  const pageSize = input.pageSize ?? 50;
  const orders: EbayOrder[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      filter: input.filter,
      limit: String(pageSize),
      offset: String(offset),
    });
    const response = await fetchEbayFulfillmentResource<EbayOrdersResponse, TError>({
      ...input,
      path: `/sell/fulfillment/v1/order?${params.toString()}`,
    });

    if (!Array.isArray(response.orders) || response.orders.length === 0) {
      break;
    }
    orders.push(...response.orders);
    offset += response.orders.length;
    if (response.orders.length < pageSize || offset >= response.total) {
      break;
    }
  }

  return orders;
}
