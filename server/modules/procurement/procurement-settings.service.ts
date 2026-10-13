import { procurementSettingsCommandSchema, procurementSettingsSnapshotSchema } from "@shared/procurement/procurement-settings";
import { commandAuthorityActorSchema } from "../identity/domain/command-authority";
import { readCommandAuthorityActor } from "../identity/infrastructure/command-authority.repository";
import { lockInventoryCostGraph } from "../inventory/infrastructure/cost-evidence.repository";
import { applyProcurementSettingsCommand, assertProcurementSettingsAuthority, ProcurementSettingsError } from "./procurement-settings.policy";
import { readProcurementSettings, saveProcurementSettings, type ProcurementSettingsTransaction } from "./procurement-settings.repository";

/** The caller owns the transaction and durable command receipt. No standalone
 * per-key writer exists: validation, authority, all policy fields and audit are
 * committed together. Lock order matches purchasing approval and issue. */
export async function executeProcurementSettingsCommand(
  tx: ProcurementSettingsTransaction,
  input: unknown,
  actorId: string,
  at: Date,
  commandKey: string,
) {
  const parsedCommand = procurementSettingsCommandSchema.safeParse(input);
  if (!parsedCommand.success) {
    throw new ProcurementSettingsError("Invalid procurement policy command. Supply one or more unique boolean settings and the current revision.", 400, "PROCUREMENT_SETTINGS_INPUT_INVALID");
  }
  const command = parsedCommand.data;
  const actor = commandAuthorityActorSchema.shape.userId.parse(actorId);
  if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new TypeError("Invalid procurement settings command clock");
  if (!commandKey.trim()) throw new TypeError("Procurement settings command key is required");
  await lockInventoryCostGraph(tx);
  assertProcurementSettingsAuthority(await readCommandAuthorityActor(tx, actor));
  const before = await readProcurementSettings(tx, "update");
  const after = procurementSettingsSnapshotSchema.parse(applyProcurementSettingsCommand(before.settings, command));
  await saveProcurementSettings(tx, before, after, actor, at, commandKey);
  return { id: before.id, settings: after };
}
