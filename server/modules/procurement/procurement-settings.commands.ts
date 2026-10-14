import { z } from "zod";
import { financialCommandRepository } from "../../platform/commands/command-results.repository";
import { FinancialCommandError, runTransactionalFinancialCommand, type FinancialCommandDescriptor, type FinancialCommandFailureDisposition, type FinancialCommandRepository } from "../../platform/commands/transactional-command.service";
import { ProcurementSettingsError } from "./procurement-settings.policy";
import type { ProcurementSettingsTransaction } from "./procurement-settings.repository";
import { executeProcurementSettingsCommand } from "./procurement-settings.service";

export const PROCUREMENT_SETTINGS_COMMAND_SCOPE = {
  method: "PATCH", routeTemplate: "/api/settings/procurement", resourceKey: "procurement_settings:DEFAULT", commandName: "procurement.settings.update",
} as const;

export function classifyProcurementSettingsFailure(error: unknown): FinancialCommandFailureDisposition {
  if (error instanceof z.ZodError) {
    // Request shape is classified at the boundary before any DB reads. A later
    // schema failure describes stored identity or policy evidence, not input.
    return { kind: "rejected", httpStatus: 409, body: { error: "Stored procurement authority evidence is invalid. Review its source records.", code: "PROCUREMENT_SETTINGS_EVIDENCE_INVALID" }, errorCode: "PROCUREMENT_SETTINGS_EVIDENCE_INVALID", errorMessage: "Stored procurement authority evidence is invalid" };
  }
  if (error instanceof ProcurementSettingsError) {
    return { kind: "rejected", httpStatus: error.statusCode, body: { error: error.message, code: error.code }, errorCode: error.code, errorMessage: error.message };
  }
  return { kind: "retryable", errorCode: "PROCUREMENT_SETTINGS_TRANSIENT_FAILURE", errorMessage: "Procurement policy transaction did not commit. Retry the same command key." };
}

export function createProcurementSettingsCommands(
  repository: FinancialCommandRepository<ProcurementSettingsTransaction> = financialCommandRepository,
  clock: () => Date = () => new Date(),
) {
  return {
    async update(input: unknown, actorId: string, descriptor: FinancialCommandDescriptor) {
      if (!actorId?.trim()) throw new FinancialCommandError("An authenticated settings editor is required", 401, "PROCUREMENT_SETTINGS_ACTOR_REQUIRED");
      if (descriptor.actorType !== "user" || descriptor.actorId !== actorId
        || descriptor.method !== PROCUREMENT_SETTINGS_COMMAND_SCOPE.method
        || descriptor.routeTemplate !== PROCUREMENT_SETTINGS_COMMAND_SCOPE.routeTemplate
        || descriptor.resourceKey !== PROCUREMENT_SETTINGS_COMMAND_SCOPE.resourceKey
        || descriptor.commandName !== PROCUREMENT_SETTINGS_COMMAND_SCOPE.commandName) {
        throw new FinancialCommandError("Procurement settings command scope is invalid", 500, "PROCUREMENT_SETTINGS_SCOPE_INVALID");
      }
      return runTransactionalFinancialCommand({
        repository, descriptor, classifyFailure: classifyProcurementSettingsFailure,
        work: async tx => {
          const result = await executeProcurementSettingsCommand(tx, input, actorId, clock(), descriptor.idempotencyKey);
          return { httpStatus: 200, body: result.settings, resultType: "procurement_settings", resultId: result.id };
        },
      });
    },
  };
}

export const procurementSettingsCommands = createProcurementSettingsCommands();
