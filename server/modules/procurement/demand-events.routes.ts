import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import {
  addDemandEventLine,
  createDemandEvent,
  deleteDemandEvent,
  deleteDemandEventLine,
  DemandEventError,
  getDemandEventById,
  getForwardDemandByProduct,
  listDemandEvents,
  replaceDemandEvent,
  updateDemandEvent,
  updateDemandEventLine,
} from "./demand-events.service";
import {
  demandEventConfidenceEnum,
  demandEventStatusEnum,
  demandEventTypeEnum,
} from "@shared/schema/procurement.schema";

const nullableNotes = z.string().trim().max(4000).nullable().optional();

const eventHeaderSchema = z.object({
  name: z.string().trim().min(1).max(255),
  eventType: z.enum(demandEventTypeEnum).default("manual_forecast"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  status: z.enum(demandEventStatusEnum).default("planned"),
  notes: nullableNotes.transform((value) => value ?? null),
});

const lineSchema = z.object({
  productId: z.number().int().positive(),
  productVariantId: z.number().int().positive().nullable().default(null),
  expectedPieces: z.number().int().positive(),
  confidence: z.enum(demandEventConfidenceEnum).default("medium"),
  notes: nullableNotes.transform((value) => value ?? null),
});

const createEventSchema = eventHeaderSchema.extend({
  lines: z.array(lineSchema).min(1).max(500),
});

const replaceEventSchema = createEventSchema.extend({
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

const updateEventSchema = eventHeaderSchema.partial().extend({
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).refine((input) => (
  input.name !== undefined
  || input.eventType !== undefined
  || input.startDate !== undefined
  || input.endDate !== undefined
  || input.status !== undefined
  || input.notes !== undefined
), { message: "At least one event field is required" });

const deleteEventQuerySchema = z.object({
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

const updateLineSchema = z.object({
  expectedPieces: z.number().int().positive().optional(),
  confidence: z.enum(demandEventConfidenceEnum).optional(),
  notes: nullableNotes,
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
}).refine((input) => (
  input.expectedPieces !== undefined || input.confidence !== undefined || input.notes !== undefined
), { message: "At least one line field is required" });

const listQuerySchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export interface DemandEventRouteDependencies {
  getForecastPolicy(): Promise<{
    forwardDemandEnabled: boolean;
    forwardDemandHorizonDays: number;
    forwardDemandConfidenceWeights: {
      high: number;
      medium: number;
      low: number;
    };
  }>;
}

function parseId(value: string, label: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new DemandEventError("DEMAND_EVENT_INVALID_ID", `Invalid ${label}`, 400);
  }
  return id;
}

function actorId(req: Request): string {
  const id = req.session.user?.id?.trim();
  if (!id) throw new DemandEventError("DEMAND_EVENT_ACTOR_REQUIRED", "Authentication required", 401);
  return id;
}

function respondError(res: Response, error: unknown, operation: string): Response {
  if (error instanceof DemandEventError) {
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  }
  if (error instanceof z.ZodError) {
    return res.status(400).json({ error: "Validation failed", code: "DEMAND_EVENT_INVALID_INPUT", details: error.issues });
  }
  console.error(`[DemandEvents] ${operation} failed:`, error);
  return res.status(500).json({ error: `Failed to ${operation} demand event`, code: "DEMAND_EVENT_INTERNAL_ERROR" });
}

export function registerDemandEventRoutes(app: Express, dependencies: DemandEventRouteDependencies) {
  app.get("/api/demand-events", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const query = listQuerySchema.parse(req.query);
      const requestedStatuses = query.status?.split(",").filter(Boolean) ?? [];
      const invalidStatus = requestedStatuses.find((status) => !demandEventStatusEnum.includes(status as typeof demandEventStatusEnum[number]));
      if (invalidStatus) {
        throw new DemandEventError("DEMAND_EVENT_INVALID_STATUS", `Invalid demand event status: ${invalidStatus}`, 400);
      }
      const statuses = requestedStatuses as Array<typeof demandEventStatusEnum[number]>;
      const result = await listDemandEvents({
        status: statuses.length === 0 ? undefined : statuses,
        limit: query.limit,
        offset: query.offset,
      });
      res.json(result);
    } catch (error) {
      respondError(res, error, "list");
    }
  });

  app.get("/api/demand-events/forward-demand", requirePermission("purchasing", "view"), async (_req, res) => {
    try {
      const policy = await dependencies.getForecastPolicy();
      const items = Array.from((await getForwardDemandByProduct({
        horizonDays: policy.forwardDemandHorizonDays,
        confidenceWeights: policy.forwardDemandConfidenceWeights,
      })).values()).sort((a, b) => b.weightedExpectedPieces - a.weightedExpectedPieces);
      res.json({
        enabled: policy.forwardDemandEnabled,
        horizonDays: policy.forwardDemandHorizonDays,
        confidenceWeights: policy.forwardDemandConfidenceWeights,
        items,
        totalProducts: items.length,
      });
    } catch (error) {
      respondError(res, error, "summarize");
    }
  });

  app.get("/api/demand-events/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const event = await getDemandEventById(parseId(req.params.id, "event ID"));
      if (!event) throw new DemandEventError("DEMAND_EVENT_NOT_FOUND", "Demand event not found", 404);
      res.json(event);
    } catch (error) {
      respondError(res, error, "read");
    }
  });

  app.post("/api/demand-events", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const parsed = createEventSchema.parse(req.body);
      const { lines, ...event } = parsed;
      const result = await createDemandEvent({ event, lines }, { actorId: actorId(req) });
      res.status(201).json(result);
    } catch (error) {
      respondError(res, error, "create");
    }
  });

  app.put("/api/demand-events/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const parsed = replaceEventSchema.parse(req.body);
      const { lines, expectedUpdatedAt, ...event } = parsed;
      const result = await replaceDemandEvent(
        parseId(req.params.id, "event ID"),
        { event, lines },
        { actorId: actorId(req), expectedUpdatedAt },
      );
      if (!result) throw new DemandEventError("DEMAND_EVENT_NOT_FOUND", "Demand event not found", 404);
      res.json(result);
    } catch (error) {
      respondError(res, error, "replace");
    }
  });

  app.patch("/api/demand-events/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const parsed = updateEventSchema.parse(req.body);
      const { expectedUpdatedAt, ...updates } = parsed;
      const result = await updateDemandEvent(
        parseId(req.params.id, "event ID"),
        updates,
        { actorId: actorId(req), expectedUpdatedAt },
      );
      if (!result) throw new DemandEventError("DEMAND_EVENT_NOT_FOUND", "Demand event not found", 404);
      res.json(result);
    } catch (error) {
      respondError(res, error, "update");
    }
  });

  app.delete("/api/demand-events/:id", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const query = deleteEventQuerySchema.parse(req.query);
      const deleted = await deleteDemandEvent(
        parseId(req.params.id, "event ID"),
        { actorId: actorId(req), expectedUpdatedAt: query.expectedUpdatedAt },
      );
      if (!deleted) throw new DemandEventError("DEMAND_EVENT_NOT_FOUND", "Demand event not found", 404);
      res.json({ deleted: true });
    } catch (error) {
      respondError(res, error, "delete");
    }
  });

  app.post("/api/demand-events/:id/lines", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const line = await addDemandEventLine(
        parseId(req.params.id, "event ID"),
        lineSchema.parse(req.body),
        { actorId: actorId(req) },
      );
      res.status(201).json(line);
    } catch (error) {
      respondError(res, error, "add line to");
    }
  });

  app.patch("/api/demand-event-lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const parsed = updateLineSchema.parse(req.body);
      const { expectedUpdatedAt, ...updates } = parsed;
      const result = await updateDemandEventLine(
        parseId(req.params.lineId, "line ID"),
        updates,
        { actorId: actorId(req), expectedUpdatedAt },
      );
      if (!result) throw new DemandEventError("DEMAND_EVENT_LINE_NOT_FOUND", "Demand event line not found", 404);
      res.json(result);
    } catch (error) {
      respondError(res, error, "update line on");
    }
  });

  app.delete("/api/demand-event-lines/:lineId", requirePermission("purchasing", "edit"), async (req, res) => {
    try {
      const deleted = await deleteDemandEventLine(
        parseId(req.params.lineId, "line ID"),
        { actorId: actorId(req) },
      );
      if (!deleted) throw new DemandEventError("DEMAND_EVENT_LINE_NOT_FOUND", "Demand event line not found", 404);
      res.json({ deleted: true });
    } catch (error) {
      respondError(res, error, "delete line from");
    }
  });
}
