/**
 * Builds an empty database from the schema baseline.
 *
 * The legacy migration files cannot build a database from nothing (replay
 * stops at 0002_concerned_darwin.sql), and they cannot be edited because
 * production recorded their hashes. So an empty database loads
 * migrations/baseline/schema.sql, a structure-only snapshot of production,
 * and records every migration the snapshot already contains as applied. The
 * runner then applies only the migrations written after the snapshot.
 *
 * A database that already has migration records never loads the baseline.
 * Production is such a database, so this changes nothing there.
 */
import * as crypto from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  BASELINE_DIRECTORY,
  BASELINE_MANIFEST_FILENAME,
  BASELINE_REFERENCE_AUDIT_FILENAME,
  BASELINE_REFERENCE_DATA_FILENAME,
  BASELINE_SCHEMA_FILENAME,
  baselineSha256,
  validateBaselineManifest,
  validateBaselineReferenceAudit,
} from '../scripts/migrations/baseline-format.mjs';
import type { MigrationQueryClient } from './migration-executor';

export type BaselineErrorCode =
  | 'MIGRATION_BASELINE_STATE_UNREADABLE'
  | 'MIGRATION_BASELINE_DATABASE_NOT_EMPTY'
  | 'MIGRATION_BASELINE_HASH_MISMATCH'
  | 'MIGRATION_BASELINE_REFERENCE_HASH_MISMATCH'
  | 'MIGRATION_BASELINE_COVERS_MISSING_FILE';

/** Permanent: retrying cannot help; the operator must fix the input or the target. */
export class BaselineBootstrapError extends Error {
  readonly code: BaselineErrorCode;
  readonly context: Record<string, unknown>;

  constructor(code: BaselineErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'BaselineBootstrapError';
    this.code = code;
    this.context = context;
  }
}

export type BaselineOutcome =
  | { applied: false; reason: 'database_has_migration_records' }
  | { applied: true; recorded: number; capturedAt: string };

export interface BaselineBootstrapInput {
  client: MigrationQueryClient;
  migrationsDir: string;
  /** The validated migration filenames in the repository, as the runner sees them. */
  files: readonly string[];
  readFile?: (path: string) => string;
}

// Objects an extension owns (pg_stat_statements' views, for example) do not
// make a database "in use": some hosts pre-install extensions. Heroku also
// pre-creates an empty heroku_ext schema, which the baseline tolerates.
const DATABASE_STATE_SQL = `
  SELECT
    to_regclass('public._migrations') IS NOT NULL AS has_migration_records,
    (SELECT count(*)::int
       FROM pg_catalog.pg_class c
       JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
        AND n.nspname !~ '^pg_(toast|temp)'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend d
           WHERE d.classid = 'pg_catalog.pg_class'::regclass
             AND d.objid = c.oid
             AND d.deptype = 'e')) AS relation_count,
    (SELECT count(*)::int
       FROM pg_catalog.pg_namespace n
      WHERE n.nspname NOT IN ('public', 'pg_catalog', 'information_schema', 'heroku_ext')
        AND n.nspname !~ '^pg_'
        AND NOT EXISTS (
          SELECT 1 FROM pg_catalog.pg_depend d
           WHERE d.classid = 'pg_catalog.pg_namespace'::regclass
             AND d.objid = n.oid
             AND d.deptype = 'e')) AS schema_count
`;

// The baseline runs with an empty search_path, so the table is named in full.
const RECORD_COVERED_SQL = `
  INSERT INTO public._migrations (filename, content_hash)
  SELECT covered.filename, covered.content_hash
    FROM unnest($1::text[], $2::text[]) AS covered(filename, content_hash)
`;

interface DatabaseState {
  hasMigrationRecords: boolean;
  relationCount: number;
  schemaCount: number;
}

async function readDatabaseState(client: MigrationQueryClient): Promise<DatabaseState> {
  const result = await client.query(DATABASE_STATE_SQL) as { rows?: Array<Record<string, unknown>> } | undefined;
  const row = result?.rows?.[0];
  if (
    !row
    || typeof row.has_migration_records !== 'boolean'
    || !Number.isSafeInteger(row.relation_count)
    || !Number.isSafeInteger(row.schema_count)
  ) {
    // Fail closed: never guess whether a database is empty.
    throw new BaselineBootstrapError(
      'MIGRATION_BASELINE_STATE_UNREADABLE',
      'Could not determine whether the target database is empty.',
    );
  }
  return {
    hasMigrationRecords: row.has_migration_records,
    relationCount: row.relation_count as number,
    schemaCount: row.schema_count as number,
  };
}

/** Must match hashSQL() in run-migrations.ts: the runner compares these later. */
function migrationContentHash(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex');
}

export async function applyBaselineToEmptyDatabase(input: BaselineBootstrapInput): Promise<BaselineOutcome> {
  const state = await readDatabaseState(input.client);
  if (state.hasMigrationRecords) {
    return { applied: false, reason: 'database_has_migration_records' };
  }
  if (state.relationCount > 0 || state.schemaCount > 0) {
    throw new BaselineBootstrapError(
      'MIGRATION_BASELINE_DATABASE_NOT_EMPTY',
      'The target database has objects but no migration records. The baseline loads only into an empty database; '
        + 'refusing to guess which migrations this database already contains.',
      { relationCount: state.relationCount, schemaCount: state.schemaCount },
    );
  }

  const read = input.readFile ?? ((path: string) => readFileSync(path, 'utf8'));
  const baselineDir = join(input.migrationsDir, BASELINE_DIRECTORY);
  const manifest = validateBaselineManifest(JSON.parse(read(join(baselineDir, BASELINE_MANIFEST_FILENAME))));
  const schemaSql = read(join(baselineDir, BASELINE_SCHEMA_FILENAME));
  const schemaHash = baselineSha256(schemaSql);
  if (schemaHash !== manifest.schemaSha256) {
    throw new BaselineBootstrapError(
      'MIGRATION_BASELINE_HASH_MISMATCH',
      'migrations/baseline/schema.sql does not match its manifest. Regenerate both with generate-baseline.mjs.',
      { expected: manifest.schemaSha256, actual: schemaHash },
    );
  }
  const referenceAudit = validateBaselineReferenceAudit(
    JSON.parse(read(join(baselineDir, BASELINE_REFERENCE_AUDIT_FILENAME))),
  );
  const referenceDataSql = read(join(baselineDir, BASELINE_REFERENCE_DATA_FILENAME));
  const referenceDataHash = baselineSha256(referenceDataSql);
  if (referenceDataHash !== referenceAudit.referenceDataSha256) {
    throw new BaselineBootstrapError(
      'MIGRATION_BASELINE_REFERENCE_HASH_MISMATCH',
      'migrations/baseline/reference-data.sql does not match migrations/baseline/reference-data-audit.json.',
      { expected: referenceAudit.referenceDataSha256, actual: referenceDataHash },
    );
  }
  const present = new Set(input.files);
  const missing = manifest.covers.filter((filename) => !present.has(filename));
  if (missing.length > 0) {
    throw new BaselineBootstrapError(
      'MIGRATION_BASELINE_COVERS_MISSING_FILE',
      'The baseline manifest lists migrations that are not in the repository.',
      { missing },
    );
  }
  const hashes = manifest.covers.map((filename) => migrationContentHash(read(join(input.migrationsDir, filename))));

  // One transaction: a database is either still empty or fully baselined.
  await input.client.query('BEGIN');
  try {
    await input.client.query(schemaSql);
    await input.client.query(referenceDataSql);
    await input.client.query(RECORD_COVERED_SQL, [manifest.covers, hashes]);
    await input.client.query('COMMIT');
  } catch (error) {
    try {
      await input.client.query('ROLLBACK');
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        'Loading the schema baseline failed and its transaction could not be rolled back safely.',
      );
    }
    throw error;
  }
  return { applied: true, recorded: manifest.covers.length, capturedAt: manifest.capturedAt };
}
