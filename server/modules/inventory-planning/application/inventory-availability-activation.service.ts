import { createHash } from "node:crypto";

import {
  abortInventoryActivationRequestSchema,
  inventoryActivationCommandResultSchema,
  inventoryActivationStatusSchema,
  prepareInventoryActivationRequestSchema,
  type InventoryActivationCommandResult,
  type InventoryActivationStatus,
} from "@shared/types/inventory-availability-phase4";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

const actorSchema = z.string().trim().min(1).max(100);

export interface PrepareInventoryActivationCommand {
  sourceDryRunId: string;
  expectedDryRunResultHash: string;
  idempotencyKey: string;
  reason: string;
  actor: string;
  requestHash: string;
  occurredAt: Date;
}

export interface AbortInventoryActivationCommand {
  activationRunId: string;
  idempotencyKey: string;
  reason: string;
  actor: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryAvailabilityActivationStore {
  prepare(command: PrepareInventoryActivationCommand): Promise<InventoryActivationCommandResult>;
  abort(command: AbortInventoryActivationCommand): Promise<InventoryActivationCommandResult>;
  getStatus(activationRunId: string): Promise<InventoryActivationStatus>;
  getOpenStatus(): Promise<InventoryActivationStatus | null>;
}

export interface InventoryAvailabilityActivationClock {
  now(): Date;
}

const systemClock: InventoryAvailabilityActivationClock = { now: () => new Date() };

export class InventoryAvailabilityActivationServiceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "InventoryAvailabilityActivationServiceError";
  }
}

export class InventoryAvailabilityActivationService {
  constructor(
    private readonly store: InventoryAvailabilityActivationStore,
    private readonly clock: InventoryAvailabilityActivationClock = systemClock,
  ) {}

  async prepare(input: unknown, actorInput: string): Promise<InventoryActivationCommandResult> {
    const parsed = prepareInventoryActivationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidRequest(
        "INVENTORY_AVAILABILITY_INVALID_ACTIVATION_PREPARE",
        "Review the activation prepare fields.",
        parsed.error,
      );
    }
    const actor = parseActor(actorInput);
    const occurredAt = validNow(this.clock);
    const requestHash = hash({
      commandType: "inventory_availability_activation_prepare",
      contractVersion: "inventory_availability_activation_v1",
      actor,
      ...parsed.data,
    });
    return inventoryActivationCommandResultSchema.parse(await this.store.prepare({
      ...parsed.data,
      actor,
      requestHash,
      occurredAt,
    }));
  }

  async abort(input: unknown, actorInput: string): Promise<InventoryActivationCommandResult> {
    const parsed = abortInventoryActivationRequestSchema.safeParse(input);
    if (!parsed.success) {
      throw invalidRequest(
        "INVENTORY_AVAILABILITY_INVALID_ACTIVATION_ABORT",
        "Review the activation abort fields.",
        parsed.error,
      );
    }
    const actor = parseActor(actorInput);
    const occurredAt = validNow(this.clock);
    const requestHash = hash({
      commandType: "inventory_availability_activation_abort",
      contractVersion: "inventory_availability_activation_v1",
      actor,
      ...parsed.data,
    });
    return inventoryActivationCommandResultSchema.parse(await this.store.abort({
      ...parsed.data,
      actor,
      requestHash,
      occurredAt,
    }));
  }

  async getStatus(activationRunIdInput: unknown): Promise<InventoryActivationStatus> {
    const activationRunId = z.string().regex(/^[1-9]\d*$/).safeParse(activationRunIdInput);
    if (!activationRunId.success) {
      throw new InventoryAvailabilityActivationServiceError(
        400,
        "INVENTORY_AVAILABILITY_ACTIVATION_RUN_ID_INVALID",
        "Activation run ID must be a positive integer.",
      );
    }
    return inventoryActivationStatusSchema.parse(await this.store.getStatus(activationRunId.data));
  }

  async getOpenStatus(): Promise<InventoryActivationStatus | null> {
    const status = await this.store.getOpenStatus();
    return status === null ? null : inventoryActivationStatusSchema.parse(status);
  }
}

function invalidRequest(code: string, message: string, error: z.ZodError): InventoryAvailabilityActivationServiceError {
  return new InventoryAvailabilityActivationServiceError(
    400,
    code,
    message,
    error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
  );
}

function parseActor(value: string): string {
  const parsed = actorSchema.safeParse(value);
  if (!parsed.success) {
    throw new InventoryAvailabilityActivationServiceError(
      401,
      "INVENTORY_AVAILABILITY_ACTIVATION_ACTOR_REQUIRED",
      "An authenticated activation actor is required.",
    );
  }
  return parsed.data;
}

function validNow(clock: InventoryAvailabilityActivationClock): Date {
  const value = clock.now();
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new InventoryAvailabilityActivationServiceError(
      500,
      "INVENTORY_AVAILABILITY_ACTIVATION_CLOCK_INVALID",
      "The activation clock returned an invalid time.",
    );
  }
  return value;
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
