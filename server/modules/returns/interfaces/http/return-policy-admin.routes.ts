import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  returnApprovalAuthorities,
  returnDestinations,
  returnInspectionOwners,
  returnInspectionRequirements,
  returnLabelProviders,
  returnRefundAuthorities,
  returnShippingPayers,
  returnVendorSettlementTriggers,
} from "@shared/schema";
import { requirePermission } from "../../../../routes/middleware";
import {
  returnPolicyAppliesToKinds,
  ReturnPolicyAdminError,
  ReturnPolicyAdminService,
} from "../../application/return-policy-admin.service";
import { PostgresReturnPolicyAdminStore } from "../../infrastructure/return-policy.repository";

const nullablePositiveInteger = z.number().int().positive().nullable();
const publicScopeSchema = z.object({
  appliesTo: z.enum(returnPolicyAppliesToKinds),
  channelId: nullablePositiveInteger,
  vendorId: nullablePositiveInteger,
  storeConnectionId: nullablePositiveInteger,
});
const createPolicySchema = publicScopeSchema.extend({
  name: z.string().trim().min(1).max(160),
  returnWindowDays: z.number().int().min(0).max(3650),
  returnDestination: z.enum(returnDestinations),
  approvalAuthority: z.enum(returnApprovalAuthorities),
  labelProvider: z.enum(returnLabelProviders),
  returnShippingPayer: z.enum(returnShippingPayers),
  inspectionRequirement: z.enum(returnInspectionRequirements),
  inspectionOwner: z.enum(returnInspectionOwners),
  customerRefundAuthority: z.enum(returnRefundAuthorities),
  vendorSettlementTrigger: z.enum(returnVendorSettlementTriggers),
  returnlessRefundAllowed: z.boolean(),
  notes: z.string().trim().max(4000).nullable(),
});
const resolutionSchema = z.object({
  channelId: z.number().int().positive(),
  vendorId: nullablePositiveInteger,
  storeConnectionId: nullablePositiveInteger,
});
const searchSchema = z.object({
  search: z.string().trim().max(160).default(""),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
const storeSearchSchema = searchSchema.extend({
  vendorId: z.coerce.number().int().positive(),
});

export function registerReturnPolicyAdminRoutes(
  app: Express,
  service: ReturnPolicyAdminService = new ReturnPolicyAdminService(new PostgresReturnPolicyAdminStore()),
): void {
  app.get("/api/returns/admin/policies", requirePermission("settings", "view"), async (_req, res) => {
    try {
      return res.json(await service.listOverview());
    } catch (error) {
      return sendError(res, error, "RETURN_POLICY_OVERVIEW_FAILED", "Return policies could not be loaded.");
    }
  });

  app.get("/api/returns/admin/policies/vendors", requirePermission("settings", "view"), async (req, res) => {
    const parsed = searchSchema.safeParse(req.query);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.json({ vendors: await service.searchVendors(parsed.data.search, parsed.data.limit) });
    } catch (error) {
      return sendError(res, error, "RETURN_POLICY_VENDOR_SEARCH_FAILED", "Vendors could not be loaded.");
    }
  });

  app.get("/api/returns/admin/policies/stores", requirePermission("settings", "view"), async (req, res) => {
    const parsed = storeSearchSchema.safeParse(req.query);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.json({ stores: await service.searchStores(parsed.data.vendorId, parsed.data.search, parsed.data.limit) });
    } catch (error) {
      return sendError(res, error, "RETURN_POLICY_STORE_SEARCH_FAILED", "Store connections could not be loaded.");
    }
  });

  app.post("/api/returns/admin/policies/resolve", requirePermission("settings", "view"), async (req, res) => {
    const parsed = resolutionSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.json(await service.resolve(parsed.data));
    } catch (error) {
      return sendError(res, error, "RETURN_POLICY_RESOLUTION_FAILED", "Return policy resolution failed.");
    }
  });

  app.post("/api/returns/admin/policies/versions", requirePermission("settings", "edit"), async (req, res) => {
    const parsed = createPolicySchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey) {
      return res.status(400).json({
        error: { code: "RETURN_POLICY_IDEMPOTENCY_REQUIRED", message: "Idempotency-Key header is required." },
      });
    }
    const actor = readAuditActor(req);
    if (!actor) {
      return res.status(401).json({
        error: { code: "RETURN_POLICY_ACTOR_REQUIRED", message: "An authenticated audit actor is required." },
      });
    }
    try {
      const result = await service.createVersion({ ...parsed.data, idempotencyKey, actor });
      return res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      return sendError(res, error, "RETURN_POLICY_CREATE_FAILED", "Return policy version could not be created.");
    }
  });
}

function readIdempotencyKey(req: Request): string | null {
  const value = req.header("Idempotency-Key")?.trim();
  return value && value.length <= 160 ? value : null;
}

function readAuditActor(req: Request): string | null {
  const value = req.session?.user?.id;
  if (value === undefined || value === null) return null;
  const actor = String(value).trim();
  return actor || null;
}

function sendValidationError(res: Response, error: z.ZodError): Response {
  return res.status(400).json({
    error: {
      code: "RETURN_POLICY_INVALID",
      message: "Return policy request is invalid.",
      context: { issues: error.issues },
    },
  });
}

function sendError(res: Response, error: unknown, fallbackCode: string, fallbackMessage: string): Response {
  if (error instanceof ReturnPolicyAdminError) {
    return res.status(error.status).json({
      error: { code: error.code, message: error.message, context: error.context },
    });
  }
  console.error(JSON.stringify({
    code: fallbackCode,
    message: fallbackMessage,
    context: { error: error instanceof Error ? error.message : String(error) },
  }));
  return res.status(500).json({ error: { code: fallbackCode, message: fallbackMessage } });
}
