/**
 * Pure parts of the schema drift check (scripts/ci/check-schema-drift.ts):
 * argument parsing, the released-migration comparison and alert delivery.
 * Kept apart from the script so they are unit-tested without a database.
 */
import { CheckError } from "./disposable-database";

export type ProductionSource =
  | { kind: "self-check" }
  | { kind: "published"; directory: string }
  | { kind: "files"; dumpFile: string; appliedFile: string };

export interface DriftCheckOptions {
  source: ProductionSource;
  reportFile: string | null;
  /** When true the check refuses to start without an alert webhook. */
  alertRequired: boolean;
}

const USAGE = [
  "Usage: check-schema-drift.ts <source> [--report <file>] [--require-alert]",
  "  <source> is exactly one of:",
  "    --self-check                        prove the check works, without production",
  "    --production-structure <directory>  a checkout of the production-structure branch",
  "    --production-dump <file> --production-applied <file>",
  "                                        a structure dump and applied list taken by hand",
].join("\n");

function usageError(message: string): CheckError {
  return new CheckError("SCHEMA_DRIFT_USAGE", `${message}\n${USAGE}`);
}

export function parseDriftCheckArguments(argv: readonly string[]): DriftCheckOptions {
  const values = new Map<string, string | true>();
  const valueOptions = ["--production-structure", "--production-dump", "--production-applied", "--report"];
  const flagOptions = ["--self-check", "--require-alert"];
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (values.has(name)) throw usageError(`${name} was given twice.`);
    if (flagOptions.includes(name)) {
      values.set(name, true);
    } else if (valueOptions.includes(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) throw usageError(`${name} needs a value.`);
      values.set(name, value);
      index += 1;
    } else {
      throw usageError(`Unknown argument: ${name}.`);
    }
  }

  const directory = values.get("--production-structure");
  const dumpFile = values.get("--production-dump");
  const appliedFile = values.get("--production-applied");
  const fromFiles = dumpFile !== undefined || appliedFile !== undefined;
  const chosen = [values.has("--self-check"), directory !== undefined, fromFiles].filter(Boolean).length;
  if (chosen !== 1) throw usageError("Choose exactly one source of production's structure.");

  let source: ProductionSource;
  if (values.has("--self-check")) {
    source = { kind: "self-check" };
  } else if (typeof directory === "string") {
    source = { kind: "published", directory };
  } else {
    if (typeof dumpFile !== "string" || typeof appliedFile !== "string") {
      throw usageError("--production-dump and --production-applied must be given together.");
    }
    source = { kind: "files", dumpFile, appliedFile };
  }
  const report = values.get("--report");
  return {
    source,
    reportFile: typeof report === "string" ? report : null,
    alertRequired: values.has("--require-alert"),
  };
}

/**
 * Accepts the output of `SELECT filename FROM _migrations` as JSON: an array
 * of filenames, or of rows with a filename field.
 */
export function parseAppliedMigrations(json: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new CheckError("SCHEMA_DRIFT_APPLIED_LIST_INVALID", "The applied-migrations file is not valid JSON.");
  }
  const names = Array.isArray(parsed)
    ? parsed.map((entry) => (typeof entry === "string" ? entry : (entry as { filename?: unknown } | null)?.filename))
    : null;
  if (!names || names.length === 0 || names.some((name) => typeof name !== "string" || name === "")) {
    throw new CheckError("SCHEMA_DRIFT_APPLIED_LIST_INVALID", "The applied-migrations file must be a JSON array of filenames, or of rows with a filename field.");
  }
  return names as string[];
}

/**
 * Migrations in the repository that production has not applied. While any
 * exist the two structures are expected to differ, so there is nothing to
 * compare until the next release.
 */
export function findUnreleasedMigrations(repositoryMigrations: readonly string[], appliedInProduction: readonly string[]): string[] {
  const applied = new Set(appliedInProduction);
  return repositoryMigrations.filter((name) => !applied.has(name)).sort();
}

export type AlertFetch = (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

/** Posts a message to the Discord-compatible ops alert webhook. Throws if it is not accepted. */
export async function sendAlert(webhookUrl: string, content: string, fetchImpl: AlertFetch): Promise<void> {
  let response: { ok: boolean; status: number };
  try {
    response = await fetchImpl(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
  } catch (error) {
    // The webhook URL is a secret, so the underlying error (which can quote it) is not passed on.
    throw new CheckError("SCHEMA_DRIFT_ALERT_NOT_DELIVERED", "The alert webhook could not be reached.", {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
  if (!response.ok) {
    throw new CheckError("SCHEMA_DRIFT_ALERT_NOT_DELIVERED", "The alert webhook rejected the message.", { status: response.status });
  }
}
