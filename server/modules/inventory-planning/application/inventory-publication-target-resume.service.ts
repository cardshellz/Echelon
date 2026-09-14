import { createHash } from "node:crypto";

import {
  inventoryPublicationTargetResumeResultSchema,
  inventoryPublicationTargetResumeReviewSchema,
  resumeInventoryPublicationTargetRequestSchema,
  reviewInventoryPublicationTargetResumeRequestSchema,
  type InventoryPublicationTargetResumeResult,
  type InventoryPublicationTargetResumeReview,
  type ResumeInventoryPublicationTargetRequest,
  type ReviewInventoryPublicationTargetResumeRequest,
} from "@shared/types/inventory-publication-target-resume";
import { canonicalJson } from "@shared/utils/canonical-json";
import { z } from "zod";

import { InventoryAvailabilityMasterDataError } from "../domain/inventory-availability-master-data.contracts";

const actorSchema = z.string().trim().min(1).max(100);

export interface ReviewInventoryPublicationTargetResumeCommand
extends ReviewInventoryPublicationTargetResumeRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface ResumeInventoryPublicationTargetCommand
extends ResumeInventoryPublicationTargetRequest {
  actorId: string;
  requestHash: string;
  occurredAt: Date;
}

export interface InventoryPublicationTargetResumeStore {
  review(
    command: ReviewInventoryPublicationTargetResumeCommand,
  ): Promise<InventoryPublicationTargetResumeReview>;
  resume(
    command: ResumeInventoryPublicationTargetCommand,
  ): Promise<InventoryPublicationTargetResumeResult>;
}

export interface InventoryPublicationTargetResumeClock { now(): Date }

const systemClock: InventoryPublicationTargetResumeClock = { now: () => new Date() };

export class InventoryPublicationTargetResumeService {
  constructor(
    private readonly store: InventoryPublicationTargetResumeStore,
    private readonly clock: InventoryPublicationTargetResumeClock = systemClock,
  ) {}

  async review(
    input: ReviewInventoryPublicationTargetResumeRequest,
    actorInput: string,
  ): Promise<InventoryPublicationTargetResumeReview> {
    const request = parseRequest(
      reviewInventoryPublicationTargetResumeRequestSchema,
      input,
      "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_INVALID_REQUEST",
      "Review the publication-target resume-readiness fields.",
    );
    const actorId = parseActor(actorInput);
    const occurredAt = validNow(this.clock, "resume-review");
    const requestHash = hash({
      commandType: "inventory_publication_target_resume_review",
      actorId,
      request,
    });
    return inventoryPublicationTargetResumeReviewSchema.parse(await this.store.review({
      ...request,
      actorId,
      requestHash,
      occurredAt,
    }));
  }

  async resume(
    input: ResumeInventoryPublicationTargetRequest,
    actorInput: string,
  ): Promise<InventoryPublicationTargetResumeResult> {
    const request = parseRequest(
      resumeInventoryPublicationTargetRequestSchema,
      input,
      "INVENTORY_PUBLICATION_TARGET_RESUME_INVALID_REQUEST",
      "Review the publication-target resume fields.",
    );
    const actorId = parseActor(actorInput);
    const occurredAt = validNow(this.clock, "resume");
    const requestHash = hash({
      commandType: "inventory_publication_target_resume",
      actorId,
      request,
    });
    return inventoryPublicationTargetResumeResultSchema.parse(await this.store.resume({
      ...request,
      actorId,
      requestHash,
      occurredAt,
    }));
  }
}

function parseRequest<T>(
  schema: z.ZodType<T>,
  input: unknown,
  code: string,
  message: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new InventoryAvailabilityMasterDataError(
    400,
    code,
    message,
    result.error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`),
  );
}

function parseActor(input: string): string {
  const result = actorSchema.safeParse(input);
  if (result.success) return result.data;
  throw new InventoryAvailabilityMasterDataError(
    401,
    "INVENTORY_PUBLICATION_TARGET_RESUME_ACTOR_REQUIRED",
    "An authenticated operator is required.",
  );
}

function validNow(clock: InventoryPublicationTargetResumeClock, operation: string): Date {
  const occurredAt = clock.now();
  if (occurredAt instanceof Date && Number.isFinite(occurredAt.getTime())) return occurredAt;
  throw new InventoryAvailabilityMasterDataError(
    500,
    "INVENTORY_PUBLICATION_TARGET_RESUME_CLOCK_INVALID",
    `The publication-target ${operation} clock returned an invalid timestamp.`,
  );
}

function hash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}
