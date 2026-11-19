import type { Express, Request, Response } from "express";
import { requirePermission } from "../../../../routes/middleware";
import { LISTING_END_OPS_ERROR_CODES } from "../../../../../shared/dropship/listing-end-ops";
import type { DropshipListingEndOpsService } from "../../application/dropship-listing-end-ops-service";
import { DropshipError } from "../../domain/errors";
import { createDropshipListingEndOpsServiceFromEnv } from "../../infrastructure/dropship-listing-end-ops.factory";
import { logDropshipRouteFailure } from "./dropship-route-failure-log";

/**
 * Card Shellz staff's routes for the eBay listings Card Shellz could not end (PR C, PLAN-C v4.1 §10), beside the
 * listing push ops routes they mirror (dropship-admin-listing-push-ops.routes.ts). Routes orchestrate only: they read
 * the query, the body's fields, the key (body first, then the `Idempotency-Key` header) and the session's actor, and
 * the service validates and decides. Viewing needs `dropship:view`; Retry and Mark resolved need
 * `dropship:manage_operations`.
 */

const LOG_SCOPE = "dropship.listing_end_ops";
const CODES = LISTING_END_OPS_ERROR_CODES;
/** An end request id in the path: a positive bigint that is a safe integer (no exponent, sign or leading zero). */
const END_REQUEST_ID_PATTERN = /^[1-9][0-9]{0,15}$/;

type SessionUser = { id: string };

export function registerDropshipAdminListingEndOpsRoutes(
  app: Express,
  service: DropshipListingEndOpsService = createDropshipListingEndOpsServiceFromEnv(),
): void {
  app.get("/api/dropship/admin/listing-ends", requirePermission("dropship", "view"), async (req, res) => {
    try {
      return res.json(await service.list({
        state: optionalQueryString(req.query.state),
        vendorId: optionalQueryNumber(req.query.vendorId),
        storeConnectionId: optionalQueryNumber(req.query.storeConnectionId),
        page: optionalQueryNumber(req.query.page),
        limit: optionalQueryNumber(req.query.limit),
      }));
    } catch (error) {
      return sendListingEndOpsError(req, res, error);
    }
  });

  app.post("/api/dropship/admin/listing-ends/:id/retry", requirePermission("dropship", "manage_operations"), async (req, res) => {
    try {
      return res.json(await service.retry({
        endRequestId: endRequestIdParam(req.params.id),
        // An empty optional reason is no reason (the page sends what the field holds).
        reason: typeof req.body?.reason === "string" && req.body.reason.trim() === "" ? undefined : req.body?.reason,
        idempotencyKey: idempotencyKeyOf(req),
        actor: adminActor(req),
      }));
    } catch (error) {
      return sendListingEndOpsError(req, res, error);
    }
  });

  app.post("/api/dropship/admin/listing-ends/:id/resolve", requirePermission("dropship", "manage_operations"), async (req, res) => {
    try {
      return res.json(await service.resolve({
        endRequestId: endRequestIdParam(req.params.id),
        outcome: req.body?.outcome,
        reason: req.body?.reason,
        idempotencyKey: idempotencyKeyOf(req),
        actor: adminActor(req),
      }));
    } catch (error) {
      return sendListingEndOpsError(req, res, error);
    }
  });
}

export function statusForListingEndOpsError(code: string): number {
  switch (code) {
    case CODES.listInvalidInput:
    case CODES.actionInvalidInput:
      return 400;
    case CODES.notFound:
      return 404;
    case CODES.staffStateInvalid:
    case CODES.staffKeyReused:
    case CODES.quantityRecoveryRequired:
      return 409;
    case CODES.staffBusy:
      return 503;
    default:
      return 500;
  }
}

function sendListingEndOpsError(req: Request, res: Response, error: unknown): Response {
  const status = error instanceof DropshipError ? statusForListingEndOpsError(error.code) : 500;
  const code = error instanceof DropshipError && status !== 500 ? error.code : "DROPSHIP_LISTING_END_OPS_INTERNAL_ERROR";
  logDropshipRouteFailure(LOG_SCOPE, req, { status, code, storeConnectionId: null, error, actorId: sessionUser(req)?.id ?? null });
  if (status === 500) {
    return res.status(500).json({ error: { code, message: "The listing end request could not be handled." } });
  }
  const dropshipError = error as DropshipError;
  return res.status(status).json({ error: { code, message: dropshipError.message, context: dropshipError.context } });
}

function endRequestIdParam(value: string | undefined): number | undefined {
  // Anything else fails the service's validation (400) rather than reaching the database.
  return typeof value === "string" && END_REQUEST_ID_PATTERN.test(value) ? Number(value) : undefined;
}

function idempotencyKeyOf(req: Request): unknown {
  const bodyKey = req.body?.idempotencyKey;
  if (bodyKey !== undefined) return bodyKey;
  return req.header("Idempotency-Key") ?? req.header("X-Idempotency-Key");
}

function adminActor(req: Request): { actorType: "admin"; actorId: string | undefined } {
  return { actorType: "admin", actorId: sessionUser(req)?.id };
}

function sessionUser(req: Request): SessionUser | null {
  const candidate = req.session?.user as SessionUser | undefined;
  return candidate?.id ? candidate : null;
}

function optionalQueryString(value: unknown): string | undefined {
  if (Array.isArray(value)) return optionalQueryString(value[0]);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A query number as text → Number; text that is not a number becomes NaN, which the service refuses (400). */
function optionalQueryNumber(value: unknown): number | undefined {
  const text = optionalQueryString(value);
  return text === undefined ? undefined : Number(text);
}
