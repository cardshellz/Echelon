import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import {
  createRateTableProductRule,
  deleteRateTableProductRule,
  listProductPolicySelectors,
  listRateTableProductRules,
  previewRateTableProductPolicy,
  ProductRatePolicyAdminError,
  updateRateTableProductRule,
} from "../../application/product-rate-policy-admin.service";

const idSchema = z.coerce.number().int().positive();
const destinationScopeSchema = z.object({
  country: z.string().trim().length(2).transform((value) => value.toUpperCase()),
  regions: z.array(z.string().trim().length(2).transform((value) => value.toUpperCase())).max(60),
  postalPrefixes: z.array(z.object({
    region: z.string().trim().length(2).transform((value) => value.toUpperCase()),
    prefixes: z.array(z.string().trim().regex(/^\d{1,5}$/)).min(1).max(500),
  })).max(200),
}).superRefine((scope, context) => {
  if (scope.regions.length === 0 && scope.postalPrefixes.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["regions"],
      message: "Select at least one destination state or ZIP prefix.",
    });
  }
});

const selectorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("manual"), variantIds: z.array(z.number().int().positive()).min(1).max(5000) }),
  z.object({ kind: z.literal("shipping_group"), ref: z.string().trim().min(1).max(160) }),
  z.object({ kind: z.literal("product_line"), ref: z.string().trim().min(1).max(160) }),
  z.object({ kind: z.literal("category"), ref: z.string().trim().min(1).max(160) }),
  z.object({ kind: z.literal("sioc"), ref: z.literal("true") }),
  z.object({ kind: z.literal("saved_set"), productSetId: z.number().int().positive() }),
]);

const bandSchema = z.object({
  minMeasure: z.number().int().min(0),
  maxMeasure: z.number().int().min(0).nullable(),
  rateCents: z.number().int().min(0),
});

const ruleSchema = z.object({
  name: z.string().trim().min(1).max(160),
  kind: z.enum(["restriction", "base_charge", "adjustment", "threshold"]),
  action: z.enum([
    "block",
    "free",
    "fixed",
    "fixed_band",
    "base_plus_per_started_pound",
    "surcharge",
    "free_threshold",
  ]),
  measurementScope: z.enum(["order", "matched_items", "each_item", "carton"]),
  destinationScope: destinationScopeSchema,
  selector: selectorSchema,
  rateCents: z.number().int().min(0).nullable().default(null),
  perStartedPoundCents: z.number().int().min(0).nullable().default(null),
  thresholdCents: z.number().int().min(0).nullable().default(null),
  bands: z.array(bandSchema).max(100).default([]),
});

const previewSchema = z.object({
  originWarehouseId: z.number().int().positive(),
  destination: z.object({
    country: z.string().trim().length(2).transform((value) => value.toUpperCase()),
    region: z.string().trim().length(2).transform((value) => value.toUpperCase()),
    postalCode: z.string().trim().regex(/^\d{5}$/),
  }),
  lines: z.array(z.object({
    productVariantId: z.number().int().positive(),
    quantity: z.number().int().positive().max(10_000),
    unitPriceCents: z.number().int().min(0),
  })).min(1).max(100),
});

export function registerProductRatePolicyAdminRoutes(app: Express): void {
  app.get(
    "/api/shipping/admin/product-policy-selectors",
    requirePermission("settings", "view"),
    async (req, res) => {
      try {
        const search = typeof req.query.search === "string" ? req.query.search : "";
        return res.json(await listProductPolicySelectors(search));
      } catch (error) {
        return sendPolicyError(res, error, "list product-policy selectors");
      }
    },
  );

  app.get(
    "/api/shipping/admin/rate-tables/:id/product-rules",
    requirePermission("settings", "view"),
    async (req, res) => {
      try {
        return res.json(await listRateTableProductRules(parseId(req.params.id)));
      } catch (error) {
        return sendPolicyError(res, error, "list product shipping rules");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-tables/:id/product-rules",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = ruleSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const rule = await createRateTableProductRule(
          parseId(req.params.id),
          parsed.data,
          auditActor(req),
        );
        return res.status(201).json({ rule });
      } catch (error) {
        return sendPolicyError(res, error, "create product shipping rule");
      }
    },
  );

  app.post(
    "/api/shipping/admin/rate-tables/:id/product-rules/preview",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = previewSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        return res.json(await previewRateTableProductPolicy(parseId(req.params.id), parsed.data));
      } catch (error) {
        return sendPolicyError(res, error, "preview product shipping rules");
      }
    },
  );

  app.put(
    "/api/shipping/admin/rate-tables/:id/product-rules/:ruleId",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const parsed = ruleSchema.safeParse(req.body);
        if (!parsed.success) return sendInvalidInput(res, parsed.error.issues);
        const rule = await updateRateTableProductRule(
          parseId(req.params.id),
          parseId(req.params.ruleId),
          parsed.data,
          auditActor(req),
        );
        return res.json({ rule });
      } catch (error) {
        return sendPolicyError(res, error, "update product shipping rule");
      }
    },
  );

  app.delete(
    "/api/shipping/admin/rate-tables/:id/product-rules/:ruleId",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        await deleteRateTableProductRule(
          parseId(req.params.id),
          parseId(req.params.ruleId),
          auditActor(req),
        );
        return res.status(204).send();
      } catch (error) {
        return sendPolicyError(res, error, "delete product shipping rule");
      }
    },
  );
}

function auditActor(req: Request): string {
  const actor = req.session.user?.id;
  if (!actor) {
    throw new ProductRatePolicyAdminError(
      401,
      "SHIPPING_PRODUCT_POLICY_ACTOR_REQUIRED",
      "An authenticated operator is required to change product shipping policies.",
    );
  }
  return actor;
}

function parseId(value: string): number {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) {
    throw new ProductRatePolicyAdminError(400, "SHIPPING_PRODUCT_POLICY_INVALID_ID", "Invalid identifier.");
  }
  return parsed.data;
}

function sendInvalidInput(res: Response, issues: z.ZodIssue[]): Response {
  return res.status(400).json({
    error: {
      code: "SHIPPING_PRODUCT_POLICY_INVALID_INPUT",
      message: "Review the product shipping rule fields.",
      details: issues,
    },
  });
}

function sendPolicyError(res: Response, error: unknown, action: string): Response {
  if (error instanceof ProductRatePolicyAdminError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, details: error.details },
    });
  }
  console.error(JSON.stringify({
    code: "SHIPPING_PRODUCT_POLICY_ADMIN_FAILED",
    action,
    error: error instanceof Error ? error.message : String(error),
  }));
  return res.status(500).json({
    error: {
      code: "SHIPPING_PRODUCT_POLICY_ADMIN_FAILED",
      message: `Failed to ${action}.`,
    },
  });
}
