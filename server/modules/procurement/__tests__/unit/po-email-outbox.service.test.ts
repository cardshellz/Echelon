import { describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { poEmailDocumentHash } from "../../po-email-document-contract";
import {
  enqueuePurchaseOrderEmail,
  PoEmailOutboxError,
  replayDeadLetterPurchaseOrderEmail,
} from "../../po-email-outbox.service";

const delivery = {
  id: 42,
  purchaseOrderId: 7,
  status: "queued",
  toEmail: "vendor@example.com",
  ccEmail: null,
  subject: "Purchase Order PO-7",
  attemptCount: 0,
  maxAttempts: 10,
  nextAttemptAt: new Date(),
  providerMessageId: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  sentAt: null,
  deadLetteredAt: null,
  replayOfId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  contractVersion: 1,
  documentHash: poEmailDocumentHash("<html>immutable PO</html>"),
  sourceRevision: "a".repeat(64),
  documentPurpose: "current_copy",
  documentHoldReason: null,
  documentHeldAt: null,
};

describe("PO email outbox enqueue", () => {
  it("snapshots and queues a new delivery", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [delivery] });
    const buildSnapshot = vi.fn().mockResolvedValue({
      subject: delivery.subject,
      html: "<html>immutable PO</html>",
      text: "immutable PO",
      poNumber: "PO-7",
      contractVersion: 1,
      documentHash: delivery.documentHash,
      sourceRevision: delivery.sourceRevision,
      documentPurpose: delivery.documentPurpose,
    });

    const result = await enqueuePurchaseOrderEmail({
      purchaseOrderId: 7,
      toEmail: " vendor@example.com ",
      message: " Please confirm ",
      idempotencyKey: "intent-123",
      createdBy: "user-1",
    }, { dbPool: { query }, buildSnapshot });

    expect(result).toEqual({ delivery, replayed: false });
    expect(buildSnapshot).toHaveBeenCalledWith({ poId: 7, message: "Please confirm" });
    expect(query.mock.calls[1][1]).toEqual(expect.arrayContaining([
      7,
      "intent-123",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "vendor@example.com",
      null,
      delivery.subject,
      "<html>immutable PO</html>",
    ]));
  });

  it("replays the original delivery without rebuilding mutable PO content", async () => {
    const requestHash = createHash("sha256").update(JSON.stringify({
      purchaseOrderId: 7,
      toEmail: "vendor@example.com",
      ccEmail: null,
      message: null,
    })).digest("hex");
    const replayBuild = vi.fn();
    const result = await enqueuePurchaseOrderEmail({
      purchaseOrderId: 7,
      toEmail: "vendor@example.com",
      idempotencyKey: "intent-123",
    }, {
      dbPool: {
        query: vi.fn().mockResolvedValue({ rows: [{ ...delivery, requestHash }] }),
      },
      buildSnapshot: replayBuild,
    });

    expect(result).toEqual({ delivery, replayed: true });
    expect(replayBuild).not.toHaveBeenCalled();
  });

  it("rejects reuse of an idempotency key for a different request", async () => {
    const dbPool = {
      query: vi.fn().mockResolvedValue({ rows: [{ ...delivery, requestHash: "different" }] }),
    };
    await expect(enqueuePurchaseOrderEmail({
      purchaseOrderId: 7,
      toEmail: "other@example.com",
      idempotencyKey: "intent-123",
    }, { dbPool, buildSnapshot: vi.fn() })).rejects.toMatchObject<Partial<PoEmailOutboxError>>({
      statusCode: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    });
  });
});

describe("PO email dead-letter replay", () => {
  it("copies the immutable snapshot into a new queued delivery", async () => {
    const replay = { ...delivery, id: 43, replayOfId: 42 };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ...delivery, status: "dead_letter", html: "<html>immutable PO</html>" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [replay] });
    const result = await replayDeadLetterPurchaseOrderEmail({
      purchaseOrderId: 7,
      deliveryId: 42,
      idempotencyKey: "replay-intent-1",
      createdBy: "operator-1",
      dbPool: { query },
    });

    expect(result).toEqual({ delivery: replay, replayed: false });
    expect(query.mock.calls[2][0]).toContain("html_body, text_body");
  });

  it("refuses to replay a delivery that is not dead-lettered", async () => {
    await expect(replayDeadLetterPurchaseOrderEmail({
      purchaseOrderId: 7,
      deliveryId: 42,
      idempotencyKey: "replay-intent-1",
      dbPool: { query: vi.fn().mockResolvedValue({ rows: [{ id: 42, status: "sent" }] }) },
    })).rejects.toMatchObject<Partial<PoEmailOutboxError>>({
      statusCode: 409,
      code: "DELIVERY_NOT_DEAD_LETTERED",
    });
  });
});

describe("PO email verified document gate", () => {
  it.each([
    { contractVersion: null },
    { contractVersion: 2 },
    { documentHash: "0".repeat(64) },
    { sourceRevision: "" },
    { documentPurpose: "draft_preview" },
    { documentPurpose: "cancelled_record" },
  ])("rejects an unsupported or mismatched new snapshot: %j", async (patch) => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const buildSnapshot = vi.fn().mockResolvedValue({
      ...delivery, html: "<html>immutable PO</html>", text: "PO", poNumber: "PO-7", ...patch,
    });
    await expect(enqueuePurchaseOrderEmail({
      purchaseOrderId: 7, toEmail: "vendor@example.com", idempotencyKey: "unsafe-new",
    }, { dbPool: { query }, buildSnapshot })).rejects.toMatchObject({ statusCode: 409 });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("returns the original held intent visibly without rebuilding or queueing", async () => {
    const requestHash = createHash("sha256").update(JSON.stringify({
      purchaseOrderId: 7, toEmail: "vendor@example.com", ccEmail: null, message: null,
    })).digest("hex");
    const held = { ...delivery, documentHoldReason: "LEGACY_DOCUMENT_UNVERIFIED", documentHeldAt: new Date() };
    const query = vi.fn().mockResolvedValue({ rows: [{ ...held, requestHash }] });
    const buildSnapshot = vi.fn();
    const result = await enqueuePurchaseOrderEmail({
      purchaseOrderId: 7, toEmail: "vendor@example.com", idempotencyKey: "existing-held",
    }, { dbPool: { query }, buildSnapshot });
    expect(result).toEqual({ delivery: held, replayed: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(buildSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    { documentHoldReason: "LEGACY_DOCUMENT_UNVERIFIED" },
    { contractVersion: null },
    { contractVersion: 2 },
    { documentHash: "0".repeat(64) },
    { documentPurpose: "draft_preview" },
  ])("does not copy an unsafe failed snapshot on replay: %j", async (patch) => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      ...delivery, status: "dead_letter", html: "<html>immutable PO</html>", ...patch,
    }] });
    await expect(replayDeadLetterPurchaseOrderEmail({
      purchaseOrderId: 7, deliveryId: 42, idempotencyKey: "unsafe-replay", dbPool: { query },
    })).rejects.toMatchObject({ statusCode: 409 });
    expect(query).toHaveBeenCalledTimes(1);
  });
});

describe("PO document rejection observability and hold races", () => {
  it("logs rejection identity without the supplier message or snapshot", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const failure = Object.assign(new Error("Sensitive snapshot content"), { code: "PURCHASE_ORDER_DOCUMENT_CANCELLED" });
      await expect(enqueuePurchaseOrderEmail({
        purchaseOrderId: 7, toEmail: "private@example.com", message: "Private note",
        idempotencyKey: "rejected", createdBy: "actor-7",
      }, { dbPool: { query: vi.fn().mockResolvedValue({ rows: [] }) }, buildSnapshot: vi.fn().mockRejectedValue(failure) }))
        .rejects.toBe(failure);
      expect(warning).toHaveBeenCalledWith("[PO Email Outbox] Enqueue rejected", {
        code: "PURCHASE_ORDER_DOCUMENT_CANCELLED", purchaseOrderId: 7, actorId: "actor-7",
      });
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/Sensitive snapshot|Private note|private@example/);
    } finally { warning.mockRestore(); }
  });

  it("returns a document conflict when a failed snapshot is held between replay read and insert", async () => {
    const source = { ...delivery, status: "dead_letter", html: "<html>immutable PO</html>" };
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [source] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ ...source, documentHoldReason: "DOCUMENT_HASH_MISMATCH" }] });
    await expect(replayDeadLetterPurchaseOrderEmail({
      purchaseOrderId: 7, deliveryId: 42, idempotencyKey: "racing-replay", dbPool: { query },
    })).rejects.toMatchObject({ code: "PURCHASE_ORDER_DOCUMENT_UNVERIFIED", statusCode: 409 });
    expect(query).toHaveBeenCalledTimes(5);
  });
});
