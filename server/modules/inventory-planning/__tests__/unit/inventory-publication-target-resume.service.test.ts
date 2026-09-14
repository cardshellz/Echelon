import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { canonicalJson } from "@shared/utils/canonical-json";
import { InventoryPublicationTargetResumeService } from "../../application/inventory-publication-target-resume.service";

const NOW = new Date("2026-09-14T12:00:00.000Z");
const HASH = "a".repeat(64);
const REVIEW_REQUEST = {
  publicationTargetId: 5,
  expectedRevision: "3",
  idempotencyKey: "resume-review-1",
  reason: "Revalidate the stopped Shopify target before restoring publication",
};
const RESUME_REQUEST = {
  publicationTargetId: 5,
  expectedRevision: "3",
  resumeReviewId: "71",
  expectedEvidenceHash: HASH,
  idempotencyKey: "resume-target-1",
  reason: "Restore the reviewed Shopify target after resolving the incident",
};

describe("InventoryPublicationTargetResumeService", () => {
  it("normalizes and hashes an actor-bound immutable readiness review", async () => {
    const review = vi.fn(async (command) => blockedReview(command));
    const resume = vi.fn();
    const service = new InventoryPublicationTargetResumeService(
      { review, resume },
      { now: () => NOW },
    );

    await expect(service.review({
      ...REVIEW_REQUEST,
      idempotencyKey: ` ${REVIEW_REQUEST.idempotencyKey} `,
      reason: ` ${REVIEW_REQUEST.reason} `,
    }, " operator-7 ")).resolves.toMatchObject({
      resumeReviewId: "71",
      publicationTargetId: 5,
      state: "blocked",
      alreadyApplied: false,
    });

    expect(review).toHaveBeenCalledWith({
      ...REVIEW_REQUEST,
      actorId: "operator-7",
      occurredAt: NOW,
      requestHash: createHash("sha256").update(canonicalJson({
        commandType: "inventory_publication_target_resume_review",
        actorId: "operator-7",
        request: REVIEW_REQUEST,
      }), "utf8").digest("hex"),
    });
    expect(resume).not.toHaveBeenCalled();
  });

  it("validates and hashes the exact reviewed resume command", async () => {
    const review = vi.fn();
    const resume = vi.fn(async (command) => ({
      publicationTargetId: command.publicationTargetId,
      revision: "4",
      state: "live" as const,
      activationRunId: "44",
      authorityRevision: "9",
      resumeReviewId: command.resumeReviewId,
      evidenceHash: command.expectedEvidenceHash,
      publicationRows: 3,
      alreadyApplied: false,
      runtimeAuthorityChanged: false as const,
      providerWriteAttempted: false as const,
      outboxEnqueued: true as const,
    }));
    const service = new InventoryPublicationTargetResumeService(
      { review, resume },
      { now: () => NOW },
    );

    await expect(service.resume(RESUME_REQUEST, "operator-7")).resolves.toMatchObject({
      publicationTargetId: 5,
      revision: "4",
      state: "live",
      publicationRows: 3,
      outboxEnqueued: true,
    });
    expect(resume).toHaveBeenCalledWith({
      ...RESUME_REQUEST,
      actorId: "operator-7",
      occurredAt: NOW,
      requestHash: createHash("sha256").update(canonicalJson({
        commandType: "inventory_publication_target_resume",
        actorId: "operator-7",
        request: RESUME_REQUEST,
      }), "utf8").digest("hex"),
    });
  });

  it("rejects malformed commands, missing actors, invalid clocks, and malformed store results", async () => {
    const store = { review: vi.fn(), resume: vi.fn() };
    const service = new InventoryPublicationTargetResumeService(store);
    await expect(service.review({ ...REVIEW_REQUEST, expectedRevision: "0" }, "operator-7"))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_RESUME_REVIEW_INVALID_REQUEST" });
    await expect(service.resume(RESUME_REQUEST, " "))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_RESUME_ACTOR_REQUIRED" });
    expect(store.review).not.toHaveBeenCalled();
    expect(store.resume).not.toHaveBeenCalled();

    const invalidClock = new InventoryPublicationTargetResumeService(store, {
      now: () => new Date(Number.NaN),
    });
    await expect(invalidClock.review(REVIEW_REQUEST, "operator-7"))
      .rejects.toMatchObject({ code: "INVENTORY_PUBLICATION_TARGET_RESUME_CLOCK_INVALID" });

    const malformedStore = new InventoryPublicationTargetResumeService({
      review: vi.fn(async () => ({ state: "ready" } as never)),
      resume: vi.fn(async () => ({ state: "preview" } as never)),
    }, { now: () => NOW });
    await expect(malformedStore.review(REVIEW_REQUEST, "operator-7")).rejects.toThrow();
    await expect(malformedStore.resume(RESUME_REQUEST, "operator-7")).rejects.toThrow();
  });
});

function blockedReview(command: {
  publicationTargetId: number;
  expectedRevision: string;
  actorId: string;
  reason: string;
}) {
  return {
    resumeReviewId: "71",
    publicationTargetId: command.publicationTargetId,
    publicationTargetRevision: command.expectedRevision,
    authorityRevision: "9",
    activationRunId: "44",
    state: "blocked" as const,
    configurationHash: HASH,
    readinessHash: HASH,
    evidenceHash: HASH,
    requestedBy: command.actorId,
    reason: command.reason,
    capturedAt: NOW.toISOString(),
    identityCensus: [],
    products: [],
    blockers: [{
      code: "INVENTORY_PUBLICATION_TARGET_RESUME_MAPPING_MISSING",
      message: "The target has no active mapping.",
      context: { publicationTargetId: command.publicationTargetId },
    }],
    runtimeAuthorityChanged: false as const,
    providerWriteAttempted: false as const,
    outboxEnqueued: false as const,
    alreadyApplied: false,
  };
}
