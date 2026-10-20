import type { Express, Request, Response } from "express";
import { z } from "zod";
import { supplierReturnListQuerySchema, supplierReturnOptionsQuerySchema, supplierReturnPreviewInputSchema } from "@shared/procurement/supplier-return";
import { requirePermission } from "../../routes/middleware";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { SupplierReturnError } from "./supplier-return.errors";
import { supplierReturnDifferenceReader } from "./supplier-return-difference.service";
import { supplierReturnReviewCommands, SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE } from "./supplier-return-difference.commands";
import { supplierReturnReader } from "./supplier-return.service";
import { supplierReturnCommands, SUPPLIER_RETURN_COMMAND_SCOPE } from "./supplier-return.commands";

const actor = (req: Request): string => {
  // Same identity that requirePermission validates; never substitute a second actor source.
  return req.session?.user?.id ?? "";
};
function input<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new SupplierReturnError("SUPPLIER_RETURN_INPUT_INVALID", "Review the supplier return request fields.", 422);
  return parsed.data;
}
function failure(res: Response, error: unknown) {
  if (error instanceof FinancialCommandError) {
    for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
    return res.status(error.statusCode).json({ error: error.message, details: { code: error.code, ...error.details } });
  }
  if (error instanceof SupplierReturnError || error instanceof CostEvidenceError) {
    return res.status(error.statusCode).json({ error: error.message, details: { code: error.code } });
  }
  console.error(JSON.stringify({ event: "procurement.supplier_return.failed", code: "SUPPLIER_RETURN_OPERATION_FAILED", actorId: actor(res.req), method: res.req.method, route: res.req.route?.path,
    error: error instanceof Error ? { name: error.name, message: error.message } : { name: "UnknownFailure" } }));
  return res.status(500).json({ error: "Unable to verify or complete this supplier return. Retain any submitted request key and retry.",
    details: { code: "SUPPLIER_RETURN_OPERATION_FAILED" } });
}

export function registerSupplierReturnRoutes(app: Express, dependencies = { reader: supplierReturnReader, commands: supplierReturnCommands, differenceReader: supplierReturnDifferenceReader, reviewCommands: supplierReturnReviewCommands }) {
  app.get("/api/supplier-returns/options", requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await dependencies.reader.options(input(supplierReturnOptionsQuerySchema, req.query), actor(req))); }
    catch (error) { failure(res, error); }
  });
  app.get("/api/supplier-returns", requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await dependencies.reader.list(input(supplierReturnListQuerySchema, req.query), actor(req))); }
    catch (error) { failure(res, error); }
  });
  app.get("/api/supplier-returns/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const id = input(z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647)), req.params.id);
      const document = await dependencies.reader.detail(id, actor(req));
      if (!document) throw new SupplierReturnError("SUPPLIER_RETURN_NOT_FOUND", "The supplier return was not found.", 404);
      res.json(document);
    } catch (error) { failure(res, error); }
  });
  app.post("/api/supplier-returns/preview", requirePermission("purchasing", "view"), async (req, res) => {
    try { res.json(await dependencies.reader.preview(input(supplierReturnPreviewInputSchema, req.body), actor(req))); }
    catch (error) { failure(res, error); }
  });
  app.get(SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE.routeTemplate, requirePermission("purchasing", "view"), async (req, res) => {
    try {
      const id = input(z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647)), req.params.id);
      res.json(await dependencies.differenceReader.read(id, actor(req)));
    } catch (error) { failure(res, error); }
  });
  app.post(SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE.routeTemplate, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const id = input(z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().max(2_147_483_647)), req.params.id);
      const descriptor = financialCommandFromRequest(req, { ...SUPPLIER_RETURN_REVIEW_COMMAND_SCOPE, actorId: actor(req) });
      const result = await dependencies.reviewCommands.review(id, req.body, descriptor);
      res.setHeader("Idempotency-Replayed", String(result.replayed));
      res.status(result.httpStatus).json(result.body);
    } catch (error) { failure(res, error); }
  });
  app.post(SUPPLIER_RETURN_COMMAND_SCOPE.routeTemplate, requirePermission("purchasing", "approve"), async (req, res) => {
    try {
      const descriptor = financialCommandFromRequest(req, { ...SUPPLIER_RETURN_COMMAND_SCOPE, actorId: actor(req) });
      const result = await dependencies.commands.record(req.body, descriptor);
      res.setHeader("Idempotency-Replayed", String(result.replayed));
      res.status(result.httpStatus).json(result.body);
    } catch (error) { failure(res, error); }
  });
}
