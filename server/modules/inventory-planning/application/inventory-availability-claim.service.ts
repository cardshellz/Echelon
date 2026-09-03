import { z } from "zod";

import {
  canonicalAvailabilityClaimBuildHandoffCommandSchema,
  canonicalAvailabilityClaimBuildHandoffResultSchema,
  canonicalAvailabilityClaimCommandSchema,
  canonicalAvailabilityClaimOperationExecutionCommandSchema,
  canonicalAvailabilityClaimOperationExecutionResultSchema,
  canonicalAvailabilityClaimPickCommandSchema,
  canonicalAvailabilityClaimPickResultSchema,
  canonicalAvailabilityClaimReleaseCommandSchema,
  canonicalAvailabilityClaimReplacementCommandSchema,
  canonicalAvailabilityClaimReplacementResultSchema,
  canonicalAvailabilityClaimResultSchema,
  canonicalAvailabilityClaimUnpickCommandSchema,
  type CanonicalAvailabilityClaimBuildHandoffResult,
  type CanonicalAvailabilityClaimOperationExecutionResult,
  type CanonicalAvailabilityClaimPickResult,
  type CanonicalAvailabilityClaimReplacementResult,
  type CanonicalAvailabilityClaimResult,
} from "@shared/types/inventory-availability-claims";

import type { InventoryAvailabilityClaimStore } from "./inventory-availability-claim.port";

export type InventoryAvailabilityClaimOperation =
  | "claim_order"
  | "replace_order_claim"
  | "release_order_claim"
  | "execute_package_operation"
  | "execute_build_operation"
  | "handoff_build_operation"
  | "pick_claim_line"
  | "unpick_claim_line";

export class InventoryAvailabilityClaimServiceError extends Error {
  constructor(
    readonly code: "INVALID_CANONICAL_CLAIM_COMMAND" | "INVALID_CANONICAL_CLAIM_RESULT",
    message: string,
    readonly context: {
      operation: InventoryAvailabilityClaimOperation;
      issues: string[];
    },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityClaimServiceError";
  }
}

/**
 * Validated application boundary for canonical claim commands.
 *
 * It deliberately has no HTTP route or runtime construction. The underlying store
 * remains responsible for serializable transactions, idempotency, and the canonical
 * authority gate; this service prevents future callers from bypassing command and
 * result contracts when runtime wiring is introduced.
 */
export class InventoryAvailabilityClaimService {
  constructor(private readonly store: InventoryAvailabilityClaimStore) {}

  async claimOrder(input: unknown): Promise<CanonicalAvailabilityClaimResult> {
    const operation = "claim_order";
    const command = parseCommand(canonicalAvailabilityClaimCommandSchema, input, operation);
    return parseResult(
      canonicalAvailabilityClaimResultSchema,
      await this.store.claimOrder(command),
      operation,
    );
  }

  async replaceOrderClaim(input: unknown): Promise<CanonicalAvailabilityClaimReplacementResult> {
    const operation = "replace_order_claim";
    const command = parseCommand(canonicalAvailabilityClaimReplacementCommandSchema, input, operation);
    return parseResult(
      canonicalAvailabilityClaimReplacementResultSchema,
      await this.store.replaceOrderClaim(command),
      operation,
    );
  }

  async releaseOrderClaim(input: unknown): Promise<CanonicalAvailabilityClaimResult> {
    const operation = "release_order_claim";
    const command = parseCommand(canonicalAvailabilityClaimReleaseCommandSchema, input, operation);
    return parseResult(
      canonicalAvailabilityClaimResultSchema,
      await this.store.releaseOrderClaim(command),
      operation,
    );
  }

  async executePackageOperation(input: unknown): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
    const operation = "execute_package_operation";
    const command = parseCommand(canonicalAvailabilityClaimOperationExecutionCommandSchema, input, operation);
    return parseResult(
      canonicalAvailabilityClaimOperationExecutionResultSchema,
      await this.store.executePackageOperation(command),
      operation,
    );
  }

  async executeBuildOperation(input: unknown): Promise<CanonicalAvailabilityClaimOperationExecutionResult> {
    const operation = "execute_build_operation";
    const command = parseCommand(canonicalAvailabilityClaimOperationExecutionCommandSchema, input, operation);
    return parseResult(
      canonicalAvailabilityClaimOperationExecutionResultSchema,
      await this.store.executeBuildOperation(command),
      operation,
    );
  }

  async handoffBuildOperation(input: unknown): Promise<CanonicalAvailabilityClaimBuildHandoffResult> {
    const operation = "handoff_build_operation";
    const command = parseCommand(canonicalAvailabilityClaimBuildHandoffCommandSchema, input, operation);
    return parseResult(
      canonicalAvailabilityClaimBuildHandoffResultSchema,
      await this.store.handoffBuildOperation(command),
      operation,
    );
  }

  async pickClaimLine(input: unknown): Promise<CanonicalAvailabilityClaimPickResult> {
    const operation = "pick_claim_line";
    const command = parseCommand(canonicalAvailabilityClaimPickCommandSchema, input, operation);
    return parseResult(
      canonicalAvailabilityClaimPickResultSchema,
      await this.store.pickClaimLine(command),
      operation,
    );
  }

  async unpickClaimLine(input: unknown): Promise<CanonicalAvailabilityClaimPickResult> {
    const operation = "unpick_claim_line";
    const command = parseCommand(canonicalAvailabilityClaimUnpickCommandSchema, input, operation);
    return parseResult(
      canonicalAvailabilityClaimPickResultSchema,
      await this.store.unpickClaimLine(command),
      operation,
    );
  }
}

function parseCommand<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  operation: InventoryAvailabilityClaimOperation,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw contractError("INVALID_CANONICAL_CLAIM_COMMAND", operation, parsed.error);
  }
  return parsed.data;
}

function parseResult<Schema extends z.ZodTypeAny>(
  schema: Schema,
  input: unknown,
  operation: InventoryAvailabilityClaimOperation,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw contractError("INVALID_CANONICAL_CLAIM_RESULT", operation, parsed.error);
  }
  return parsed.data;
}

function contractError(
  code: InventoryAvailabilityClaimServiceError["code"],
  operation: InventoryAvailabilityClaimOperation,
  error: z.ZodError,
): InventoryAvailabilityClaimServiceError {
  return new InventoryAvailabilityClaimServiceError(
    code,
    code === "INVALID_CANONICAL_CLAIM_COMMAND"
      ? "Canonical claim command failed application validation."
      : "Canonical claim store returned an invalid result.",
    {
      operation,
      issues: error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
    },
    { cause: error },
  );
}
