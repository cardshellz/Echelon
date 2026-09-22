import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import {
  returnPortalPreviewStateSchema, returnPreviewLookupInputSchema, returnPreviewOrderSchema,
  returnPreviewReviewInputSchema, returnPreviewReviewSchema,
} from "@shared/returns/customer-return-preview.contract";
import {
  CustomerReturnPreviewAccessError, requireCustomerReturnPreviewAccess,
  type CustomerReturnPreviewIdentityReader,
} from "../../application/customer-return-preview-access";
import { CustomerReturnPreviewError, CustomerReturnPreviewService } from "../../application/customer-return-preview.service";
import { readCurrentPreviewIdentity } from "../../infrastructure/customer-return-preview-identity";

const API_ROOT = "/api/returns/admin/portal-preview";
const PAGE_ROOT = "/returns/portal-preview";
type Operation = "state" | "order" | "review" | "page" | "unknown";
type PreviewService = Pick<CustomerReturnPreviewService, "getState" | "lookup" | "review">;
export interface CustomerReturnPreviewRouteDependencies {
  service?: PreviewService;
  identityReader?: CustomerReturnPreviewIdentityReader;
  reportFailure?: (event: { operation: Operation; code: string }) => void;
}

/** Synthetic, effect-free preview. This registration does not expose customer intake. */
export function registerCustomerReturnPreviewRoutes(app: Express, dependencies: CustomerReturnPreviewRouteDependencies = {}): void {
  const service = dependencies.service ?? new CustomerReturnPreviewService();

  function report(operation: Operation, code: string): void {
    const event = { operation, code };
    try {
      if (dependencies.reportFailure) dependencies.reportFailure(event);
      else console.error(JSON.stringify(event));
    } catch {
      console.error(JSON.stringify({ operation, code: "RETURN_PREVIEW_REPORTING_FAILED" }));
    }
  }

  function sendError(res: Response, operation: Operation, error: unknown): void {
    const known = error instanceof CustomerReturnPreviewAccessError || error instanceof CustomerReturnPreviewError;
    const code = known ? error.code : "RETURN_PREVIEW_UNAVAILABLE";
    const status = known ? error.status : 503;
    const message = known ? error.message : "The admin preview is temporarily unavailable.";
    report(operation, code);
    res.status(status).json({ error: { code, message } });
  }

  const gate = (operation: Operation) => async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    privateResponse(res);
    try {
      // Only the staff session ID identifies the actor. Headers, request bodies,
      // vendor/customer sessions and cached role/active strings grant no authority.
      const session = req.session as { user?: { id?: unknown } } | undefined;
      await requireCustomerReturnPreviewAccess(session?.user?.id, dependencies.identityReader ?? readCurrentPreviewIdentity);
      next();
    } catch (error) { sendError(res, operation === "unknown" ? apiOperation(req.path) : operation, error); }
  };

  // A global JSON parser runs before application routes. Its failures must still
  // receive private, sanitized responses instead of leaking its raw error body.
  app.use([API_ROOT, PAGE_ROOT], (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    privateResponse(res);
    const operation: Operation = req.baseUrl === PAGE_ROOT ? "page" : "unknown";
    const type = error && typeof error === "object" && "type" in error ? error.type : null;
    if (type === "entity.parse.failed" || type === "entity.too.large") {
      const code = type === "entity.too.large" ? "RETURN_PREVIEW_REQUEST_TOO_LARGE" : "RETURN_PREVIEW_INPUT_INVALID";
      report(operation, code);
      res.status(type === "entity.too.large" ? 413 : 400).json({ error: { code, message: "The preview request is invalid." } });
      return;
    }
    sendError(res, operation, error);
  });
  app.use(API_ROOT, gate("unknown"));
  app.use(PAGE_ROOT, gate("page"));
  app.use(PAGE_ROOT, (req, res, next) => {
    if (req.method === "GET" || req.method === "HEAD") { next(); return; }
    res.setHeader("Allow", "GET, HEAD");
    res.status(405).json({ error: { code: "RETURN_PREVIEW_METHOD_NOT_ALLOWED", message: "This preview page method is not available." } });
  });

  const handle = (operation: Operation, run: (req: Request) => unknown) => (req: Request, res: Response): void => {
    try {
      if (Object.keys(req.query).length > 0) {
        report(operation, "RETURN_PREVIEW_INPUT_INVALID");
        res.status(400).json({ error: { code: "RETURN_PREVIEW_INPUT_INVALID", message: "Query parameters are not accepted." } });
        return;
      }
      res.json(run(req));
    } catch (error) {
      if (error instanceof z.ZodError) {
        // Input schemas are checked separately below; output failure is unavailable.
        sendError(res, operation, new Error("Invalid preview service response"));
      } else sendError(res, operation, error);
    }
  };
  const input = <T extends z.ZodTypeAny>(schema: T, raw: unknown): z.output<T> => {
    const result = schema.safeParse(raw);
    if (!result.success) throw new CustomerReturnPreviewError("RETURN_PREVIEW_INPUT_INVALID", "The preview request is invalid.", 400);
    return result.data;
  };

  app.get(API_ROOT, handle("state", () => returnPortalPreviewStateSchema.parse(service.getState())));
  app.post(`${API_ROOT}/order`, handle("order", req => returnPreviewOrderSchema.parse(service.lookup(input(returnPreviewLookupInputSchema, req.body)))));
  app.post(`${API_ROOT}/review`, handle("review", req => returnPreviewReviewSchema.parse(service.review(input(returnPreviewReviewInputSchema, req.body)))));

  app.all([API_ROOT, `${API_ROOT}/order`, `${API_ROOT}/review`], (req, res) => {
    const state = req.path.replace(/\/$/, "") === API_ROOT;
    res.setHeader("Allow", state ? "GET, HEAD" : "POST");
    res.status(405).json({ error: { code: "RETURN_PREVIEW_METHOD_NOT_ALLOWED", message: "This preview method is not available." } });
  });
  app.use(API_ROOT, (_req, res) => {
    res.status(404).json({ error: { code: "RETURN_PREVIEW_NOT_FOUND", message: "This preview endpoint is not available." } });
  });
}

function privateResponse(res: Response): void {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.vary("Cookie");
}

function apiOperation(path: string): Operation {
  const endpoint = path.replace(/\/$/, "");
  if (endpoint === "") return "state";
  if (endpoint === "/order") return "order";
  if (endpoint === "/review") return "review";
  return "unknown";
}
