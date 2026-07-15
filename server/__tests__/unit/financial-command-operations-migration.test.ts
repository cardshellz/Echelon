import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const migration = readNormalizedSource("migrations", "140_financial_command_operations.sql");
const schema = readNormalizedSource("shared", "schema", "audit.schema.ts");
const service = readNormalizedSource(
  "server",
  "platform",
  "commands",
  "financial-command-operations.service.ts",
);

describe("financial command operations migration", () => {
  it("adds a bounded one-attempt recovery budget and immutable recovery evidence", () => {
    expect(migration).toContain("attempt_limit INTEGER NOT NULL DEFAULT 5");
    expect(migration).toContain("recovery_count INTEGER NOT NULL DEFAULT 0");
    expect(migration).toContain("attempt_count <= attempt_limit");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.financial_command_recoveries");
    expect(migration).toContain("financial_command_recoveries_command_number_uidx");
    expect(migration).toContain("prior_error_code");
    expect(migration).toContain("prior_error_message");
    expect(migration).toContain("prior_completed_at");
  });

  it("permits dead-to-retryable only with matching audit evidence and one added attempt", () => {
    expect(migration).toContain("OLD.status = 'dead' AND NEW.status = 'retryable'");
    expect(migration).toContain("NEW.attempt_limit = OLD.attempt_limit + 1");
    expect(migration).toContain("NEW.recovery_count = OLD.recovery_count + 1");
    expect(migration).toContain("FROM public.financial_command_recoveries recovery");
    expect(migration).toContain("Terminal financial command results are immutable");
    expect(migration).toContain("recovery budget changes require an audited dead-command recovery");
  });

  it("keeps the Drizzle schema aligned with the recovery tables", () => {
    expect(schema).toContain("attemptLimit: integer(\"attempt_limit\")");
    expect(schema).toContain("recoveryCount: integer(\"recovery_count\")");
    expect(schema).toContain("export const financialCommandRecoveries = pgTable");
    expect(schema).toContain("commandResultId: bigint(\"command_result_id\"");
    expect(schema).toContain("export type FinancialCommandRecovery");
  });

  it("purges only expired replayable terminal rows with a bounded skip-locked batch", () => {
    expect(service).toContain("status IN ('succeeded', 'rejected')");
    expect(service).toContain("expires_at <= transaction_timestamp()");
    expect(service).toContain("FOR UPDATE SKIP LOCKED");
    expect(service).toContain("LIMIT $1");
    expect(service).not.toMatch(/status IN \('succeeded', 'rejected', 'dead'\)/);
  });

  it("copies recovery evidence inside PostgreSQL without timestamp round-tripping", () => {
    const recoveryWriter = service.slice(
      service.indexOf("INSERT INTO public.financial_command_recoveries"),
      service.indexOf("const updated = await client.query"),
    );
    expect(recoveryWriter).toContain("SELECT");
    expect(recoveryWriter).toContain("command.completed_at");
    expect(recoveryWriter).toContain("FROM public.financial_command_results command");
    expect(recoveryWriter).not.toContain("command.completed_at,");
  });
});
