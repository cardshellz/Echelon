import type { Express, Request, Response } from "express";
import { z } from "zod";
import { requirePermission } from "../../routes/middleware";
import { FinancialCommandError } from "../../platform/commands/transactional-command.service";
import { financialCommandFromRequest } from "../../platform/commands/http-command";
import { supplierCreditIdSchema, type SupplierCreditCommand } from "@shared/procurement/supplier-credit";
import { supplierCreditReader } from "./supplier-credit.service";
import { supplierCreditCommands } from "./supplier-credit.commands";
import { SupplierCreditError } from "./supplier-credit.repository";
const actor = (req: Request): string => String((req as Request & {
  user?: {
    id: string;
  };
  session?: {
    user?: {
      id: string;
    };
  };
}).user?.id ?? (req as Request & {
  session?: {
    user?: {
      id: string;
    };
  };
}).session?.user?.id ?? "");
const id = (raw: unknown) => supplierCreditIdSchema.parse(typeof raw === "string" && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw);
function failure(res: Response, error: unknown) {
  if (error instanceof FinancialCommandError) {
    for (const [name, value] of Object.entries(error.responseHeaders ?? {})) res.setHeader(name, value);
    return res.status(error.statusCode).json({
      error: error.message,
      details: {
        code: error.code,
        ...error.details
      }
    });
  }
  if (error instanceof SupplierCreditError) return res.status(error.statusCode).json({
    error: error.message,
    details: {
      code: error.code
    }
  });
  if (error instanceof z.ZodError) return res.status(422).json({
    error: "Invalid supplier credit request or evidence.",
    details: {
      code: "SUPPLIER_CREDIT_VALIDATION_REQUIRED"
    }
  });
  console.error("Supplier credit operation failed", {
    code: "SUPPLIER_CREDIT_OPERATION_FAILED",
    error
  });
  return res.status(500).json({
    error: "Unable to complete the credit operation. Retain the request key and retry.",
    details: {
      code: "SUPPLIER_CREDIT_OPERATION_FAILED"
    }
  });
}
export function registerSupplierCreditRoutes(app: Express) {
  app.get("/api/supplier-credits", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      res.json(await supplierCreditReader.list(req.query, actor(req)));
    } catch (error) {
      failure(res, error);
    }
  });
  app.get("/api/supplier-credits/:id", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      res.json(await supplierCreditReader.detail(id(req.params.id), actor(req)));
    } catch (error) {
      failure(res, error);
    }
  });
  app.get("/api/vendor-invoices/:id/supplier-credit-options", requirePermission("purchasing", "view"), async (req, res) => {
    try {
      res.json(await supplierCreditReader.options(id(req.params.id), actor(req)));
    } catch (error) {
      failure(res, error);
    }
  });
  const write = (route: string, command: SupplierCreditCommand) => app.post(route, requirePermission("purchasing", command === "create" ? "edit" : "approve"), async (req, res) => {
    try {
      const creditId = command === "create" ? undefined : id(req.params.id);
      const applicationId = command === "reverse" ? id(req.params.applicationId) : undefined;
      const descriptor = financialCommandFromRequest(req, {
        actorId: actor(req),
        routeTemplate: route,
        resourceKey: `supplier-credit:${creditId ?? "new"}:${applicationId ?? "document"}`,
        commandName: `supplier_credit.${command}`
      });
      const result = await supplierCreditCommands.execute(command, req.body, descriptor, creditId, applicationId);
      res.setHeader("Idempotency-Replayed", String(result.replayed));
      res.status(result.httpStatus).json(result.body);
    } catch (error) {
      failure(res, error);
    }
  });
  write("/api/supplier-credits", "create");
  write("/api/supplier-credits/:id/approve", "approve");
  write("/api/supplier-credits/:id/applications", "apply");
  write("/api/supplier-credits/:id/applications/:applicationId/reverse", "reverse");
  write("/api/supplier-credits/:id/void", "void");
}
