import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool, type PoolClient } from "pg";
import {
  connectionStringFromEnv,
  requiredWmsIntegrityAuditRelations,
} from "./audit-wms-inventory-integrity";

interface CredentialFlags {
  help: boolean;
  execute: boolean;
  credential: string | null;
}

function usage(): string {
  return [
    "Usage:",
    "  npx tsx scripts/configure-wms-integrity-audit-credential.ts --dry-run --credential=NAME",
    "  npx tsx scripts/configure-wms-integrity-audit-credential.ts --execute --credential=NAME",
    "",
    "Create the credential with Heroku first. This command grants only the schema usage",
    "and table SELECT privileges required by the current audit checks, and revokes DML.",
  ].join("\n");
}

export function parseCredentialFlags(argv: string[]): CredentialFlags {
  const allowedBare = new Set(["--help", "-h", "--dry-run", "--execute"]);
  for (const arg of argv) {
    if (allowedBare.has(arg)) continue;
    if (arg.startsWith("--credential=")) continue;
    throw new Error(`Unknown flag: ${arg}`);
  }
  if (argv.includes("--dry-run") && argv.includes("--execute")) {
    throw new Error("Choose either --dry-run or --execute, not both");
  }
  const credential = argv.find((arg) => arg.startsWith("--credential="))
    ?.slice("--credential=".length).trim() ?? null;
  if (credential !== null && !/^[A-Za-z][A-Za-z0-9_-]{0,49}$/.test(credential)) {
    throw new Error("--credential must be a valid Heroku Postgres credential name");
  }
  return {
    help: argv.includes("--help") || argv.includes("-h"),
    execute: argv.includes("--execute"),
    credential,
  };
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteRelation(relation: string): string {
  const [schema, table, extra] = relation.split(".");
  if (!schema || !table || extra) throw new Error(`Invalid audit relation: ${relation}`);
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function buildAuditCredentialStatements(credential: string): string[] {
  const role = quoteIdentifier(credential);
  const relations = requiredWmsIntegrityAuditRelations();
  const schemas = [...new Set(relations.map((relation) => relation.split(".")[0]))].sort();
  const statements: string[] = [];
  for (const schema of schemas) {
    const quotedSchema = quoteIdentifier(schema);
    statements.push(`REVOKE CREATE ON SCHEMA ${quotedSchema} FROM ${role}`);
    statements.push(
      `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER `
        + `ON ALL TABLES IN SCHEMA ${quotedSchema} FROM ${role}`,
    );
    statements.push(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${quotedSchema} FROM ${role}`);
    statements.push(`GRANT USAGE ON SCHEMA ${quotedSchema} TO ${role}`);
  }
  statements.push(`GRANT SELECT ON ${relations.map(quoteRelation).join(", ")} TO ${role}`);
  return statements;
}

async function assertCredentialIsLimited(
  client: Pick<PoolClient, "query">,
  credential: string,
): Promise<void> {
  const result = await client.query(`
    SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
    FROM pg_roles
    WHERE rolname = $1
  `, [credential]);
  const row = result.rows[0];
  if (!row) throw new Error(`PostgreSQL credential ${credential} does not exist`);
  if (row.rolsuper || row.rolcreaterole || row.rolcreatedb || row.rolreplication || row.rolbypassrls) {
    throw new Error(`PostgreSQL credential ${credential} has elevated role attributes and cannot be the audit reader`);
  }
}

export async function main(): Promise<void> {
  const flags = parseCredentialFlags(process.argv.slice(2));
  if (flags.help) {
    console.log(usage());
    return;
  }
  if (!flags.credential) throw new Error("--credential is required");
  const connectionString = connectionStringFromEnv();
  const pool = new Pool({
    connectionString,
    ssl: connectionString.includes("localhost") ? undefined : { rejectUnauthorized: false },
    max: 1,
    application_name: "wms-integrity-audit-credential-config",
  });
  const client = await pool.connect();
  try {
    await assertCredentialIsLimited(client, flags.credential);
    const statements = buildAuditCredentialStatements(flags.credential);
    if (!flags.execute) {
      console.log(JSON.stringify({
        mode: "dry-run",
        credential: flags.credential,
        relations: requiredWmsIntegrityAuditRelations(),
        statementCount: statements.length,
      }, null, 2));
      return;
    }
    await client.query("BEGIN");
    try {
      for (const statement of statements) await client.query(statement);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    console.log(JSON.stringify({
      mode: "execute",
      credential: flags.credential,
      relations: requiredWmsIntegrityAuditRelations().length,
      statementCount: statements.length,
    }, null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    console.error(`[WMS inventory integrity credential] fatal: ${error?.stack ?? error}`);
    process.exitCode = 1;
  });
}
