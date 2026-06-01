/**
 * Forward Demand Events REST API — Phase 7A
 *
 * CRUD for demand events that feed into the purchasing recommendation engine's
 * reorder math. Events represent known future demand (product drops, preorders,
 * promotions, wholesale commitments, seasonal forecasts).
 */

import type { Express } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import {
  listDemandEvents,
  getDemandEventById,
  createDemandEvent,
  updateDemandEvent,
  deleteDemandEvent,
  addDemandEventLine,
  updateDemandEventLine,
  deleteDemandEventLine,
  getForwardDemandByProduct,
} from "./demand-events.service";
import {
  demandEventTypeEnum,
  demandEventStatusEnum,
  demandEventConfidenceEnum,
} from "@shared/schema/procurement.schema";

const createEventSchema = z.object({
  name: z.string().min(1).max(255),
  eventType: z.enum(demandEventTypeEnum).default("manual_forecast"),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(demandEventStatusEnum).default("planned"),
  notes: z.string().nullable().optional(),
  lines: z.array(z.object({
    productId: z.number().int().positive(),
    productVariantId: z.number().int().positive().nullable().optional(),
    expectedPieces: z.number().int().positive(),
    confidence: z.enum(demandEventConfidenceEnum).default("medium"),
    notes: z.string().nullable().optional(),
  })).default([]),
});

const updateEventSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  eventType: z.enum(demandEventTypeEnum).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  status: z.enum(demandEventStatusEnum).optional(),
  notes: z.string().nullable().optional(),
});

const addLineSchema = z.object({
  productId: z.number().int().positive(),
  productVariantId: z.number().int().positive().nullable().optional(),
  expectedPieces: z.number().int().positive(),
  confidence: z.enum(demandEventConfidenceEnum).default("medium"),
  notes: z.string().nullable().optional(),
});

const updateLineSchema = z.object({
  expectedPieces: z.number().int().positive().optional(),
  confidence: z.enum(demandEventConfidenceEnum).optional(),
  notes: z.string().nullable().optional(),
});

export function registerDemandEventRoutes(app: Express) {
  // ── List demand events ──────────────────────────────────────────
  app.get("/api/demand-events", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const status = req.query.status as string | undefined;
      const limit = Number(req.query.limit) || 50;
      const offset = Number(req.query.offset) || 0;

      const statusArr = status?.split(",").filter(Boolean) as any[] | undefined;
      const result = await listDemandEvents({
        status: statusArr && statusArr.length === 1 ? statusArr[0] : statusArr,
        limit,
        offset,
      });
      res.json(result);
    } catch (err: any) {
      console.error("[DemandEvents] list failed:", err);
      res.status(500).json({ error: "Failed to list demand events" });
    }
  });

  // ── Forward demand summary (engine preview) ─────────────────────
  // Registered before :id route so Express doesn't match "forward-demand" as an id.
  app.get("/api/demand-events/forward-demand", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const horizonDays = Math.max(1, Math.min(365, Number(req.query.horizonDays) || 60));
      const demandMap = await getForwardDemandByProduct(horizonDays);
      const items = Array.from(demandMap.values()).sort(
        (a, b) => b.totalExpectedPieces - a.totalExpectedPieces,
      );
      res.json({ horizonDays, items, totalProducts: items.length });
    } catch (err: any) {
      console.error("[DemandEvents] forward-demand failed:", err);
      res.status(500).json({ error: "Failed to compute forward demand" });
    }
  });

  // ── Get single event with lines ─────────────────────────────────
  app.get("/api/demand-events/:id", requirePermission("inventory", "view"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid event ID" });
      }
      const event = await getDemandEventById(id);
      if (!event) return res.status(404).json({ error: "Demand event not found" });
      res.json(event);
    } catch (err: any) {
      console.error("[DemandEvents] get failed:", err);
      res.status(500).json({ error: "Failed to get demand event" });
    }
  });

  // ── Create event with lines ─────────────────────────────────────
  app.post("/api/demand-events", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const parsed = createEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      }
      const { lines, ...eventData } = parsed.data;
      const result = await createDemandEvent({ event: eventData as any, lines: lines as any[] });
      res.status(201).json(result);
    } catch (err: any) {
      console.error("[DemandEvents] create failed:", err);
      res.status(500).json({ error: "Failed to create demand event" });
    }
  });

  // ── Update event header ─────────────────────────────────────────
  app.patch("/api/demand-events/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid event ID" });
      }
      const parsed = updateEventSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      }
      const result = await updateDemandEvent(id, parsed.data);
      if (!result) return res.status(404).json({ error: "Demand event not found" });
      res.json(result);
    } catch (err: any) {
      console.error("[DemandEvents] update failed:", err);
      res.status(500).json({ error: "Failed to update demand event" });
    }
  });

  // ── Delete event (cascades lines) ───────────────────────────────
  app.delete("/api/demand-events/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid event ID" });
      }
      const deleted = await deleteDemandEvent(id);
      if (!deleted) return res.status(404).json({ error: "Demand event not found" });
      res.json({ deleted: true });
    } catch (err: any) {
      console.error("[DemandEvents] delete failed:", err);
      res.status(500).json({ error: "Failed to delete demand event" });
    }
  });

  // ── Add line to event ───────────────────────────────────────────
  app.post("/api/demand-events/:id/lines", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const eventId = Number(req.params.id);
      if (!Number.isFinite(eventId) || eventId <= 0) {
        return res.status(400).json({ error: "Invalid event ID" });
      }
      const parsed = addLineSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      }
      const existing = await getDemandEventById(eventId);
      if (!existing) return res.status(404).json({ error: "Demand event not found" });

      const line = await addDemandEventLine(eventId, parsed.data as any);
      res.status(201).json(line);
    } catch (err: any) {
      console.error("[DemandEvents] addLine failed:", err);
      res.status(500).json({ error: "Failed to add demand event line" });
    }
  });

  // ── Update line ─────────────────────────────────────────────────
  app.patch("/api/demand-event-lines/:lineId", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const lineId = Number(req.params.lineId);
      if (!Number.isFinite(lineId) || lineId <= 0) {
        return res.status(400).json({ error: "Invalid line ID" });
      }
      const parsed = updateLineSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", details: parsed.error.issues });
      }
      const result = await updateDemandEventLine(lineId, parsed.data);
      if (!result) return res.status(404).json({ error: "Demand event line not found" });
      res.json(result);
    } catch (err: any) {
      console.error("[DemandEvents] updateLine failed:", err);
      res.status(500).json({ error: "Failed to update demand event line" });
    }
  });

  // ── Delete line ─────────────────────────────────────────────────
  app.delete("/api/demand-event-lines/:lineId", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const lineId = Number(req.params.lineId);
      if (!Number.isFinite(lineId) || lineId <= 0) {
        return res.status(400).json({ error: "Invalid line ID" });
      }
      const deleted = await deleteDemandEventLine(lineId);
      if (!deleted) return res.status(404).json({ error: "Demand event line not found" });
      res.json({ deleted: true });
    } catch (err: any) {
      console.error("[DemandEvents] deleteLine failed:", err);
      res.status(500).json({ error: "Failed to delete demand event line" });
    }
  });

}
