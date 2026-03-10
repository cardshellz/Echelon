import type { Request, Response, NextFunction } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { hasPermission } from "../rbac";
import { broadcastOrdersUpdated } from "../websocket";
import multer from "multer";

export const upload = multer({ storage: multer.memoryStorage() });

export function requirePermission(resource: string, action: string) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (!req.session.user) {
      return res.status(401).json({ error: "Authentication required" });
    }
    
    const allowed = await hasPermission(req.session.user.id, resource, action);
    if (!allowed) {
      return res.status(403).json({ error: `Permission denied: ${resource}:${action}` });
    }
    
    next();
  };
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.user) {
    return res.status(401).json({ error: "Authentication required" });
  }
  next();
}

export function requireInternalApiKey(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  const key = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!key || key !== process.env.INTERNAL_API_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

export async function syncPickQueueForSku(sku: string) {
  try {
    const freshLocation = await storage.getBinLocationFromInventoryBySku(sku);
    if (!freshLocation) return;

    const result = await db.execute(sql`
      SELECT oi.id, oi.location, oi.zone
      FROM order_items oi
      JOIN orders o ON oi.order_id = o.id
      WHERE UPPER(oi.sku) = ${sku.toUpperCase()}
        AND oi.status = 'pending'
        AND o.warehouse_status IN ('ready', 'in_progress')
    `);

    let updated = 0;
    for (const row of result.rows as any[]) {
      if (row.location !== freshLocation.location || row.zone !== freshLocation.zone) {
        await storage.updateOrderItemLocation(
          row.id,
          freshLocation.location,
          freshLocation.zone,
          freshLocation.barcode || null,
          freshLocation.imageUrl || null
        );
        updated++;
      }
    }

    if (updated > 0) {
      broadcastOrdersUpdated();
      console.log(`[Queue Sync] Updated ${updated} pending items for SKU ${sku} → ${freshLocation.location}`);
    }
  } catch (err: any) {
    console.warn(`[Queue Sync] Failed to sync SKU ${sku}:`, err?.message);
  }
}
