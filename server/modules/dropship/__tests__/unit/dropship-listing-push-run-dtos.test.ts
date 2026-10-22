import { describe, expect, it, vi } from "vitest";
import {
  createListingPushRunRequestSchema,
  createListingPushRunResponseSchema,
  listingPushRunDetailResponseSchema,
} from "../../../../../shared/dropship/listing-push-runs";
import { createListingPushJobForMemberInputSchema } from "../../application/dropship-listing-dtos";
import { DropshipListingPreviewService } from "../../application/dropship-listing-preview-service";
import {
  createListingPushJobInputSchema,
  createListingPushRunInputSchema,
} from "../../application/dropship-use-case-dtos";

vi.mock("../../../../db", () => ({ pool: {}, db: {} }));

const BODY = { storeConnectionId: 22, scope: "not_live", idempotencyKey: "publish-0001", expectedSelectionRevisionId: 7 };

describe("publish run create body", () => {
  it("is strict: the store, the scope, a key and the expected revision, nothing else", () => {
    expect(createListingPushRunRequestSchema.parse(BODY)).toEqual(BODY);
    expect(createListingPushRunRequestSchema.safeParse({ ...BODY, productVariantIds: [1] }).success).toBe(false);
    expect(createListingPushRunRequestSchema.safeParse({ ...BODY, vendorId: 10 }).success).toBe(false);
    const { expectedSelectionRevisionId: _omit, ...withoutRevision } = BODY;
    expect(createListingPushRunRequestSchema.safeParse(withoutRevision).success).toBe(false);
  });

  it("takes 'not_live' or 'all' only", () => {
    expect(createListingPushRunRequestSchema.safeParse({ ...BODY, scope: "all" }).success).toBe(true);
    for (const scope of ["new", "everything", "", null]) {
      expect(createListingPushRunRequestSchema.safeParse({ ...BODY, scope }).success).toBe(false);
    }
  });

  it("bounds the key at 8 to 200 characters, as every dropship request key", () => {
    expect(createListingPushRunRequestSchema.safeParse({ ...BODY, idempotencyKey: "a".repeat(7) }).success).toBe(false);
    expect(createListingPushRunRequestSchema.safeParse({ ...BODY, idempotencyKey: "a".repeat(8) }).success).toBe(true);
    expect(createListingPushRunRequestSchema.safeParse({ ...BODY, idempotencyKey: "a".repeat(200) }).success).toBe(true);
    expect(createListingPushRunRequestSchema.safeParse({ ...BODY, idempotencyKey: "a".repeat(201) }).success).toBe(false);
  });

  it("names the selection the page counted from, or null for a vendor who never saved one", () => {
    expect(createListingPushRunRequestSchema.safeParse({ ...BODY, expectedSelectionRevisionId: null }).success).toBe(true);
    for (const value of [0, -1, 1.5, "7", 2_147_483_648]) {
      expect(createListingPushRunRequestSchema.safeParse({ ...BODY, expectedSelectionRevisionId: value }).success).toBe(false);
    }
  });

  it("the service input adds the vendor and an actor of the runs table's types, never a job", () => {
    const input = { ...BODY, vendorId: 10, actor: { actorType: "vendor", actorId: "member-10" } };
    expect(createListingPushRunInputSchema.safeParse(input).success).toBe(true);
    expect(createListingPushRunInputSchema.safeParse({ ...input, actor: { actorType: "job" } }).success).toBe(false);
  });

  it("answers carry the run with ISO times and bounded pages", () => {
    const run = { runId: 4, storeConnectionId: 22, scope: "all", status: "processing", stopReason: null, selectionRevisionId: 7,
      targetCount: 1_234, chunkSize: 500, chunkCount: 3, nextChunkIndex: 1, cancelRequestedAt: null,
      createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:00:00.000Z", completedAt: null };
    expect(createListingPushRunResponseSchema.parse({ run, idempotentReplay: false }).run.runId).toBe(4);
    expect(createListingPushRunResponseSchema.safeParse({ run: { ...run, createdAt: new Date() }, idempotentReplay: false }).success).toBe(false);
    const counts = { pending: 0, queued: 0, completed: 0, failed: 0, blocked: 0, skipped: 0, price_review: 0, stale: 0, cancelled: 0 };
    const problem = { productVariantId: 1, productId: 1, productName: "P", variantName: "S", sku: "X", outcome: "failed",
      code: "C", message: null, retryable: true };
    const progress = { waitingUntil: null, drafts: 0 };
    expect(listingPushRunDetailResponseSchema.safeParse({ run, counts, problems: { items: Array(50).fill(problem), nextCursor: 1 }, ...progress }).success).toBe(true);
    expect(listingPushRunDetailResponseSchema.safeParse({ run, counts, problems: { items: Array(51).fill(problem), nextCursor: 1 }, ...progress }).success).toBe(false);
    expect(listingPushRunDetailResponseSchema.safeParse({ run, counts, problems: { items: [{ ...problem, outcome: "completed" }], nextCursor: null },
      ...progress }).success).toBe(false);
  });

  it("a run's detail says when a paused run goes on and how many sizes were saved as drafts (review DUX5, DUX7)", () => {
    const run = { runId: 4, storeConnectionId: 22, scope: "all", status: "processing", stopReason: null, selectionRevisionId: 7,
      targetCount: 3, chunkSize: 500, chunkCount: 1, nextChunkIndex: 1, cancelRequestedAt: null,
      createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:00:00.000Z", completedAt: null };
    const counts = { pending: 0, queued: 3, completed: 0, failed: 0, blocked: 0, skipped: 0, price_review: 0, stale: 0, cancelled: 0 };
    const base = { run, counts, problems: { items: [], nextCursor: null } };
    expect(listingPushRunDetailResponseSchema.safeParse({ ...base, waitingUntil: "2026-10-20T12:31:00.000Z", drafts: 2 }).success).toBe(true);
    for (const wrong of [{ waitingUntil: "soon", drafts: 0 }, { waitingUntil: null, drafts: -1 }, { waitingUntil: null }, { drafts: 0 }]) {
      expect(listingPushRunDetailResponseSchema.safeParse({ ...base, ...wrong }).success).toBe(false);
    }
  });

  it("answers tolerate a field a later release adds, and still refuse one they need missing (review DUX13; CHK7)", () => {
    const run = { runId: 4, storeConnectionId: 22, scope: "all", status: "processing", stopReason: null, selectionRevisionId: 7,
      targetCount: 3, chunkSize: 500, chunkCount: 1, nextChunkIndex: 1, cancelRequestedAt: null,
      createdAt: "2026-10-20T12:00:00.000Z", updatedAt: "2026-10-20T12:00:00.000Z", completedAt: null };
    const later = createListingPushRunResponseSchema.parse({ run: { ...run, endState: "x" }, idempotentReplay: false, picked: 1 });
    // Extra fields are dropped, never kept or refused.
    expect(later).toEqual({ run, idempotentReplay: false });
    const { targetCount: _missing, ...short } = run;
    expect(createListingPushRunResponseSchema.safeParse({ run: short, idempotentReplay: false }).success).toBe(false);
    // Request bodies stay strict.
    expect(createListingPushRunRequestSchema.safeParse({ ...BODY, extra: 1 }).success).toBe(false);
  });
});

describe("reserved push job keys (SAFETY14)", () => {
  const RESERVED = "dropship-run:10:4:0";

  it("the internal job input accepts a run chunk and its reserved key; the vendor's job input has no run", () => {
    const internal = createListingPushJobInputSchema.parse({ vendorId: 10, storeConnectionId: 22, productVariantIds: [101],
      reviewMode: "current_preview", idempotencyKey: RESERVED, requestedBy: { actorType: "vendor", actorId: "member-10" },
      run: { runId: 4, chunkIndex: 0 } });
    expect(internal.run).toEqual({ runId: 4, chunkIndex: 0 });
    expect(Object.keys(createListingPushJobForMemberInputSchema.shape)).not.toContain("run");
    expect(createListingPushJobForMemberInputSchema.safeParse({ storeConnectionId: 22, productVariantIds: [101],
      idempotencyKey: "push-key-0001", run: { runId: 4, chunkIndex: 0 } }).success).toBe(false);
  });

  it("the vendor job route refuses a key in the reserved prefix before anything is read or written", async () => {
    const provisionForMember = vi.fn();
    const service = new DropshipListingPreviewService({ vendorProvisioning: { provisionForMember } } as never);
    await expect(service.createListingPushJobForMember("member-10", {
      storeConnectionId: 22, productVariantIds: [101], reviewMode: "current_preview", idempotencyKey: RESERVED,
    })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_KEY_RESERVED" });
    await expect(service.createListingPushJobForMember("member-10", {
      storeConnectionId: 22, productVariantIds: [101], reviewMode: "current_preview", idempotencyKey: `  ${RESERVED}`,
    })).rejects.toMatchObject({ code: "DROPSHIP_IDEMPOTENCY_KEY_RESERVED" });
    expect(provisionForMember).not.toHaveBeenCalled();
  });
});
