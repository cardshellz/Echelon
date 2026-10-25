import { CostEvidenceError } from "../inventory/infrastructure/cost-evidence-values";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierCreditCommandResultSchema, supplierCreditCreateInputSchema, supplierCreditApplyInputSchema, supplierCreditReviewInputSchema, type SupplierCreditCommand } from "@shared/procurement/supplier-credit";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository, type FinancialCommandResult } from "../../platform/commands/transactional-command.service";
import { SupplierCreditError, type CreditTransaction } from "./supplier-credit.repository";
import { SupplierCreditEvidenceError } from "./supplier-credit-settlement.repository";
import { executeSupplierCreditCommand } from "./supplier-credit.service";
export function bindSupplierCreditCommand(descriptor: FinancialCommandDescriptor, command: SupplierCreditCommand): FinancialCommandDescriptor {
  const scope = {
    method: "POST",
    routeTemplate: "/api/supplier-credits/command",
    resourceKey: "ap:supplier-credit",
    commandName: "procurement.supplier_credit"
  };
  return {
    ...descriptor,
    ...scope,
    actorType: "service",
    actorId: "procurement.supplier-credit",
    requestHash: hashHttpFinancialCommand({
      ...scope,
      body: {
        command,
        actorId: descriptor.actorId,
        actorType: descriptor.actorType,
        method: descriptor.method,
        routeTemplate: descriptor.routeTemplate,
        resourceKey: descriptor.resourceKey,
        rawRequestHash: descriptor.requestHash
      }
    })
  };
}
export function classifySupplierCreditFailure(error: unknown): FinancialCommandFailureDisposition {
  const pgCode = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  let status: number | undefined,
    code = "SUPPLIER_CREDIT_COMMAND_FAILED",
    message = "Supplier credit command failed before committing.";
  if (error instanceof SupplierCreditError) {
    status = error.statusCode;
    code = error.code;
    message = error.message;
  } else if (error instanceof SupplierCreditEvidenceError) {
    status = error.statusCode;
    code = error.details.code;
    message = error.message;
  } else if (error instanceof CostEvidenceError) {
    status = error.statusCode;
    code = error.code;
    message = error.message;
  } else if (["23503", "23505", "23514"].includes(pgCode)) {
    status = 409;
    code = pgCode === "23505" ? "SUPPLIER_CREDIT_DUPLICATE" : "SUPPLIER_CREDIT_CONSERVATION_REQUIRED";
    message = "Credit evidence conflicts with an existing document or verified settlement. Reload and review before submitting a new request.";
  }
  if (status !== undefined) return {
    kind: "rejected",
    httpStatus: status,
    body: {
      error: message,
      details: {
        code
      }
    },
    errorCode: code,
    errorMessage: message
  };
  return {
    kind: "retryable",
    errorCode: code,
    errorMessage: message
  };
}
export function validateSupplierCreditReceipt(result: Pick<FinancialCommandResult, "body" | "terminalState" | "httpStatus">, command: SupplierCreditCommand, raw: unknown, descriptor: FinancialCommandDescriptor, creditId?: number, applicationId?: number): void {
  if (result.terminalState === "succeeded") {
    const body = supplierCreditCommandResultSchema.parse(result.body);
    if (body.command !== command || body.actorId !== descriptor.actorId || body.idempotencyKey !== descriptor.idempotencyKey || command !== "create" && body.creditId !== creditId || command === "reverse" && body.reversedApplicationId !== applicationId) throw new FinancialCommandError("Saved supplier credit response identity needs review. Retain the request key.", 500, "SUPPLIER_CREDIT_RESULT_INVALID");
    const expected = command === "create" ? supplierCreditCreateInputSchema.parse(raw) : command === "apply" ? supplierCreditApplyInputSchema.parse(raw) : supplierCreditReviewInputSchema.parse(raw);
    const fail = () => {
      throw new FinancialCommandError("Saved supplier credit economics do not match the reviewed request. Retain the request key.", 500, "SUPPLIER_CREDIT_RESULT_INVALID");
    };
    if (result.httpStatus !== (command === "create" ? 201 : 200) || canonicalJson(body.request) !== canonicalJson(expected) || new Set(body.applicationIds).size !== body.applicationIds.length) fail();
    if (command === "create") {
      const create = supplierCreditCreateInputSchema.parse(expected);
      const economics = (lines: readonly {
        invoiceLineId: number;
        amountCents: number;
        disposition: unknown;
      }[]) => lines.map(line => canonicalJson({
        invoiceLineId: line.invoiceLineId,
        amountCents: line.amountCents,
        disposition: line.disposition
      })).sort();
      if (BigInt(body.credit.totalAmountCents) !== create.lines.reduce((sum, line) => sum + BigInt(line.amountCents), BigInt(0)) || body.credit.status !== "draft" || body.credit.sourceInvoiceId !== create.sourceInvoiceId || body.credit.replacesCreditId !== (create.replacesCreditId ?? null) || body.credit.supplierReference !== create.supplierReference || body.credit.creditCalendarDate !== create.creditCalendarDate || body.credit.reason !== create.reason || canonicalJson(economics(body.credit.lines)) !== canonicalJson(economics(create.lines))) fail();
    } else if (command === "apply") {
      const apply = supplierCreditApplyInputSchema.parse(expected);
      const rows = body.credit.applications.filter(row => body.applicationIds.includes(row.id));
      if (body.credit.status !== "approved" || body.applicationIds.length !== apply.allocations.length || rows.length !== apply.allocations.length || rows.some(row => row.actorId !== descriptor.actorId || row.reason !== apply.reason || row.reversal !== null) || canonicalJson(rows.map(row => `${row.vendorInvoiceId}:${row.appliedAmountCents}`).sort()) !== canonicalJson(apply.allocations.map(row => `${row.vendorInvoiceId}:${row.appliedAmountCents}`).sort())) fail();
    } else if (command === "reverse") {
      const reversal = body.credit.applications.find(row => row.id === applicationId)?.reversal;
      if (!reversal || reversal.actorId !== descriptor.actorId || reversal.reason !== expected.reason) fail();
    } else if (command === "reconcile_costs") {
      // This is successful evaluation, not a promise that blockers disappeared.
      // An exact replay may retain both the reviewed version and review status.
      const credit = body.credit;
      if (credit.status !== "approved" || credit.appliedAmountCents === null || credit.unappliedAmountCents === null
        || credit.balanceIssues.length > 0
        || credit.balanceState !== (credit.unappliedAmountCents === 0 ? "fully_applied" : "available")) fail();
    } else if (command === "approve" && body.credit.status !== "approved") fail();else if (command === "void" && (body.credit.status !== "voided" || body.credit.voidReason !== expected.reason)) fail();
    if (command !== "apply" && body.applicationIds.length > 0) fail();
    if (command !== "reverse" && body.reversedApplicationId !== null) fail();
  } else {
    const body = result.body as {
      details?: Record<string, unknown>;
    };
    if (result.terminalState !== "rejected" || result.httpStatus < 400 || result.httpStatus >= 500 || body.details?.creditCommandOutcome !== "rejected" || body.details.command !== command || body.details.actorId !== descriptor.actorId || body.details.idempotencyKey !== descriptor.idempotencyKey) throw new FinancialCommandError("Saved supplier credit rejection needs review. Retain the request key.", 500, "SUPPLIER_CREDIT_RESULT_INVALID");
  }
}
export function createSupplierCreditCommands(repository: FinancialCommandRepository<CreditTransaction> = financialCommandRepository, clock: () => Date = () => new Date()) {
  return {
    async execute(command: SupplierCreditCommand, raw: unknown, descriptor: FinancialCommandDescriptor, creditId?: number, applicationId?: number) {
      const route = command === "create" ? "/api/supplier-credits" : command === "apply" ? "/api/supplier-credits/:id/applications" : command === "reverse" ? "/api/supplier-credits/:id/applications/:applicationId/reverse" : `/api/supplier-credits/:id/${command}`;
      const resourceKey = `supplier-credit:${creditId ?? "new"}:${applicationId ?? "document"}`;
      const params = command === "create" ? {} : command === "reverse" ? {
        id: String(creditId),
        applicationId: String(applicationId)
      } : {
        id: String(creditId)
      };
      if (descriptor.actorType !== "user" || descriptor.method !== "POST" || descriptor.routeTemplate !== route || descriptor.resourceKey !== resourceKey || descriptor.commandName !== `supplier_credit.${command}` || descriptor.requestHash !== hashHttpFinancialCommand({
        method: "POST",
        routeTemplate: route,
        resourceKey,
        params,
        query: {},
        body: raw
      })) throw new FinancialCommandError("Supplier credit request identity is invalid.", 400, "SUPPLIER_CREDIT_IDENTITY_INVALID");
      const result = await runTransactionalFinancialCommand({
        repository,
        descriptor: bindSupplierCreditCommand(descriptor, command),
        classifyFailure: error => {
          const failure = classifySupplierCreditFailure(error);
          if (failure.kind !== "rejected") return failure;
          const body = failure.body as {
            error: string;
            details: Record<string, unknown>;
          };
          return {
            ...failure,
            body: {
              ...body,
              details: {
                ...body.details,
                creditCommandOutcome: "rejected",
                command,
                actorId: descriptor.actorId,
                idempotencyKey: descriptor.idempotencyKey
              }
            }
          };
        },
        work: async tx => {
          const value = await executeSupplierCreditCommand(tx, {
            command,
            raw,
            actorId: descriptor.actorId,
            creditId,
            applicationId,
            at: clock()
          });
          const body = supplierCreditCommandResultSchema.parse(JSON.parse(JSON.stringify({
            ...value,
            command,
            actorId: descriptor.actorId,
            idempotencyKey: descriptor.idempotencyKey
          })));
          validateSupplierCreditReceipt({
            body,
            httpStatus: command === "create" ? 201 : 200,
            terminalState: "succeeded"
          }, command, raw, descriptor, creditId, applicationId);
          return {
            httpStatus: command === "create" ? 201 : 200,
            body,
            resultType: "supplier_credit",
            resultId: body.creditId
          };
        }
      });
      validateSupplierCreditReceipt(result, command, raw, descriptor, creditId, applicationId);
      return result;
    }
  };
}
export const supplierCreditCommands = createSupplierCreditCommands();
