import type { CommandAuthorityActor } from "../identity/domain/command-authority";
import type { ProcurementSettingsCommand, ProcurementSettingsSnapshot } from "@shared/procurement/procurement-settings";

export class ProcurementSettingsError extends Error {
  constructor(message: string, public readonly statusCode: number, public readonly code: string) {
    super(message);
    this.name = "ProcurementSettingsError";
  }
}

export function assertProcurementSettingsAuthority(actor: CommandAuthorityActor): void {
  if (!actor.active || !actor.permissions.includes("settings:edit")) {
    throw new ProcurementSettingsError("An active settings editor is required to change procurement policy.", 403, "PROCUREMENT_SETTINGS_FORBIDDEN");
  }
}

export function applyProcurementSettingsCommand(
  before: ProcurementSettingsSnapshot,
  command: ProcurementSettingsCommand,
): ProcurementSettingsSnapshot {
  if (command.expectedRevision !== before.revision) {
    throw new ProcurementSettingsError("Procurement settings changed. Refresh and review the saved policy before trying again.", 409, "PROCUREMENT_SETTINGS_STALE");
  }
  if (before.revision === 2_147_483_647) {
    throw new ProcurementSettingsError("The procurement policy revision limit has been reached. Contact an administrator.", 409, "PROCUREMENT_SETTINGS_REVISION_EXHAUSTED");
  }
  const after = { ...before, revision: before.revision + 1 };
  for (const { key, value } of command.updates) after[key] = value;
  return after;
}
