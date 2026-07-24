import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  SHIPPING_CHANNEL_ELIGIBILITY_MODES,
  SHIPPING_CHANNEL_POLICY_PURPOSES,
  SHIPPING_CHANNEL_ROUTE_MODES,
  SHIPPING_LEGACY_PROFILE_KEYS,
} from "@shared/types/shipping-channel-routing";
import { requirePermission } from "../../../../routes/middleware";
import {
  ChannelShippingPolicyAdminError,
  ChannelShippingPolicyAdminService,
} from "../../application/channel-shipping-policy-admin.service";
import { PostgresChannelShippingPolicyAdminStore } from "../../infrastructure/channel-shipping-policy.repository";

const idSchema = z.coerce.number().int().positive();
const optionalCodeSchema = z.string().trim().min(1).max(20).nullable();
const destinationMemberSchema = z.object({
  country: z.string().trim().length(2),
  region: optionalCodeSchema,
  postalPrefix: z.string().trim().min(1).max(20).nullable(),
});
const destinationScopeSchema = z.object({
  code: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(160),
  members: z.array(destinationMemberSchema).min(1).max(2_000),
});
const updateDestinationScopeSchema = destinationScopeSchema.extend({
  expectedLockVersion: z.number().int().positive(),
});
const routeSchema = z.object({
  originWarehouseId: z.number().int().positive().nullable(),
  destinationScopeId: z.number().int().positive().nullable(),
  mode: z.enum(SHIPPING_CHANNEL_ROUTE_MODES),
  eligibilityMode: z.enum(SHIPPING_CHANNEL_ELIGIBILITY_MODES),
  rateBookId: z.number().int().positive().nullable(),
});
const createDraftSchema = z.object({
  channelId: z.number().int().positive(),
  purpose: z.enum(SHIPPING_CHANNEL_POLICY_PURPOSES),
  cloneActive: z.boolean().default(true),
  notes: z.string().trim().max(1_000).nullable().default(null),
});
const saveDraftSchema = z.object({
  expectedLockVersion: z.number().int().positive(),
  notes: z.string().trim().max(1_000).nullable().default(null),
  routes: z.array(routeSchema).min(1).max(200),
});
const lifecycleSchema = z.object({
  expectedLockVersion: z.number().int().positive(),
});
const policyPreviewSchema = z.object({
  originWarehouseId: z.number().int().positive(),
  destination: z.object({
    country: z.string().trim().length(2),
    region: z.string().trim().min(1).max(10).nullable(),
    postalCode: z.string().trim().min(1).max(20).nullable(),
  }),
});
const shadowComparisonSchema = policyPreviewSchema.extend({
  legacyProfile: z.enum(SHIPPING_LEGACY_PROFILE_KEYS),
});

type AdminService = Pick<
  ChannelShippingPolicyAdminService,
  | "listOverview"
  | "getPolicy"
  | "createDestinationScope"
  | "updateDestinationScope"
  | "retireDestinationScope"
  | "createPolicyDraft"
  | "savePolicyDraft"
  | "activatePolicyDraft"
  | "discardPolicyDraft"
  | "retireActivePolicy"
  | "previewPolicyResolution"
  | "comparePolicyToLegacy"
>;

export interface ChannelShippingPolicyAdminRouteDependencies {
  service?: AdminService;
}

export function registerChannelShippingPolicyAdminRoutes(
  app: Express,
  dependencies: ChannelShippingPolicyAdminRouteDependencies = {},
): void {
  const service = dependencies.service ?? new ChannelShippingPolicyAdminService(
    new PostgresChannelShippingPolicyAdminStore(),
  );

  app.get(
    "/api/shipping/admin/channel-routing",
    requirePermission("settings", "view"),
    async (_req, res) => {
      try {
        return res.json(await service.listOverview());
      } catch (error) {
        return sendAdminError(res, error, "load channel shipping routing");
      }
    },
  );

  app.get(
    "/api/shipping/admin/channel-policies/:policyId",
    requirePermission("settings", "view"),
    async (req, res) => {
      try {
        return res.json(await service.getPolicy(parseId(req.params.policyId)));
      } catch (error) {
        return sendAdminError(res, error, "load channel shipping policy");
      }
    },
  );

  app.post(
    "/api/shipping/admin/destination-scopes",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(destinationScopeSchema, req.body);
        const created = await service.createDestinationScope(
          input,
          auditActor(req),
        );
        return res.status(201).json(created);
      } catch (error) {
        return sendAdminError(res, error, "create delivery region");
      }
    },
  );

  app.put(
    "/api/shipping/admin/destination-scopes/:scopeId",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(updateDestinationScopeSchema, req.body);
        return res.json(await service.updateDestinationScope({
          ...input,
          scopeId: parseId(req.params.scopeId),
        }, auditActor(req)));
      } catch (error) {
        return sendAdminError(res, error, "update delivery region");
      }
    },
  );

  app.post(
    "/api/shipping/admin/destination-scopes/:scopeId/retire",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(lifecycleSchema, req.body);
        return res.json(await service.retireDestinationScope(
          parseId(req.params.scopeId),
          input.expectedLockVersion,
          auditActor(req),
        ));
      } catch (error) {
        return sendAdminError(res, error, "retire delivery region");
      }
    },
  );

  app.post(
    "/api/shipping/admin/channel-policies/drafts",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(createDraftSchema, req.body);
        const created = await service.createPolicyDraft({
          ...input,
          cloneActive: input.cloneActive ?? true,
          notes: input.notes ?? null,
        }, auditActor(req));
        return res.status(201).json(created);
      } catch (error) {
        return sendAdminError(res, error, "create channel shipping draft");
      }
    },
  );

  app.put(
    "/api/shipping/admin/channel-policies/:policyId/draft",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(saveDraftSchema, req.body);
        return res.json(await service.savePolicyDraft({
          ...input,
          policyId: parseId(req.params.policyId),
          notes: input.notes ?? null,
        }, auditActor(req)));
      } catch (error) {
        return sendAdminError(res, error, "save channel shipping draft");
      }
    },
  );

  app.post(
    "/api/shipping/admin/channel-policies/:policyId/activate",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(lifecycleSchema, req.body);
        return res.json(await service.activatePolicyDraft({
          policyId: parseId(req.params.policyId),
          expectedLockVersion: input.expectedLockVersion,
        }, auditActor(req)));
      } catch (error) {
        return sendAdminError(res, error, "activate channel shipping policy");
      }
    },
  );

  app.post(
    "/api/shipping/admin/channel-policies/:policyId/discard",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(lifecycleSchema, req.body);
        return res.json(await service.discardPolicyDraft({
          policyId: parseId(req.params.policyId),
          expectedLockVersion: input.expectedLockVersion,
        }, auditActor(req)));
      } catch (error) {
        return sendAdminError(res, error, "discard channel shipping draft");
      }
    },
  );

  app.post(
    "/api/shipping/admin/channel-policies/:policyId/retire",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(lifecycleSchema, req.body);
        return res.json(await service.retireActivePolicy({
          policyId: parseId(req.params.policyId),
          expectedLockVersion: input.expectedLockVersion,
        }, auditActor(req)));
      } catch (error) {
        return sendAdminError(res, error, "retire channel shipping policy");
      }
    },
  );

  app.post(
    "/api/shipping/admin/channel-policies/:policyId/preview",
    requirePermission("settings", "view"),
    async (req, res) => {
      try {
        const input = parseBody(policyPreviewSchema, req.body);
        return res.json(await service.previewPolicyResolution({
          ...input,
          policyId: parseId(req.params.policyId),
        }));
      } catch (error) {
        return sendAdminError(res, error, "preview channel shipping policy");
      }
    },
  );

  app.post(
    "/api/shipping/admin/channel-policies/:policyId/shadow-compare",
    requirePermission("settings", "edit"),
    async (req, res) => {
      try {
        const input = parseBody(shadowComparisonSchema, req.body);
        return res.json(await service.comparePolicyToLegacy({
          ...input,
          policyId: parseId(req.params.policyId),
          actor: auditActor(req),
        }));
      } catch (error) {
        return sendAdminError(res, error, "record channel routing shadow comparison");
      }
    },
  );
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ChannelShippingPolicyAdminError(
      400,
      "SHIPPING_CHANNEL_POLICY_INVALID_INPUT",
      "Review the channel shipping policy fields.",
      parsed.error.issues.map((issue) =>
        `${issue.path.join(".") || "request"}: ${issue.message}`),
    );
  }
  return parsed.data;
}

function parseId(value: string): number {
  const parsed = idSchema.safeParse(value);
  if (!parsed.success) {
    throw new ChannelShippingPolicyAdminError(
      400,
      "SHIPPING_CHANNEL_POLICY_INVALID_ID",
      "Invalid identifier.",
    );
  }
  return parsed.data;
}

function auditActor(req: Request): string {
  const actor = req.session?.user?.id;
  if (!actor) {
    throw new ChannelShippingPolicyAdminError(
      401,
      "SHIPPING_CHANNEL_POLICY_ACTOR_REQUIRED",
      "An authenticated operator is required to change channel shipping policies.",
    );
  }
  return actor;
}

function sendAdminError(
  res: Response,
  error: unknown,
  action: string,
): Response {
  if (error instanceof ChannelShippingPolicyAdminError) {
    return res.status(error.status).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    });
  }
  if (isPostgresError(error, "23505")) {
    return res.status(409).json({
      error: {
        code: "SHIPPING_CHANNEL_POLICY_CONFLICT",
        message: "This routing slot or delivery-region code is already in use.",
      },
    });
  }
  if (isPostgresError(error, "23503")) {
    return res.status(400).json({
      error: {
        code: "SHIPPING_CHANNEL_POLICY_REFERENCE_INVALID",
        message: "A referenced channel, warehouse, region, or pricing program no longer exists.",
      },
    });
  }
  console.error(JSON.stringify({
    code: "SHIPPING_CHANNEL_POLICY_ADMIN_FAILED",
    action,
    error: error instanceof Error ? error.message : String(error),
  }));
  return res.status(500).json({
    error: {
      code: "SHIPPING_CHANNEL_POLICY_ADMIN_FAILED",
      message: `Failed to ${action}.`,
    },
  });
}

function isPostgresError(error: unknown, code: string): boolean {
  return Boolean(
    error
    && typeof error === "object"
    && "code" in error
    && (error as { code?: unknown }).code === code,
  );
}
