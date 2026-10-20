import type { MigrationProvenanceDependencies } from "./check-migrations.mjs";
export interface InheritedMigrationContext { base: string; pr: number; head: string; eventRepository?: unknown }
export function verifyInheritedMigrationFiles(repositoryRoot: string, context: InheritedMigrationContext, environment: NodeJS.ProcessEnv, dependencies?: MigrationProvenanceDependencies): Promise<Set<string>>;
