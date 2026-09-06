import { saveWorkConfigurationSchema, type SaveWorkConfiguration, type WorkConfiguration } from "@shared/warehouse-work";

export interface WorkSaveAttempt { fingerprint: string; command: SaveWorkConfiguration }

/** Preserve command identity across network retries; generate a new ID only for a new edit. */
export function prepareWorkSaveAttempt(
  draft: { expectedRevision: number; configuration: WorkConfiguration; reason: string },
  previous: WorkSaveAttempt | null,
  newCommandId: () => string,
): WorkSaveAttempt {
  const fingerprint = JSON.stringify(draft);
  if (previous?.fingerprint === fingerprint) return previous;
  return { fingerprint, command: saveWorkConfigurationSchema.parse({ ...draft, commandId: newCommandId() }) };
}
