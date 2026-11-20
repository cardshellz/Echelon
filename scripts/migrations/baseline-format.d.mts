export const BASELINE_VERSION: number;
export const BASELINE_DIRECTORY: string;
export const BASELINE_SCHEMA_FILENAME: string;
export const BASELINE_MANIFEST_FILENAME: string;
export const BASELINE_REFERENCE_DATA_FILENAME: string;
export const BASELINE_REFERENCE_AUDIT_FILENAME: string;

export interface BaselineManifest {
  version: number;
  capturedAt: string;
  serverVersion: string;
  schemaSha256: string;
  covers: string[];
}

export type BaselineReferenceDisposition =
  | "baseline_reference_seed"
  | "dependent_or_runtime_seeded"
  | "historical_backfill_or_event";

export interface BaselineReferenceTableAudit {
  table: string;
  disposition: BaselineReferenceDisposition;
  rationale: string;
  sourceMigrations: string[];
}

export interface BaselineReferenceAudit {
  version: number;
  reviewedAt: string;
  baselineCapturedAt: string;
  referenceDataSha256: string;
  coveredInsertMigrations: string[];
  tables: BaselineReferenceTableAudit[];
}

export function normalizeLineEndings(text: string): string;
export function baselineSha256(text: string): string;
export function transformProductionDump(rawDump: string): string;
export function validateBaselineManifest(value: unknown): BaselineManifest;
export function validateBaselineReferenceAudit(value: unknown): BaselineReferenceAudit;
export function buildBaselineManifest(input: {
  schemaText: string;
  repositoryMigrations: readonly string[];
  appliedInProduction: readonly string[];
  capturedAt: string;
  serverVersion: string;
}): BaselineManifest;
