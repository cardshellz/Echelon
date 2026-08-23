import type { Express, Request, Response } from "express";
import { z } from "zod";
import { returnCaseStatuses, returnDispositionTreatments } from "@shared/schema";
import { requirePermission } from "../../../../routes/middleware";
import {
  ReturnCaseAdminError,
  ReturnCaseAdminService,
} from "../../application/return-case-admin.service";
import {
  manualReturnReasonCodes, OpenReturnCaseError, OpenReturnCaseService,
} from "../../application/open-return-case.service";
import {
  ReturnCaseOperationError,
  ReturnCaseOperationService,
} from "../../application/return-case-operations.service";
import { PostgresReturnCaseAdminStore } from "../../infrastructure/return-case.repository";
import { PostgresOpenReturnCaseStore } from "../../infrastructure/open-return-case.repository";
import { PostgresReturnCaseOperationStore } from "../../infrastructure/return-case-operation.repository";

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
const receiptSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(2_000).nullable().default(null),
  lines: z.array(z.object({
    returnCaseItemId: z.number().int().positive().safe(),
    expectedCurrentReceivedQuantity: z.number().int().nonnegative().safe(),
    quantityReceivedNow: z.number().int().positive().safe(),
  }).strict()).min(1).max(200),
}).strict();
const startInspectionSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(160),
  notes: z.string().trim().max(2_000).nullable().default(null),
}).strict();
const completeInspectionSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(160),
  outcome: z.enum(["approved", "rejected"]),
  notes: z.string().trim().max(2_000).nullable().default(null),
}).strict();
const dispositionSchema = z.object({
  idempotencyKey: z.string().trim().min(1).max(160),
  inspectionId: z.number().int().positive().safe().nullable(),
  notes: z.string().trim().max(2_000).nullable().default(null),
  lines: z.array(z.object({
    returnCaseItemId: z.number().int().positive().safe(),
    quantity: z.number().int().positive().safe(),
    treatment: z.enum(returnDispositionTreatments),
    expectedCurrentReceivedQuantity: z.number().int().nonnegative().safe(),
    expectedCurrentDisposedQuantity: z.number().int().nonnegative().safe(),
  }).strict()).min(1).max(200),
}).strict();


export function registerReturnCaseAdminRoutes(
  app: Express,
  service: ReturnCaseAdminService = new ReturnCaseAdminService(new PostgresReturnCaseAdminStore()),
  openService: OpenReturnCaseService = new OpenReturnCaseService(new PostgresOpenReturnCaseStore()),
  operationService: ReturnCaseOperationService = new ReturnCaseOperationService(
    new PostgresReturnCaseOperationStore(),
  ),
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
    const actor = readAuthenticatedActor(req);
    if (!actor) return sendActorRequired(res);
    try {
      const result = await openService.open({
        ...parsed.data,
        actor,
      });
      return res.status(result.replayed ? 200 : 201).json(result);
    } catch (error) {
      return sendError(res, error, "RETURN_CASE_OPEN_FAILED", "Return case could not be opened.");
    }
  });

  app.post(
    "/api/returns/admin/cases/:id/receipt",
    requirePermission("inventory", "adjust"),
    async (req, res) => {
      const parsedCaseId = caseIdSchema.safeParse(req.params.id);
      if (!parsedCaseId.success) return sendValidationError(res, parsedCaseId.error);
      const parsedBody = receiptSchema.safeParse(req.body);
      if (!parsedBody.success) return sendValidationError(res, parsedBody.error);
      const actor = readAuthenticatedActor(req);
      if (!actor) return sendActorRequired(res);
      try {
        const result = await operationService.recordReceipt({
          caseId: parsedCaseId.data,
          ...parsedBody.data,
          actor,
        });
        return res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        return sendError(
          res,
          error,
          "RETURN_CASE_RECEIPT_FAILED",
          "Return receipt could not be recorded.",
        );
      }
    },
  );

  app.post(
    "/api/returns/admin/cases/:id/inspections/start",
    requirePermission("inventory", "adjust"),
    async (req, res) => {
      const parsedCaseId = caseIdSchema.safeParse(req.params.id);
      if (!parsedCaseId.success) return sendValidationError(res, parsedCaseId.error);
      const parsedBody = startInspectionSchema.safeParse(req.body);
      if (!parsedBody.success) return sendValidationError(res, parsedBody.error);
      const actor = readAuthenticatedActor(req);
      if (!actor) return sendActorRequired(res);
      try {
        const result = await operationService.startInspection({
          caseId: parsedCaseId.data,
          ...parsedBody.data,
          actor,
        });
        return res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        return sendError(
          res,
          error,
          "RETURN_CASE_INSPECTION_START_FAILED",
          "Return inspection could not be started.",
        );
      }
    },
  );

  app.post(
    "/api/returns/admin/cases/:id/inspections/:inspectionId/complete",
    requirePermission("inventory", "adjust"),
    async (req, res) => {
      const parsedCaseId = caseIdSchema.safeParse(req.params.id);
      if (!parsedCaseId.success) return sendValidationError(res, parsedCaseId.error);
      const parsedInspectionId = caseIdSchema.safeParse(req.params.inspectionId);
      if (!parsedInspectionId.success) return sendValidationError(res, parsedInspectionId.error);
      const parsedBody = completeInspectionSchema.safeParse(req.body);
      if (!parsedBody.success) return sendValidationError(res, parsedBody.error);
      const actor = readAuthenticatedActor(req);
      if (!actor) return sendActorRequired(res);
      try {
        const result = await operationService.completeInspection({
          caseId: parsedCaseId.data,
          inspectionId: parsedInspectionId.data,
          ...parsedBody.data,
          actor,
        });
        return res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        return sendError(
          res,
          error,
          "RETURN_CASE_INSPECTION_COMPLETE_FAILED",
          "Return inspection could not be completed.",
        );
      }
    },
  );

  app.post(
    "/api/returns/admin/cases/:id/dispositions",
    requirePermission("inventory", "adjust"),
    async (req, res) => {
      const parsedCaseId = caseIdSchema.safeParse(req.params.id);
      if (!parsedCaseId.success) return sendValidationError(res, parsedCaseId.error);
      const parsedBody = dispositionSchema.safeParse(req.body);
      if (!parsedBody.success) return sendValidationError(res, parsedBody.error);
      const actor = readAuthenticatedActor(req);
      if (!actor) return sendActorRequired(res);
      try {
        const result = await operationService.recordDisposition({
          caseId: parsedCaseId.data,
          ...parsedBody.data,
          actor,
        });
        return res.status(result.replayed ? 200 : 201).json(result);
      } catch (error) {
        return sendError(
          res,
          error,
          "RETURN_CASE_DISPOSITION_FAILED",
          "Return item disposition could not be recorded.",
        );
      }
    },
  );
}

function readAuthenticatedActor(req: Request): string | null {
  const actorId = req.session.user?.id;
  if (actorId === null || actorId === undefined || String(actorId).trim() === "") return null;
  return `user:${String(actorId)}`;
}

function sendActorRequired(res: Response): Response {
  return res.status(401).json({
    error: { code: "RETURN_CASE_ACTOR_REQUIRED", message: "An authenticated admin is required." },
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
  if (
    error instanceof ReturnCaseAdminError
    || error instanceof OpenReturnCaseError
    || error instanceof ReturnCaseOperationError
  ) {
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
