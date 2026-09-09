import { z } from "zod";
import { openingAssessmentSchema, openingSavedSchema, openingSaveRequestSchema, openingSourceSchema,
  openingVerificationSchema, type OpeningAssessment, type OpeningSaved, type OpeningSaveRequest,
  type OpeningSource, type OpeningVerification } from "@shared/types/inventory-cutover-opening";
import { reconstructionHash } from "../domain/inventory-cutover-reconstruction";

export interface OpeningSaveCommand extends OpeningSaveRequest {
  actor: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryCutoverOpeningStore {
  capture(occurredAt: Date): Promise<OpeningSource>;
  preview(verification: OpeningVerification, occurredAt: Date): Promise<OpeningAssessment>;
  save(command: OpeningSaveCommand): Promise<OpeningSaved>;
}

export class InventoryCutoverOpeningError extends Error {
  constructor(readonly code: string, message: string, readonly status: number = 409,
    readonly context: Readonly<Record<string, unknown>> = {}, options?: ErrorOptions) {
    super(message, options);
    this.name = "InventoryCutoverOpeningError";
  }
}

/** Authentication and semantic identity only; the store owns the transaction. */
export class InventoryCutoverOpeningService {
  constructor(private readonly store: InventoryCutoverOpeningStore,
    private readonly clock: { now(): Date } = { now: () => new Date() }) {}

  async capture(actorInput: unknown): Promise<OpeningSource> {
    this.actor(actorInput);
    return openingSourceSchema.parse(await this.store.capture(this.now()));
  }

  async preview(input: unknown, actorInput: unknown): Promise<OpeningAssessment> {
    this.actor(actorInput);
    const verification = openingVerificationSchema.safeParse(input);
    if (!verification.success) throw new InventoryCutoverOpeningError("CUTOVER_OPENING_REQUEST_INVALID",
      "A complete, explicit opening verification is required.", 400);
    const occurredAt = this.now();
    this.verifyTimestamp(verification.data, occurredAt);
    return openingAssessmentSchema.parse(await this.store.preview(verification.data, occurredAt));
  }

  async save(input: unknown, actorInput: unknown): Promise<OpeningSaved> {
    const actor = this.actor(actorInput);
    const request = openingSaveRequestSchema.safeParse(input);
    if (!request.success) throw new InventoryCutoverOpeningError("CUTOVER_OPENING_REQUEST_INVALID",
      "A complete opening verification, reason and idempotency key are required.", 400);
    const occurredAt = this.now();
    this.verifyTimestamp(request.data.verification, occurredAt);
    // Retry time is not semantic identity. Actor, reason, reference and every
    // verified fact are; the same key cannot silently approve a different input.
    // Preserve the submitted array ordering for exact command replay. The domain
    // separately normalizes fact ordering for its verification evidence hash.
    const requestHash = reconstructionHash({ contractVersion: "inventory_cutover_opening_save_v1", actor, ...request.data });
    return openingSavedSchema.parse(await this.store.save({ ...request.data, actor, requestHash, occurredAt }));
  }

  private actor(input: unknown): string {
    const actor = z.string().trim().min(1).max(100).safeParse(input);
    if (!actor.success) throw new InventoryCutoverOpeningError("CUTOVER_OPENING_ACTOR_REQUIRED",
      "An authenticated activation operator is required.", 401);
    return actor.data;
  }

  private now(): Date {
    const value = this.clock.now();
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new InventoryCutoverOpeningError(
      "CUTOVER_OPENING_CLOCK_INVALID", "The opening verification clock is invalid.", 500);
    return new Date(value.getTime());
  }

  private verifyTimestamp(verification: OpeningVerification, occurredAt: Date): void {
    if (Date.parse(verification.verifiedAt) > occurredAt.getTime()) throw new InventoryCutoverOpeningError(
      "CUTOVER_OPENING_VERIFICATION_TIME_INVALID", "The verification cannot be dated in the future.", 400);
  }
}
