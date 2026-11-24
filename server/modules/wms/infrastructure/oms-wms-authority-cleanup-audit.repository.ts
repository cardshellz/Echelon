import { sql } from "drizzle-orm";

export type AuthorityCleanupAuditAction = "update" | "delete";

export interface OmsWmsAuthorityCleanupAuditInput {
  runId: string;
  operation: string;
  sourceTable: string;
  sourceId: number;
  action: AuthorityCleanupAuditAction;
  reason: string;
  beforeRow: Readonly<Record<string, unknown>>;
  afterRow: Readonly<Record<string, unknown>> | null;
  operator: string;
  createdAt: Date;
}

export interface AuthorityCleanupAuditTx {
  execute: (query: unknown) => Promise<unknown>;
}

export class InvalidAuthorityCleanupAuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuthorityCleanupAuditInputError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OPERATION_LENGTH = 80;
const MAX_SOURCE_TABLE_LENGTH = 120;
const MAX_OPERATOR_LENGTH = 120;

function requireBoundedText(
  value: string,
  field: string,
  maximumLength: number,
): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new InvalidAuthorityCleanupAuditInputError(`${field} is required`);
  }
  if (normalized.length > maximumLength) {
    throw new InvalidAuthorityCleanupAuditInputError(
      `${field} exceeds ${maximumLength} characters`,
    );
  }
  return normalized;
}

function serializeSnapshot(
  value: Readonly<Record<string, unknown>> | null,
  field: "beforeRow" | "afterRow",
): string | null {
  if (value === null) {
    if (field === "beforeRow") {
      throw new InvalidAuthorityCleanupAuditInputError("beforeRow is required");
    }
    return null;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidAuthorityCleanupAuditInputError(`${field} must be an object`);
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error("JSON.stringify returned undefined");
    }
    return serialized;
  } catch {
    throw new InvalidAuthorityCleanupAuditInputError(`${field} must be JSON serializable`);
  }
}

/**
 * Append one immutable cleanup snapshot using the caller's transaction.
 *
 * The WMS module owns this write. Accepting the existing transaction handle
 * keeps the audit row atomic with the cross-module repair it documents.
 */
export async function recordOmsWmsAuthorityCleanupAudit(
  tx: AuthorityCleanupAuditTx,
  input: OmsWmsAuthorityCleanupAuditInput,
): Promise<void> {
  if (!UUID_PATTERN.test(input.runId)) {
    throw new InvalidAuthorityCleanupAuditInputError("runId must be a UUID");
  }
  if (!Number.isSafeInteger(input.sourceId) || input.sourceId <= 0) {
    throw new InvalidAuthorityCleanupAuditInputError(
      "sourceId must be a positive safe integer",
    );
  }
  if (input.action !== "update" && input.action !== "delete") {
    throw new InvalidAuthorityCleanupAuditInputError(
      "action must be one of update, delete",
    );
  }
  if (
    !(input.createdAt instanceof Date)
    || Number.isNaN(input.createdAt.getTime())
  ) {
    throw new InvalidAuthorityCleanupAuditInputError("createdAt must be a valid Date");
  }

  const operation = requireBoundedText(input.operation, "operation", MAX_OPERATION_LENGTH);
  const sourceTable = requireBoundedText(
    input.sourceTable,
    "sourceTable",
    MAX_SOURCE_TABLE_LENGTH,
  );
  const reason = requireBoundedText(input.reason, "reason", Number.MAX_SAFE_INTEGER);
  const operator = requireBoundedText(input.operator, "operator", MAX_OPERATOR_LENGTH);
  const beforeRow = serializeSnapshot(input.beforeRow, "beforeRow");
  const afterRow = serializeSnapshot(input.afterRow, "afterRow");

  await tx.execute(sql`
    INSERT INTO wms.oms_wms_authority_cleanup_audit (
      run_id,
      operation,
      source_table,
      source_id,
      action,
      reason,
      before_row,
      after_row,
      operator,
      created_at
    ) VALUES (
      ${input.runId}::uuid,
      ${operation},
      ${sourceTable},
      ${input.sourceId},
      ${input.action},
      ${reason},
      ${beforeRow}::jsonb,
      ${afterRow}::jsonb,
      ${operator},
      ${input.createdAt}
    )
  `);
}
