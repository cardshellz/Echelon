import { Request, Response, NextFunction } from "express";
import { db } from "../db";
import { idempotencyKeys } from "@shared/schema";
import { and, eq, isNull } from "drizzle-orm";
import crypto from "crypto";

export const IDEMPOTENCY_IN_PROGRESS_LEASE_MS = 2 * 60 * 1000;
export const IDEMPOTENCY_COMPLETED_TTL_MS = 24 * 60 * 60 * 1000;

interface IdempotencyEnvelope {
  __idempotencyEnvelope: 1;
  statusCode: number;
  body: unknown;
}

function isIdempotencyEnvelope(value: unknown): value is IdempotencyEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Record<string, unknown>).__idempotencyEnvelope === 1 &&
    typeof (value as Record<string, unknown>).statusCode === "number"
  );
}

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    const normalized: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      normalized[k] = canonicalizeValue(v);
    }
    return normalized;
  }
  return value;
}

export function computeIdempotencyRequestHash(req: Pick<Request, "method" | "baseUrl" | "path" | "originalUrl" | "params" | "body"> & { session?: any }): string {
  const actorId = String(req.session?.user?.id ?? "anonymous");
  const method = String(req.method || "POST").toUpperCase();
  const rawPath = `${req.baseUrl || ""}${req.path || (req.originalUrl ? req.originalUrl.split("?")[0] : "")}`;
  const path = rawPath.replace(/\/+$/, "") || "/";
  const payload = canonicalizeValue({
    actorId,
    method,
    path,
    params: req.params ?? {},
    body: req.body ?? {},
  });
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function isUniqueConstraintError(error: any): boolean {
  return (
    error?.code === "23505" ||
    (typeof error?.message === "string" && error.message.toLowerCase().includes("unique constraint"))
  );
}

/**
 * Middleware to enforce idempotency using the `Idempotency-Key` header.
 * Binds each key to the authenticated actor, HTTP method, canonical route path,
 * route params, and request body, preserves the original terminal status code
 * on replay, and releases unclaimed keys on 5xx or aborted requests.
 */
export function requireIdempotency() {
  return async (req: Request, res: Response, next: NextFunction) => {
    const idempotencyKey = req.headers["idempotency-key"] as string;

    if (!idempotencyKey) {
      return res.status(400).json({
        error: "Idempotency-Key header is required for this operation",
      });
    }

    const requestHash = computeIdempotencyRequestHash(req as any);

    const releaseUnclaimedKey = async () => {
      try {
        await db
          .delete(idempotencyKeys)
          .where(and(eq(idempotencyKeys.key, idempotencyKey), isNull(idempotencyKeys.responseBody)));
      } catch (cleanupErr) {
        console.error(`[Idempotency] Failed to release unclaimed key ${idempotencyKey}:`, cleanupErr);
      }
    };

    const evaluateExistingRecord = async (record: typeof idempotencyKeys.$inferSelect): Promise<"reclaimed" | "handled"> => {
      if (record.requestHash !== requestHash) {
        res.status(409).json({
          error: "Conflict: Idempotency-Key is already used with a different request payload",
        });
        return "handled";
      }

      if (record.responseBody === null) {
        const leaseExpired =
          record.expiresAt instanceof Date
            ? record.expiresAt.getTime() <= Date.now()
            : typeof record.expiresAt === "string"
              ? new Date(record.expiresAt).getTime() <= Date.now()
              : false;
        if (leaseExpired) {
          await releaseUnclaimedKey();
          return "reclaimed";
        }
        res.status(409).json({
          error: "Conflict: Request with this Idempotency-Key is currently being processed",
        });
        return "handled";
      }

      res.setHeader("Idempotency-Replayed", "true");
      if (isIdempotencyEnvelope(record.responseBody)) {
        res.status(record.responseBody.statusCode).json(record.responseBody.body);
      } else {
        res.status(200).json(record.responseBody);
      }
      return "handled";
    };

    try {
      const existing = await db
        .select()
        .from(idempotencyKeys)
        .where(eq(idempotencyKeys.key, idempotencyKey))
        .limit(1);

      if (existing.length > 0) {
        const outcome = await evaluateExistingRecord(existing[0]);
        if (outcome === "handled") {
          return;
        }
      }

      try {
        await db.insert(idempotencyKeys).values({
          key: idempotencyKey,
          requestHash,
          responseBody: null,
          expiresAt: new Date(Date.now() + IDEMPOTENCY_IN_PROGRESS_LEASE_MS),
        });
      } catch (insertError: any) {
        if (isUniqueConstraintError(insertError)) {
          const raced = await db
            .select()
            .from(idempotencyKeys)
            .where(eq(idempotencyKeys.key, idempotencyKey))
            .limit(1);
          if (raced.length > 0) {
            const outcome = await evaluateExistingRecord(raced[0]);
            if (outcome === "handled") {
              return;
            }
          }
          return res.status(409).json({
            error: "Conflict: Request with this Idempotency-Key is currently being processed",
          });
        }
        throw insertError;
      }

      const originalJson = res.json;
      let responseFinalized = false;

      res.json = function (body: any): Response {
        res.json = originalJson;
        responseFinalized = true;
        const statusCode = res.statusCode || 200;

        if (statusCode >= 500) {
          void releaseUnclaimedKey().finally(() => {
            originalJson.call(this, body);
          });
          return this;
        }

        const envelope: IdempotencyEnvelope = {
          __idempotencyEnvelope: 1,
          statusCode,
          body,
        };

        void db
          .update(idempotencyKeys)
          .set({
            responseBody: envelope,
            expiresAt: new Date(Date.now() + IDEMPOTENCY_COMPLETED_TTL_MS),
          })
          .where(eq(idempotencyKeys.key, idempotencyKey))
          .catch(async (err) => {
            console.error(`[Idempotency] Failed to save response for key ${idempotencyKey}:`, err);
            await releaseUnclaimedKey();
          })
          .finally(() => {
            originalJson.call(this, body);
          });

        return this;
      };

      const cleanupIfAbortedOr5xx = () => {
        if (!responseFinalized || res.statusCode >= 500) {
          void releaseUnclaimedKey();
        }
      };

      res.once("close", cleanupIfAbortedOr5xx);
      res.once("error", cleanupIfAbortedOr5xx);

      next();
    } catch (error) {
      console.error("[Idempotency] Middleware error:", error);
      return res.status(500).json({ error: "Internal Server Error during idempotency check" });
    }
  };
}
