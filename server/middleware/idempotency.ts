import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { idempotencyKeys } from "@shared/schema";

export function requireIdempotency() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Only apply to state-mutating methods
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      return next();
    }

    const key = req.headers["idempotency-key"] || req.headers["x-idempotency-key"];
    const keyStr = typeof key === 'string' ? key : (Array.isArray(key) ? key[0] : undefined);
    
    // As per UltraReview, Idempotency-Key is added handling at router level,
    // if we put requireIdempotency() it enforces it.
    if (!keyStr) {
      return res.status(400).json({ error: "Idempotency-Key header is required for this mutation" });
    }

    const requestHash = crypto
      .createHash("sha256")
      .update(JSON.stringify(req.body || {}))
      .digest("hex");

    try {
      const existingKey = await db.query.idempotencyKeys.findFirst({
        where: eq(idempotencyKeys.key, keyStr),
      });

      if (existingKey) {
        if (existingKey.requestHash !== requestHash) {
          return res.status(400).json({ error: "Idempotency key mismatch: payload hash differs from original request" });
        }
        if (existingKey.responseBody) {
          // Replay identical response
          return res.status(200).json(existingKey.responseBody);
        } else {
          // It's currently being processed
          return res.status(409).json({ error: "Request already in progress" });
        }
      }

      await db.insert(idempotencyKeys).values({
        key: keyStr,
        requestHash,
        responseBody: null,
      });

      // Intercept the response JSON to persist the result
      const originalJson = res.json.bind(res);
      res.json = (body: any) => {
        // Save to DB asynchronously
        db.update(idempotencyKeys)
          .set({ responseBody: body })
          .where(eq(idempotencyKeys.key, keyStr))
          .execute()
          .catch(console.error);

        return originalJson(body);
      };

      next();
    } catch (err) {
      next(err);
    }
  };
}
