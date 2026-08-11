import type { Express, Response } from "express";
import { z } from "zod";
import { returnCaseStatuses } from "@shared/schema";
import { requirePermission } from "../../../../routes/middleware";
import {
  ReturnCaseAdminError,
  ReturnCaseAdminService,
} from "../../application/return-case-admin.service";
import {
  manualReturnReasonCodes, OpenReturnCaseError, OpenReturnCaseService,
} from "../../application/open-return-case.service";
import { PostgresReturnCaseAdminStore } from "../../infrastructure/return-case.repository";
import { PostgresOpenReturnCaseStore } from "../../infrastructure/open-return-case.repository";

const listQuerySchema = z.object({
  search: z.string().trim().max(160).optional().transform((value) => value || null),
  caseStatus: z.enum(returnCaseStatuses).optional().transform((value) => value ?? null),
  sourceProvider: z.string().trim().min(1).max(40).optional().transform((value) => value ?? null),
  channelId: z.coerce.number().int().positive().safe().optional().transform((value) => value ?? null),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});

const caseIdSchema = z.coerce.number().int().positive().safe();
const sourceOrderSearchSchema = z.object({
  search: z.string().trim().max(160).default(""),
  channelId: z.coerce.number().int().positive().safe().optional().transform((value) => value ?? null),
  page: z.coerce.number().int().positive().max(1_000_000).default(1),
  limit: z.coerce.number().int().positive().max(100).default(25),
});
const openCaseSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(160),
  omsOrderId: z.number().int().positive().safe(),
  wmsOrderId: z.number().int().positive().safe(),
  reasonCode: z.enum(manualReturnReasonCodes),
  notes: z.string().trim().max(2_000).nullable().default(null),
  items: z.array(z.object({
    wmsOrderItemId: z.number().int().positive().safe(),
    quantity: z.number().int().positive().safe(),
  }).strict()).min(1).max(200),
}).strict();

export function registerReturnCaseAdminRoutes(
  app: Express,
  service: ReturnCaseAdminService = new ReturnCaseAdminService(new PostgresReturnCaseAdminStore()),
  openService: OpenReturnCaseService = new OpenReturnCaseService(new PostgresOpenReturnCaseStore()),
): void {
  app.get("/api/returns/admin/cases", requirePermission("inventory", "view"), async (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.json(await service.list(parsed.data));
    } catch (error) {
      return sendError(res, error, "RETURN_CASE_LIST_FAILED", "Return cases could not be loaded.");
    }
  });

  app.get("/api/returns/admin/cases/:id", requirePermission("inventory", "view"), async (req, res) => {
    const parsed = caseIdSchema.safeParse(req.params.id);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.json(await service.getById(parsed.data));
    } catch (error) {
      return sendError(res, error, "RETURN_CASE_DETAIL_FAILED", "Return case details could not be loaded.");
    }
  });

  app.get("/api/returns/admin/source-orders", requirePermission("inventory", "view"), async (req, res) => {
    const parsed = sourceOrderSearchSchema.safeParse(req.query);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.json(await openService.searchSourceOrders(parsed.data));
    } catch (error) {
      return sendError(res, error, "RETURN_SOURCE_ORDER_SEARCH_FAILED", "Source orders could not be loaded.");
    }
  });

  app.get("/api/returns/admin/source-orders/:id", requirePermission("inventory", "view"), async (req, res) => {
    const parsed = caseIdSchema.safeParse(req.params.id);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    try {
      return res.json(await openService.getSourceOrder(parsed.data));
    } catch (error) {
      return sendError(res, error, "RETURN_SOURCE_ORDER_DETAIL_FAILED", "Source order details could not be loaded.");
    }
  });

  app.post("/api/returns/admin/cases", requirePermission("inventory", "edit"), async (req, res) => {
    const parsed = openCaseSchema.safeParse(req.body);
    if (!parsed.success) return sendValidationError(res, parsed.error);
    const actorId = req.session.user?.id;
    if (actorId === null || actorId === undefined || String(actorId).trim() === "") {
      return res.status(401).json({
        error: { code: "RETURN_CASE_ACTOR_REQUIRED", message: "An authenticated admin is required." },
      });
    }
    try {
      const result = await openService.open({
        ...parsed.data,
        actor: `user:${String(actorId)}`,
      });
      return res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      return sendError(res, error, "RETURN_CASE_OPEN_FAILED", "Return case could not be opened.");
    }
  });
}

function sendValidationError(res: Response, error: z.ZodError): Response {
  return res.status(400).json({
    error: {
      code: "RETURN_CASE_QUERY_INVALID",
      message: "Return case request is invalid.",
      context: { issues: error.issues },
    },
  });
}

function sendError(res: Response, error: unknown, fallbackCode: string, fallbackMessage: string): Response {
  if (error instanceof ReturnCaseAdminError || error instanceof OpenReturnCaseError) {
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
