import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readNormalizedSource(...segments: string[]): string {
  return readFileSync(join(process.cwd(), ...segments), "utf8").replace(/\r\n/g, "\n");
}

const migration = readNormalizedSource("migrations", "136_financial_command_results.sql");
const schema = readNormalizedSource("shared", "schema", "audit.schema.ts");

describe("financial command results migration", () => {
  it("scopes command idempotency to the actor, route, resource, and key", () => {
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.financial_command_results");
    expect(migration).toContain("CREATE UNIQUE INDEX IF NOT EXISTS financial_command_results_scope_uidx");

    const scopeIndex = migration.slice(
      migration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS financial_command_results_scope_uidx"),
      migration.indexOf(
        ";",
        migration.indexOf("CREATE UNIQUE INDEX IF NOT EXISTS financial_command_results_scope_uidx"),
      ),
    );
    for (const column of [
      "actor_type",
      "actor_id",
      "method",
      "route_template",
      "resource_key",
      "idempotency_key",
    ]) {
      expect(scopeIndex).toContain(column);
    }
  });

  it("stores immutable command identity and a canonical SHA-256 request hash", () => {
    expect(migration).toContain("request_hash VARCHAR(64) NOT NULL");
    expect(migration).toContain("request_hash ~ '^[0-9a-f]{64}$'");
    expect(migration).toContain("command_name VARCHAR(120) NOT NULL");
    expect(migration).toContain("contract_version INTEGER NOT NULL DEFAULT 1");
    expect(migration).toContain("contract_version > 0");
    expect(migration).toContain("actor_type IN ('user', 'service', 'system')");
    expect(migration).toContain("guard_financial_command_result_update");
    expect(migration).toContain("NEW.request_hash");
    expect(migration).toContain("OLD.request_hash");
    expect(migration).toContain("NEW.command_name");
    expect(migration).toContain("OLD.command_name");
    expect(migration).toContain("NEW.contract_version");
    expect(migration).toContain("OLD.contract_version");
    expect(migration).toContain("Terminal financial command results are immutable");
  });

  it("models claimed, replayable, retryable, and dead lifecycle shapes", () => {
    for (const status of ["claimed", "succeeded", "rejected", "retryable", "dead"]) {
      expect(migration).toContain(`status = '${status}'`);
    }

    expect(migration).toContain("financial_command_results_lifecycle_chk");
    expect(migration).toContain("lease_token IS NOT NULL");
    expect(migration).toContain("lease_expires_at IS NOT NULL");
    expect(migration).toContain("http_status BETWEEN 200 AND 299");
    expect(migration).toContain("http_status BETWEEN 400 AND 499");
    expect(migration).toContain("response_body IS NOT NULL");
    expect(migration).toContain("next_attempt_at IS NOT NULL");
    expect(migration).toContain("last_error_code IS NOT NULL");
    expect(migration).toContain("last_error_message IS NOT NULL");
    expect(migration).toContain("completed_at IS NOT NULL");
    expect(migration).toContain("attempt_count > 0");
  });

  it("enforces ordered timestamps, paired result identity, and bounded expiry", () => {
    expect(migration).toContain("financial_command_results_time_order_chk");
    expect(migration).toContain("updated_at >= created_at");
    expect(migration).toContain("expires_at > created_at");
    expect(migration).toContain("lease_expires_at <= expires_at");
    expect(migration).toContain("next_attempt_at < expires_at");
    expect(migration).toContain("completed_at < expires_at");
    expect(migration).toContain("financial_command_results_result_identity_chk");
    expect(migration).toContain("(result_type IS NULL AND result_id IS NULL)");
  });

  it("prevents early lease and retry reclamation in the database trigger", () => {
    expect(migration).toContain("An active financial command lease cannot be reclaimed");
    expect(migration).toContain("A financial command retry cannot be claimed before next_attempt_at");
    expect(migration).toContain("OLD.lease_expires_at > transaction_timestamp()");
    expect(migration).toContain("OLD.next_attempt_at > transaction_timestamp()");
  });

  it("adds operational indexes for expired leases, due retries, retention, and results", () => {
    expect(migration).toContain("financial_command_results_claimed_lease_idx");
    expect(migration).toContain("WHERE status = 'claimed'");
    expect(migration).toContain("financial_command_results_retry_due_idx");
    expect(migration).toContain("WHERE status = 'retryable'");
    expect(migration).toContain("financial_command_results_expires_idx");
    expect(migration).toContain("financial_command_results_result_idx");
  });

  it("keeps the Drizzle model aligned with the migration contract", () => {
    expect(schema).toContain("export const financialCommandResults = pgTable");
    for (const property of [
      "actorType",
      "actorId",
      "routeTemplate",
      "resourceKey",
      "idempotencyKey",
      "requestHash",
      "commandName",
      "contractVersion",
      "leaseToken",
      "leaseExpiresAt",
      "attemptCount",
      "attemptLimit",
      "recoveryCount",
      "httpStatus",
      "responseBody",
      "resultType",
      "resultId",
      "nextAttemptAt",
      "lastErrorCode",
      "lastErrorMessage",
      "completedAt",
      "expiresAt",
    ]) {
      expect(schema).toContain(`${property}:`);
    }
    expect(schema).toContain("financial_command_results_scope_uidx");
    expect(schema).toContain("financial_command_results_lifecycle_chk");
    expect(schema).toContain("export type FinancialCommandResult");
    expect(schema).toContain("export type InsertFinancialCommandResult");
  });
});
