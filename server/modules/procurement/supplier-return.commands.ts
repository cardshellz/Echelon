import { z } from "zod";
import { canonicalJson } from "@shared/utils/canonical-json";
import { supplierReturnCommandResultSchema, supplierReturnRecordInputSchema } from "@shared/procurement/supplier-return";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { hashHttpFinancialCommand } from "../../platform/commands/http-command";
import {
  FinancialCommandError, runTransactionalFinancialCommand,
  type FinancialCommandDescriptor, type FinancialCommandFailureDisposition,
  type FinancialCommandRepository, type FinancialCommandResult,
} from "../../platform/commands/transactional-command.service";
import { SupplierReturnStockError } from "../inventory/domain/supplier-return-stock";
import { SupplierReturnError } from "./supplier-return.errors";
import { recordSupplierReturn, type SupplierReturnTransaction } from "./supplier-return.service";

export const SUPPLIER_RETURN_COMMAND_SCOPE = {
  method: "POST", routeTemplate: "/api/supplier-returns",
  resourceKey: "supplier-return:new", commandName: "supplier_return.record",
} as const;

/** A reused key cannot silently become another operator's collection. */
export function bindSupplierReturnCommand(descriptor: FinancialCommandDescriptor): FinancialCommandDescriptor {
  return {
    ...descriptor, ...SUPPLIER_RETURN_COMMAND_SCOPE,
    actorType: "service", actorId: "procurement.supplier-return",
    requestHash: hashHttpFinancialCommand({
      ...SUPPLIER_RETURN_COMMAND_SCOPE,
      body: { actorType: descriptor.actorType, actorId: descriptor.actorId, rawRequestHash: descriptor.requestHash },
    }),
  };
}

export function classifySupplierReturnFailure(error: unknown): FinancialCommandFailureDisposition {
  let rejection: { status: number; code: string; message: string } | null = null;
  if (error instanceof SupplierReturnError || error instanceof SupplierReturnStockError) {
    rejection = { status: error.statusCode, code: error.code, message: error.message };

  }
  if (rejection && rejection.status >= 400 && rejection.status < 500) {
    return {
      kind: "rejected", httpStatus: rejection.status, errorCode: rejection.code, errorMessage: rejection.message,
      body: { error: rejection.message, details: { code: rejection.code } },
    };
  }
  // Database/transport/lease failures must not permanently reject a physical
  // collection that has not committed. Retain the original request for retry.
  return { kind: "retryable", errorCode: "SUPPLIER_RETURN_OPERATION_FAILED", errorMessage: "The return did not complete. Retain the request key and retry." };
}

export function validateSupplierReturnReceipt(
  result: Pick<FinancialCommandResult, "body" | "terminalState" | "httpStatus">,
  raw: unknown, descriptor: FinancialCommandDescriptor,
): void {
  const fail = () => { throw new FinancialCommandError("Saved supplier return evidence does not match the reviewed collection. Retain the request key.", 500, "SUPPLIER_RETURN_RESULT_INVALID"); };
  if (result.terminalState !== "succeeded") {
    const rejected = z.object({ details: z.object({
      supplierReturnCommandOutcome: z.literal("rejected"), command: z.literal("record"), actorId: z.string(), idempotencyKey: z.string(),
    }) }).safeParse(result.body);
    if (result.terminalState !== "rejected" || result.httpStatus < 400 || result.httpStatus >= 500 || !rejected.success
      || rejected.data.details.actorId !== descriptor.actorId || rejected.data.details.idempotencyKey !== descriptor.idempotencyKey) fail();
    return;
  }
  const parsed = supplierReturnCommandResultSchema.safeParse(result.body);
  const request = supplierReturnRecordInputSchema.safeParse(raw);
  if (!parsed.success || !request.success) { fail(); return; }
  const body = parsed.data;
  const document = body.return;
  const expected = request.data;
  const receipt = document.inventoryReceipt;
  const selection = (lines: readonly { inventoryLotId: number; quantity: number }[]) =>
    lines.map(line => ({ inventoryLotId: line.inventoryLotId, quantity: line.quantity })).sort((a, b) => a.inventoryLotId - b.inventoryLotId);
  if (result.httpStatus !== 201 || body.command !== "record" || body.actorId !== descriptor.actorId
    || body.idempotencyKey !== descriptor.idempotencyKey || canonicalJson(body.request) !== canonicalJson(expected)
    || body.returnId !== document.id || document.status !== "recorded" || document.recordedBy !== descriptor.actorId
    || document.vendorId !== expected.vendorId || document.supplierReference !== (expected.supplierReference ?? null)
    || document.returnCalendarDate !== expected.returnCalendarDate || document.evidenceReference !== expected.evidenceReference
    || document.reason !== expected.reason || document.sourceFingerprint !== expected.expectedSourceFingerprint
    || receipt.returnId !== document.id || receipt.commandKey !== descriptor.idempotencyKey || receipt.actorId !== descriptor.actorId
    || receipt.sourceFingerprint !== expected.expectedSourceFingerprint
    || canonicalJson(selection(document.lines.map(line => line.source))) !== canonicalJson(selection(expected.lines))
    || canonicalJson(selection(receipt.lines)) !== canonicalJson(selection(expected.lines))) fail();
}

export function createSupplierReturnCommands(
  repository: FinancialCommandRepository<SupplierReturnTransaction> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    async record(raw: unknown, descriptor: FinancialCommandDescriptor) {
      const scope = SUPPLIER_RETURN_COMMAND_SCOPE;
      if (descriptor.contractVersion !== 1 || !z.string().min(1).max(100).refine(value => value.trim() === value).safeParse(descriptor.actorId).success
        || !z.string().min(8).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,199}$/).safeParse(descriptor.idempotencyKey).success
        || descriptor.actorType !== "user" || descriptor.method !== scope.method || descriptor.routeTemplate !== scope.routeTemplate
        || descriptor.resourceKey !== scope.resourceKey || descriptor.commandName !== scope.commandName
        || descriptor.requestHash !== hashHttpFinancialCommand({ ...scope, body: raw, params: {}, query: {} })) {
        throw new FinancialCommandError("Supplier return request identity is invalid.", 400, "SUPPLIER_RETURN_IDENTITY_INVALID");
      }
      const result = await runTransactionalFinancialCommand({
        repository, descriptor: bindSupplierReturnCommand(descriptor),
        classifyFailure: error => {
          const failure = classifySupplierReturnFailure(error);
          if (failure.kind !== "rejected") return failure;
          const body = failure.body as { error: string; details: { code: string } };
          return { ...failure, body: { ...body, details: { ...body.details,
            supplierReturnCommandOutcome: "rejected", command: "record", actorId: descriptor.actorId, idempotencyKey: descriptor.idempotencyKey,
          } } };
        },
        work: async tx => {
          const document = await recordSupplierReturn(tx, {
            raw, actorId: descriptor.actorId, at: clock(), commandKey: descriptor.idempotencyKey, requestFingerprint: descriptor.requestHash,
          });
          const body = supplierReturnCommandResultSchema.parse({
            command: "record", actorId: descriptor.actorId, idempotencyKey: descriptor.idempotencyKey,
            request: supplierReturnRecordInputSchema.parse(raw), returnId: document.id, return: document,
          });
          validateSupplierReturnReceipt({ body, httpStatus: 201, terminalState: "succeeded" }, raw, descriptor);
          return { httpStatus: 201, body, resultType: "supplier_return", resultId: document.id };
        },
      });
      validateSupplierReturnReceipt(result, raw, descriptor);
      return result;
    },
  };
}
export const supplierReturnCommands = createSupplierReturnCommands();
