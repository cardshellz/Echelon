export const BASELINE_VERSION: number;
export const BASELINE_DIRECTORY: string;
export const BASELINE_SCHEMA_FILENAME: string;
export const BASELINE_MANIFEST_FILENAME: string;

export interface BaselineManifest {
  version: number;
  capturedAt: string;
  serverVersion: string;
  schemaSha256: string;
  covers: string[];
}

export function normalizeLineEndings(text: string): string;
export function baselineSha256(text: string): string;
export function transformProductionDump(rawDump: string): string;
export function validateBaselineManifest(value: unknown): BaselineManifest;
export function buildBaselineManifest(input: {
  schemaText: string;
  repositoryMigrations: readonly string[];
  appliedInProduction: readonly string[];
  capturedAt: string;
  serverVersion: string;
}): BaselineManifest;
