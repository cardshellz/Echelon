export interface MigrationCheckResult { event: string; migrations: number; base?: string; pr?: number; eventBase?: string }
export interface MigrationProvenanceDependencies { fetch?: typeof globalThis.fetch }
export function baseMigrationFiles(repositoryRoot: string, baseRef: string): { commit: string; files: string[]; sql: string[] };
export function ciMigrationContext(eventName: string, event: unknown): { base?: string; pr?: number; head?: string };
export function validateMigrationChanges(repositoryRoot: string, baseRef: string, ownerPr?: number): { filenames: string[]; added: string[]; base: string };
export function runMigrationCheck(args: string[], repositoryRoot?: string, environment?: NodeJS.ProcessEnv): MigrationCheckResult;
export function runMigrationCheckCli(args: string[], repositoryRoot?: string, environment?: NodeJS.ProcessEnv, dependencies?: MigrationProvenanceDependencies): Promise<MigrationCheckResult>;
