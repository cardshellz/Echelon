import type { Express } from "express";
import { eq, and } from "drizzle-orm";
import { db } from "../../db";
import { warehousePickZones, warehouses } from "@shared/schema";
import { requireAuth, requirePermission } from "../../routes/middleware";

/**
 * Pick Zones — read-only admin API (infrastructure-only PR).
 *
 * Write operations (POST/PUT/DELETE) and per-location assignment will be added
 * in a follow-up PR along with editable Pick Zones admin UI.
 */
export function registerPickZoneRoutes(app: Express) {
  // List all pick zones, optionally filtered by warehouse
  app.get("/api/warehouse-pick-zones", requireAuth, async (req, res) => {
    try {
      const warehouseIdParam = req.query.warehouseId;
      const warehouseId =
        typeof warehouseIdParam === "string" && warehouseIdParam.trim().length > 0
          ? Number.parseInt(warehouseIdParam, 10)
          : null;

      let rows;
      if (warehouseId !== null && Number.isFinite(warehouseId)) {
        rows = await db
          .select()
          .from(warehousePickZones)
          .where(eq(warehousePickZones.warehouseId, warehouseId));
      } else {
        rows = await db.select().from(warehousePickZones);
      }

      // Attach warehouse display info for convenience
      const warehouseIds = Array.from(new Set(rows.map((r) => r.warehouseId)));
      const warehouseRows = warehouseIds.length
        ? await db.select().from(warehouses)
        : [];
      const warehouseMap = new Map(warehouseRows.map((w) => [w.id, w]));

      const result = rows.map((z) => ({
        ...z,
        warehouseCode: warehouseMap.get(z.warehouseId)?.code ?? null,
        warehouseName: warehouseMap.get(z.warehouseId)?.name ?? null,
      }));

      // Default sort: warehouse, then priority asc, then code asc
      result.sort(
        (a, b) =>
          (a.warehouseId ?? 0) - (b.warehouseId ?? 0) ||
          (a.priority ?? 100) - (b.priority ?? 100) ||
          String(a.code).localeCompare(String(b.code))
      );

      res.json(result);
    } catch (err: any) {
      console.error("Error listing pick zones:", err);
      res.status(500).json({ error: "Failed to fetch pick zones" });
    }
  });

  // Get a single pick zone by id
  app.get("/api/warehouse-pick-zones/:id", requireAuth, async (req, res) => {
    try {
      const id = Number.parseInt(req.params.id, 10);
      if (!Number.isFinite(id)) {
        return res.status(400).json({ error: "Invalid id" });
      }

      const [row] = await db
        .select()
        .from(warehousePickZones)
        .where(eq(warehousePickZones.id, id))
        .limit(1);

      if (!row) {
        return res.status(404).json({ error: "Pick zone not found" });
      }

      res.json(row);
    } catch (err: any) {
      console.error("Error fetching pick zone:", err);
      res.status(500).json({ error: "Failed to fetch pick zone" });
    }
  });
}
