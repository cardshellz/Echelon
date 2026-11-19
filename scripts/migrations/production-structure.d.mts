export const PRODUCTION_STRUCTURE_BRANCH: string;
export const STRUCTURE_FILENAME: string;
export const APPLIED_MIGRATIONS_FILENAME: string;
export const HEARTBEAT_FILENAME: string;
export const HEARTBEAT_VERSION: number;
export const PRODUCTION_STRUCTURE_MAX_AGE_MS: number;

export interface ProductionStructureHeartbeat {
  version: number;
  capturedAt: string;
  structureSha256: string;
  appliedSha256: string;
}

export function stableStructureText(rawDump: string): string;
export function validateHeartbeat(value: unknown): ProductionStructureHeartbeat;
export function buildPublication(input: {
  rawDump: string;
  applied: readonly string[];
  capturedAt: Date;
}): {
  heartbeat: ProductionStructureHeartbeat;
  files: Record<string, string>;
};
export function verifyPublication(input: {
  structureText: string;
  appliedText: string;
  heartbeatText: string;
  now: Date;
  maxAgeMs?: number;
}): { structure: string; applied: string[]; capturedAt: string };
