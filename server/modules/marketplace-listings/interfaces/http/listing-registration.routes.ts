import type { Express, Request, Response } from "express";
import { z } from "zod";

import { requirePermission } from "../../../../routes/middleware";
import type {
  ConfirmListingRegistrationInput,
  ListingOwnerRef,
  MarketplaceListingRegistrationService,
  PreviewListingRegistrationInput,
} from "../..";
import { MarketplaceListingRegistrationError } from "../../domain/registration-errors";

const EBAY_PROVIDER = "ebay";
const IDEMPOTENCY_HEADER_NAMES = ["Idempotency-Key", "X-Idempotency-Key"] as const;
const MAX_STATUS_PRODUCT_IDS = 500;
const MAX_POSTGRES_INTEGER = 2_147_483_647;

type RegistrationServicePort = Pick<
  MarketplaceListingRegistrationService,
  "preview" | "confirm" | "getCurrentRegistrationStatuses"
>;

export interface MarketplaceListingRegistrationServiceResolver {
  forOwner(owner: ListingOwnerRef): RegistrationServicePort;
}

const optionalLocatorText = z.string().trim().min(1).max(255).nullable().optional();
const marketplaceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^EBAY_[A-Z0-9_]+$/);
const positiveIntegerQuerySchema = z
  .string()
  .regex(/^[1-9][0-9]*$/)
  .transform(Number)
  .pipe(z.number().int().positive().max(MAX_POSTGRES_INTEGER));
const productIdsQuerySchema = z
  .string()
  .trim()
  .min(1)
  .max(6_000)
  .transform((value, context) => {
    const parts = value.split(",");
    const ids = parts.map((part) => Number(part));
    if (
      parts.length > MAX_STATUS_PRODUCT_IDS ||
      parts.some((part) => !/^[1-9][0-9]*$/.test(part)) ||
      ids.some((id) => !Number.isSafeInteger(id) || id > MAX_POSTGRES_INTEGER) ||
      new Set(ids).size !== ids.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "productIds must contain 1 to 500 distinct positive PostgreSQL integers.",
      });
      return z.NEVER;
    }
    return ids;
  });
const registrationRequestShape = {
  productId: z.number().int().positive().max(2_147_483_647),
  marketplaceId: marketplaceIdSchema,
  providerPublicationKey: optionalLocatorText,
  externalListingId: optionalLocatorText,
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
} as const;

const channelRequestSchema = z
  .object({
    ...registrationRequestShape,
    channelId: z.number().int().positive().max(2_147_483_647),
  })
  .strict()
  .superRefine(validateLocator);

const channelConfirmRequestSchema = z
  .object({
    ...registrationRequestShape,
    channelId: z.number().int().positive().max(2_147_483_647),
    expectedObservationHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine(validateLocator);

const dropshipRequestSchema = z
  .object({
    ...registrationRequestShape,
    storeConnectionId: z.number().int().positive().max(2_147_483_647),
  })
  .strict()
  .superRefine(validateLocator);

const dropshipConfirmRequestSchema = z
  .object({
    ...registrationRequestShape,
    storeConnectionId: z.number().int().positive().max(2_147_483_647),
    expectedObservationHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .superRefine(validateLocator);

const channelStatusQuerySchema = z
  .object({
    channelId: positiveIntegerQuerySchema,
    marketplaceId: marketplaceIdSchema,
    productIds: productIdsQuerySchema,
  })
  .strict();

const dropshipStatusQuerySchema = z
  .object({
    storeConnectionId: positiveIntegerQuerySchema,
    marketplaceId: marketplaceIdSchema,
    productIds: productIdsQuerySchema,
  })
  .strict();

type RegistrationRouteBody = z.infer<typeof channelRequestSchema> | z.infer<typeof dropshipRequestSchema>;

export function registerMarketplaceListingRegistrationRoutes(
  app: Express,
  resolver: MarketplaceListingRegistrationServiceResolver,
): void {
  app.get(
    "/api/marketplace-listings/registrations/channel/ebay/status",
    requirePermission("channels", "edit"),
    async (req, res) => {
      try {
        const query = parseRequest(channelStatusQuerySchema, req.query);
        const owners = query.productIds.map((productId) =>
          channelOwner(query.channelId, productId, query.marketplaceId),
        );
        const statuses = await resolver
          .forOwner(owners[0])
          .getCurrentRegistrationStatuses(owners);
        return res.json({ statuses });
      } catch (error) {
        return sendRegistrationError(res, error);
      }
    },
  );

  app.get(
    "/api/marketplace-listings/registrations/dropship/ebay/status",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const query = parseRequest(dropshipStatusQuerySchema, req.query);
        const owners = query.productIds.map((productId) =>
          dropshipOwner(
            query.storeConnectionId,
            productId,
            query.marketplaceId,
          ),
        );
        const statuses = await resolver
          .forOwner(owners[0])
          .getCurrentRegistrationStatuses(owners);
        return res.json({ statuses });
      } catch (error) {
        return sendRegistrationError(res, error);
      }
    },
  );

  app.post(
    "/api/marketplace-listings/registrations/channel/ebay/preview",
    requirePermission("channels", "edit"),
    async (req, res) => {
      try {
        const body = parseRequest(channelRequestSchema, req.body);
        const owner = channelOwner(
          body.channelId,
          body.productId,
          body.marketplaceId,
        );
        const preview = await resolver.forOwner(owner).preview(
          buildPreviewInput(req, owner, body),
        );
        return res.json({ preview });
      } catch (error) {
        return sendRegistrationError(res, error);
      }
    },
  );

  app.post(
    "/api/marketplace-listings/registrations/channel/ebay/confirm",
    requirePermission("channels", "edit"),
    async (req, res) => {
      try {
        const body = parseRequest(channelConfirmRequestSchema, req.body);
        const owner = channelOwner(
          body.channelId,
          body.productId,
          body.marketplaceId,
        );
        const result = await resolver.forOwner(owner).confirm(
          buildConfirmInput(req, owner, body),
        );
        return res.json({ result });
      } catch (error) {
        return sendRegistrationError(res, error);
      }
    },
  );

  app.post(
    "/api/marketplace-listings/registrations/dropship/ebay/preview",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const body = parseRequest(dropshipRequestSchema, req.body);
        const owner = dropshipOwner(
          body.storeConnectionId,
          body.productId,
          body.marketplaceId,
        );
        const preview = await resolver.forOwner(owner).preview(
          buildPreviewInput(req, owner, body),
        );
        return res.json({ preview });
      } catch (error) {
        return sendRegistrationError(res, error);
      }
    },
  );

  app.post(
    "/api/marketplace-listings/registrations/dropship/ebay/confirm",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const body = parseRequest(dropshipConfirmRequestSchema, req.body);
        const owner = dropshipOwner(
          body.storeConnectionId,
          body.productId,
          body.marketplaceId,
        );
        const result = await resolver.forOwner(owner).confirm(
          buildConfirmInput(req, owner, body),
        );
        return res.json({ result });
      } catch (error) {
        return sendRegistrationError(res, error);
      }
    },
  );
}

function channelOwner(
  channelId: number,
  productId: number,
  marketplaceId: string,
): ListingOwnerRef {
  return {
    kind: "channel",
    channelId,
    productId,
    provider: EBAY_PROVIDER,
    marketplaceId,
  };
}

function dropshipOwner(
  storeConnectionId: number,
  productId: number,
  marketplaceId: string,
): ListingOwnerRef {
  return {
    kind: "dropship",
    storeConnectionId,
    productId,
    provider: EBAY_PROVIDER,
    marketplaceId,
  };
}

function buildPreviewInput(
  req: Request,
  owner: ListingOwnerRef,
  body: RegistrationRouteBody,
): PreviewListingRegistrationInput {
  return {
    owner,
    locator: {
      providerPublicationKey: body.providerPublicationKey ?? null,
      externalListingId: body.externalListingId ?? null,
    },
    idempotencyKey: resolveIdempotencyKey(req, body.idempotencyKey),
    requestedBy: { type: "user", id: requireSessionUserId(req) },
    correlationId: parseCorrelationId(req.header("X-Correlation-Id")),
  };
}

function buildConfirmInput(
  req: Request,
  owner: ListingOwnerRef,
  body: RegistrationRouteBody & { expectedObservationHash: string },
): ConfirmListingRegistrationInput {
  return {
    ...buildPreviewInput(req, owner, body),
    expectedObservationHash: body.expectedObservationHash,
  };
}

function validateLocator(
  value: { providerPublicationKey?: string | null; externalListingId?: string | null },
  context: z.RefinementCtx,
): void {
  if (!value.providerPublicationKey && !value.externalListingId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["externalListingId"],
      message: "A provider publication key or external listing ID is required.",
    });
  }
}

function parseRequest<Schema extends z.ZodTypeAny>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new MarketplaceListingRegistrationError(
    "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
    "Marketplace listing registration request failed validation.",
    {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      })),
    },
  );
}

function resolveIdempotencyKey(req: Request, bodyKey: string | undefined): string {
  const headerValues = IDEMPOTENCY_HEADER_NAMES
    .map((name) => req.header(name))
    .filter((value): value is string => Boolean(value));
  const distinctHeaders = [...new Set(headerValues.map((value) => value.trim()))];
  if (distinctHeaders.length > 1) {
    throw invalidIdempotency("Idempotency headers disagree.");
  }
  const headerKey = distinctHeaders[0];
  if (headerKey && bodyKey && headerKey !== bodyKey) {
    throw invalidIdempotency("Idempotency header and body values disagree.");
  }
  const key = (bodyKey ?? headerKey ?? "").trim();
  if (!key || key.length > 200) {
    throw invalidIdempotency(
      "An Idempotency-Key header or idempotencyKey body field is required.",
    );
  }
  return key;
}

function invalidIdempotency(message: string): MarketplaceListingRegistrationError {
  return new MarketplaceListingRegistrationError(
    "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
    message,
  );
}

function requireSessionUserId(req: Request): string {
  const candidate = req.session.user?.id;
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_AUTH_CONTEXT_INVALID",
      "Authenticated registration requests require a stable user identity.",
    );
  }
  return candidate.trim();
}

function parseCorrelationId(value: string | undefined): string | null {
  if (value === undefined) return null;
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) {
    throw new MarketplaceListingRegistrationError(
      "MARKETPLACE_LISTING_REGISTRATION_REQUEST_INVALID",
      "X-Correlation-Id must contain between 1 and 100 characters.",
    );
  }
  return normalized;
}

function sendRegistrationError(res: Response, error: unknown): Response {
  if (error instanceof MarketplaceListingRegistrationError) {
    return res.status(statusForRegistrationError(error.code)).json({
      error: error.toJSON(),
    });
  }

  console.error("[MarketplaceListingRegistrationRoutes] Unexpected error", error);
  return res.status(500).json({
    error: {
      code: "MARKETPLACE_LISTING_REGISTRATION_INTERNAL_ERROR",
      message: "Marketplace listing registration failed.",
      context: {},
    },
  });
}

function statusForRegistrationError(code: string): number {
  if (
    code === "MARKETPLACE_LISTING_REGISTRATION_CONFIGURATION_UNAVAILABLE"
  ) {
    return 503;
  }
  if (code.includes("NOT_FOUND")) return 404;
  if (
    code.includes("OBSERVATION_CHANGED") ||
    code.includes("CONFLICT") ||
    code.includes("ALREADY") ||
    code.includes("NOT_LIVE") ||
    code.includes("NOT_EMPTY") ||
    code.includes("OWNER_CHANGED") ||
    code.includes("OWNER_SNAPSHOT_STALE") ||
    code.includes("CONCURRENT_UPDATE") ||
    code.includes("ACCOUNT_CLAIM")
  ) {
    return 409;
  }
  if (code.includes("OBSERVATION_FAILED")) return 502;
  if (
    code.includes("REQUEST_INVALID") ||
    code.includes("LOCATOR") ||
    code.includes("TEXT_INVALID") ||
    code.includes("HASH_INVALID") ||
    code.includes("INTEGER_INVALID") ||
    code.includes("AUTH_CONTEXT_INVALID")
  ) {
    return 400;
  }
  return 500;
}
