import type { MigrationInventory, MigrationMetadata } from "./migration-policy.mjs";
export interface MigrationAllocationInput {
  pr: number;
  name: string;
  after?: string[];
}
export function planMigration(inventory: MigrationInventory, input: MigrationAllocationInput): MigrationMetadata;
export function allocateMigration(input: MigrationAllocationInput & { migrationsDir: string; adopt?: string; protectedFilenames?: string[] }): MigrationMetadata;
export function runMigrationAllocation(args: string[], repositoryRoot?: string): MigrationMetadata;
