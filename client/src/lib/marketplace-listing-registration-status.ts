import { z } from "zod";

import { apiRequest } from "./queryClient";

export const MARKETPLACE_LISTING_REGISTRATION_STATUS_CHUNK_SIZE = 500;

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const positivePostgresIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(MAX_POSTGRES_INTEGER);
const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);
const marketplaceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^EBAY_[A-Z0-9_]+$/);
const nullableTrimmedTextSchema = z.string().trim().min(1).max(255).nullable();

export const marketplaceListingRegistrationStatusSchema = z
  .object({
    status: z.literal("registered"),
    productId: positivePostgresIntegerSchema,
    registrationId: positiveSafeIntegerSchema,
    scopeId: positiveSafeIntegerSchema,
    providerAccountId: positiveSafeIntegerSchema,
    publicationId: positiveSafeIntegerSchema,
    providerPublicationKey: nullableTrimmedTextSchema,
    externalListingId: z.string().trim().min(1).max(255),
    registeredVariantIds: z.array(positivePostgresIntegerSchema).default([]),
    registeredVariants: z.array(z.object({
      productVariantId: positivePostgresIntegerSchema,
      sku: z.string().trim().min(1).max(255),
      disposition: z.enum(["included", "excluded"]),
    }).strict()).default([]),

    registeredAt: z.string().datetime({ offset: true }),
  })
  .strict();

export const marketplaceListingRegistrationStatusResponseSchema = z
  .object({
    statuses: z
      .array(marketplaceListingRegistrationStatusSchema)
      .max(MARKETPLACE_LISTING_REGISTRATION_STATUS_CHUNK_SIZE),
  })
  .strict();

const channelRegistrationStatusRequestSchema = z
  .object({
    channelId: positivePostgresIntegerSchema,
    marketplaceId: marketplaceIdSchema,
    productIds: z
      .array(positivePostgresIntegerSchema)
      .min(1)
      .superRefine((productIds, context) => {
        if (new Set(productIds).size !== productIds.length) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "productIds must be distinct.",
          });
        }
      }),
  })
  .strict();

export type MarketplaceListingRegistrationStatus = z.infer<
  typeof marketplaceListingRegistrationStatusSchema
>;

export interface FetchChannelEbayMarketplaceListingRegistrationStatusesInput {
  readonly channelId: number;
  readonly marketplaceId: string;
  readonly productIds: readonly number[];
}

export type MarketplaceListingRegistrationStatusRequest = (
  method: string,
  url: string,
  data?: unknown,
) => Promise<Response>;

export type MarketplaceListingRegistrationStatusClientErrorCode =
  | "MARKETPLACE_LISTING_REGISTRATION_STATUS_INPUT_INVALID"
  | "MARKETPLACE_LISTING_REGISTRATION_STATUS_HTTP_FAILED"
  | "MARKETPLACE_LISTING_REGISTRATION_STATUS_RESPONSE_INVALID"
  | "MARKETPLACE_LISTING_REGISTRATION_STATUS_DUPLICATE_PRODUCT"
  | "MARKETPLACE_LISTING_REGISTRATION_STATUS_UNREQUESTED_PRODUCT";

export class MarketplaceListingRegistrationStatusClientError extends Error {
  readonly code: MarketplaceListingRegistrationStatusClientErrorCode;
  readonly context: Readonly<Record<string, unknown>>;

  constructor(
    code: MarketplaceListingRegistrationStatusClientErrorCode,
    message: string,
    context: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "MarketplaceListingRegistrationStatusClientError";
    this.code = code;
    this.context = Object.freeze({ ...context });
  }
}

export async function fetchChannelEbayMarketplaceListingRegistrationStatuses(
  input: FetchChannelEbayMarketplaceListingRegistrationStatusesInput,
  request: MarketplaceListingRegistrationStatusRequest = apiRequest,
): Promise<readonly MarketplaceListingRegistrationStatus[]> {
  const parsedInput = channelRegistrationStatusRequestSchema.safeParse(input);
  if (!parsedInput.success) {
    throw new MarketplaceListingRegistrationStatusClientError(
      "MARKETPLACE_LISTING_REGISTRATION_STATUS_INPUT_INVALID",
      "Marketplace listing registration status input is invalid.",
      {
        issues: parsedInput.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  }

  const productIds = [...parsedInput.data.productIds].sort((left, right) => left - right);
  const statuses: MarketplaceListingRegistrationStatus[] = [];
  const seenProductIds = new Set<number>();

  for (
    let offset = 0;
    offset < productIds.length;
    offset += MARKETPLACE_LISTING_REGISTRATION_STATUS_CHUNK_SIZE
  ) {
    const chunk = productIds.slice(
      offset,
      offset + MARKETPLACE_LISTING_REGISTRATION_STATUS_CHUNK_SIZE,
    );
    const chunkIndex = offset / MARKETPLACE_LISTING_REGISTRATION_STATUS_CHUNK_SIZE;
    const chunkProductIds = new Set(chunk);
    const url = buildChannelEbayMarketplaceListingRegistrationStatusUrl({
      channelId: parsedInput.data.channelId,
      marketplaceId: parsedInput.data.marketplaceId,
      productIds: chunk,
    });
    let response: Response;
    try {
      response = await request("GET", url);
    } catch (cause) {
      throw new MarketplaceListingRegistrationStatusClientError(
        "MARKETPLACE_LISTING_REGISTRATION_STATUS_HTTP_FAILED",
        "Marketplace listing registration status request failed before a response was available.",
        {
          chunkIndex,
          causeName: cause instanceof Error ? cause.name : "UnknownError",
        },
      );
    }
    const parsedResponse = await parseStatusResponse(response, chunkIndex);

    for (const status of parsedResponse.statuses) {
      if (seenProductIds.has(status.productId)) {
        throw new MarketplaceListingRegistrationStatusClientError(
          "MARKETPLACE_LISTING_REGISTRATION_STATUS_DUPLICATE_PRODUCT",
          "Marketplace listing registration status returned a duplicate product.",
          { chunkIndex, productId: status.productId },
        );
      }
      if (!chunkProductIds.has(status.productId)) {
        throw new MarketplaceListingRegistrationStatusClientError(
          "MARKETPLACE_LISTING_REGISTRATION_STATUS_UNREQUESTED_PRODUCT",
          "Marketplace listing registration status returned an unrequested product.",
          { chunkIndex, productId: status.productId },
        );
      }
      seenProductIds.add(status.productId);
      statuses.push(status);
    }
  }

  return statuses.sort((left, right) => left.productId - right.productId);
}

export function buildChannelEbayMarketplaceListingRegistrationStatusUrl(input: {
  readonly channelId: number;
  readonly marketplaceId: string;
  readonly productIds: readonly number[];
}): string {
  const search = new URLSearchParams({
    channelId: String(input.channelId),
    marketplaceId: input.marketplaceId,
    productIds: input.productIds.join(","),
  });
  return `/api/marketplace-listings/registrations/channel/ebay/status?${search.toString()}`;
}

async function parseStatusResponse(
  response: Response,
  chunkIndex: number,
): Promise<z.infer<typeof marketplaceListingRegistrationStatusResponseSchema>> {
  if (!response.ok) {
    throw new MarketplaceListingRegistrationStatusClientError(
      "MARKETPLACE_LISTING_REGISTRATION_STATUS_HTTP_FAILED",
      `Marketplace listing registration status request failed (${response.status}).`,
      { chunkIndex, status: response.status },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MarketplaceListingRegistrationStatusClientError(
      "MARKETPLACE_LISTING_REGISTRATION_STATUS_RESPONSE_INVALID",
      "Marketplace listing registration status returned invalid JSON.",
      { chunkIndex },
    );
  }

  const parsed = marketplaceListingRegistrationStatusResponseSchema.safeParse(body);
  if (!parsed.success) {
    throw new MarketplaceListingRegistrationStatusClientError(
      "MARKETPLACE_LISTING_REGISTRATION_STATUS_RESPONSE_INVALID",
      "Marketplace listing registration status returned an invalid response.",
      {
        chunkIndex,
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    );
  }
  return parsed.data;
}
