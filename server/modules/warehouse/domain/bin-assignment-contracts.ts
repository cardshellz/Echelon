/**
 * Boundary contracts for slot-assignment commands.
 *
 * Two HTTP routes (PUT /api/bin-assignments and
 * POST /api/warehouse/locations/:id/products) used to hand `isPrimary` from the
 * request body straight to the service. A raw 0 skipped sibling demotion and
 * wrote 0 onto a variant's only slot; a boolean reached the integer column and
 * failed inside Postgres. Every write now passes through these parsers, and the
 * service applies them too so non-HTTP callers get the same guarantees.
 */
import { z } from "zod";

export type BinAssignmentValidationCode =
  | "BIN_ASSIGNMENT_REQUEST_INVALID"
  | "BIN_ASSIGNMENT_PRIMARY_FLAG_INVALID"
  | "BIN_ASSIGNMENT_PRIMARY_REQUIRED";

/** A rejected slot-assignment command. Routes map it to HTTP 400. */
export class BinAssignmentValidationError extends Error {
  readonly code: BinAssignmentValidationCode;

  constructor(code: BinAssignmentValidationCode, message: string) {
    super(message);
    this.name = "BinAssignmentValidationError";
    this.code = code;
  }
}

export const PRIMARY_SLOT_FLAG = 1;
export const SECONDARY_SLOT_FLAG = 0;
export type SlotPrimaryFlag = typeof PRIMARY_SLOT_FLAG | typeof SECONDARY_SLOT_FLAG;

/**
 * Omitted means primary — the historical default every caller relied on.
 * Only the literal integers 0 and 1 are accepted; booleans, strings and other
 * numbers are rejected instead of being coerced.
 */
export function parseSlotPrimaryFlag(value: unknown): SlotPrimaryFlag {
  if (value === undefined || value === null) return PRIMARY_SLOT_FLAG;
  if (value === PRIMARY_SLOT_FLAG || value === SECONDARY_SLOT_FLAG) return value;
  throw new BinAssignmentValidationError(
    "BIN_ASSIGNMENT_PRIMARY_FLAG_INVALID",
    `isPrimary must be 0 or 1 (got ${JSON.stringify(value)})`,
  );
}

const positiveIntegerId = z.preprocess(
  (value) => (typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value.trim()) : value),
  z.number().int().positive(),
);

export const binAssignmentWriteRequestSchema = z.object({
  productVariantId: positiveIntegerId,
  warehouseLocationId: positiveIntegerId,
  isPrimary: z.union([z.literal(PRIMARY_SLOT_FLAG), z.literal(SECONDARY_SLOT_FLAG)]).optional(),
});

export type BinAssignmentWriteRequest = z.infer<typeof binAssignmentWriteRequestSchema>;

/** Validates a slot-assignment request body. Unknown keys are dropped. */
export function parseBinAssignmentWriteRequest(body: unknown): BinAssignmentWriteRequest {
  const parsed = binAssignmentWriteRequestSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
      .join("; ");
    throw new BinAssignmentValidationError(
      "BIN_ASSIGNMENT_REQUEST_INVALID",
      `Invalid bin assignment request — ${detail}`,
    );
  }
  return parsed.data;
}
