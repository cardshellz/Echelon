import type { Express, Request, Response } from "express";
import { z } from "zod";

import { requirePermission } from "../../../../routes/middleware";
import {
  MarketplaceListingReplacementError,
  requestedListingMemberSchema,
  type ExecuteListingReplacementInput,
  type ListingOwnerRef,
  type ListingReplacementExecutionService,
  type ListingReplacementPlanningService,
} from "../..";

type PlanningPort = Pick<ListingReplacementPlanningService, "plan">;
type ExecutionPort = Pick<ListingReplacementExecutionService, "execute">;
export interface MarketplaceListingReplacementServiceResolver {
  forOwner(owner: ListingOwnerRef): PlanningPort & ExecutionPort;
}

const marketplaceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^EBAY_[A-Z0-9_]+$/);
const common = {
  productId: z.number().int().positive().max(2_147_483_647),
  marketplaceId: marketplaceIdSchema,
  targetMembers: z.array(requestedListingMemberSchema).min(1).max(10_000),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
} as const;
const channelSchema = z
  .object({
    ...common,
    channelId: z.number().int().positive().max(2_147_483_647),
  })
  .strict()
  .superRefine(validateTargetMembers);
const channelExecutionSchema = z
  .object({
    productId: common.productId,
    marketplaceId: common.marketplaceId,
    channelId: z.number().int().positive().max(2_147_483_647),
  })
  .strict();
const dropshipExecutionSchema = z
  .object({
    productId: common.productId,
    marketplaceId: common.marketplaceId,
    storeConnectionId: z.number().int().positive().max(2_147_483_647),
  })
  .strict();
const dropshipSchema = z
  .object({
    ...common,
    storeConnectionId: z.number().int().positive().max(2_147_483_647),
  })
  .strict()
  .superRefine(validateTargetMembers);

function validateTargetMembers(
  value: {
    targetMembers: readonly z.infer<typeof requestedListingMemberSchema>[];
  },
  context: z.RefinementCtx,
): void {
  const seen = new Set<number>();
  value.targetMembers.forEach((member, index) => {
    if (seen.has(member.productVariantId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetMembers", index, "productVariantId"],
        message: "Each product variant may appear only once.",
      });
    }
    seen.add(member.productVariantId);
  });
  if (
    !value.targetMembers.some((member) => member.disposition === "included")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["targetMembers"],
      message: "At least one product variant must be included.",
    });
  }
}

export function registerMarketplaceListingReplacementRoutes(
  app: Express,

  resolver: MarketplaceListingReplacementServiceResolver,
): void {
  app.post(
    "/api/marketplace-listings/replacements/channel/ebay/plan",
    requirePermission("channels", "edit"),
    async (req, res) => {
      try {
        const body = parse(channelSchema, req.body);
        const owner: ListingOwnerRef = {
          kind: "channel",
          channelId: body.channelId,
          productId: body.productId,
          provider: "ebay",
          marketplaceId: body.marketplaceId,
        };
        return res
          .status(201)
          .json(
            await resolver.forOwner(owner).plan(buildInput(req, owner, body)),
          );
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
  app.post(
    "/api/marketplace-listings/replacements/channel/ebay/:operationId/execute",
    requirePermission("channels", "edit"),
    async (req, res) => {
      try {
        const body = parse(channelExecutionSchema, req.body);

        const operationId = parseOperationId(req.params.operationId);
        const owner: ListingOwnerRef = {
          kind: "channel",
          channelId: body.channelId,
          productId: body.productId,
          provider: "ebay",
          marketplaceId: body.marketplaceId,
        };
        return res.status(200).json({
          result: await resolver
            .forOwner(owner)
            .execute(buildExecutionInput(req, owner, operationId)),
        });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
  app.post(
    "/api/marketplace-listings/replacements/dropship/ebay/plan",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const body = parse(dropshipSchema, req.body);
        const owner: ListingOwnerRef = {
          kind: "dropship",
          storeConnectionId: body.storeConnectionId,
          productId: body.productId,
          provider: "ebay",
          marketplaceId: body.marketplaceId,
        };
        return res
          .status(201)
          .json(
            await resolver.forOwner(owner).plan(buildInput(req, owner, body)),
          );
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
  app.post(
    "/api/marketplace-listings/replacements/dropship/ebay/:operationId/execute",
    requirePermission("dropship", "manage_operations"),
    async (req, res) => {
      try {
        const body = parse(dropshipExecutionSchema, req.body);

        const operationId = parseOperationId(req.params.operationId);
        const owner: ListingOwnerRef = {
          kind: "dropship",
          storeConnectionId: body.storeConnectionId,
          productId: body.productId,
          provider: "ebay",
          marketplaceId: body.marketplaceId,
        };
        return res.status(200).json({
          result: await resolver
            .forOwner(owner)
            .execute(buildExecutionInput(req, owner, operationId)),
        });
      } catch (error) {
        return sendError(res, error);
      }
    },
  );
}

function buildExecutionInput(
  req: Request,
  owner: ListingOwnerRef,
  operationId: number,
): ExecuteListingReplacementInput {
  return {
    operationId,
    expectedOwner: owner,
    actor: { type: "user", id: sessionUser(req) },
  };
}

function parseOperationId(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_REQUEST_INVALID",
      "Replacement operation ID is invalid.",
    );
  }
  return parsed;
}

function buildInput(
  req: Request,
  owner: ListingOwnerRef,
  body: {
    targetMembers: z.infer<typeof requestedListingMemberSchema>[];
    idempotencyKey?: string;
  },
): unknown {
  return {
    owner,
    targetMembers: body.targetMembers,
    idempotencyKey: resolveIdempotency(req, body.idempotencyKey),
    requestedBy: { type: "user", id: sessionUser(req) },
    correlationId: correlation(req),
  };
}
function parse<T extends z.ZodTypeAny>(schema: T, value: unknown): z.output<T> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new MarketplaceListingReplacementError(
    "MARKETPLACE_LISTING_REPLACEMENT_REQUEST_INVALID",
    "Marketplace listing replacement request failed validation.",
    {
      issues: parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        code: issue.code,
      })),
    },
  );
}
function resolveIdempotency(
  req: Request,
  bodyValue: string | undefined,
): string {
  const headerValue = req.header("Idempotency-Key")?.trim();
  if (headerValue && bodyValue && headerValue !== bodyValue)
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_REQUEST_INVALID",
      "Idempotency header and body values disagree.",
    );
  const value = (bodyValue ?? headerValue ?? "").trim();
  if (!value || value.length > 200)
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_REQUEST_INVALID",
      "An idempotency key is required.",
    );
  return value;
}
function sessionUser(req: Request): string {
  const id = req.session.user?.id;
  if (typeof id !== "string" || !id.trim())
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_AUTH_CONTEXT_INVALID",
      "A stable authenticated user ID is required.",
    );
  return id.trim();
}
function correlation(req: Request): string | null {
  const value = req.header("X-Correlation-Id")?.trim();
  if (!value) return null;
  if (value.length > 100)
    throw new MarketplaceListingReplacementError(
      "MARKETPLACE_LISTING_REPLACEMENT_REQUEST_INVALID",
      "X-Correlation-Id is too long.",
    );
  return value;
}
function sendError(res: Response, error: unknown): Response {
  if (error instanceof MarketplaceListingReplacementError) {
    const status = error.code.includes("NOT_FOUND")
      ? 404
      : error.code.includes("INVALID") || error.code.includes("AUTH_CONTEXT")
        ? 400
        : error.code.includes("CONFLICT") ||
            error.code.includes("ACTIVE_SOURCE")
          ? 409
          : 500;
    return res.status(status).json({
      error: {
        code: error.code,
        message: error.message,
        context: error.context,
      },
    });
  }
  console.error(
    "[MarketplaceListingReplacementRoutes] Unexpected error",
    error,
  );
  return res.status(500).json({
    error: {
      code: "MARKETPLACE_LISTING_REPLACEMENT_INTERNAL_ERROR",
      message: "Marketplace listing replacement planning failed.",
      context: {},
    },
  });
}
