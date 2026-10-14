export interface MigrationMetadata {
  version: 1;
  migration: string;
  generation: number;
  pr: number;
  ordinal: number;
  after: string[];
}
export interface MigrationInventory {
  filenames: string[];
  legacyManifest: unknown;
  metadata: Map<string, unknown>;
}
export class MigrationPolicyError extends Error {
  constructor(code: string, message: string, context?: Record<string, unknown>);
  code: string;
  context: Record<string, unknown>;
}
export const NAMESPACE_VERSION: 1;
export const MAX_GENERATION: number;
export const MAX_PR_NUMBER: number;
export const MAX_ORDINAL: number;
export function fail(code: string, message: string, context?: Record<string, unknown>): never;
export function boundedInteger(value: unknown, maximum: number, label: string): number;
export function parseAllocatedFilename(filename: string): { generation: number; pr: number; ordinal: number; name: string } | null;
export function formatAllocatedFilename(input: { generation: number; pr: number; ordinal: number; name: string }): string;
export function validateLegacyManifest(value: unknown): string[];
export function validateMigrationInventory(inventory: MigrationInventory): string[];
export function readMigrationInventory(migrationsDir: string, excludedFilename?: string): MigrationInventory;
export function validateMigrationDirectory(migrationsDir: string): string[];
export function reportMigrationError(error: unknown): void;
