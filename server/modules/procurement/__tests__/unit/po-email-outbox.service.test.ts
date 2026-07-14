import { describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
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
      .mockResolvedValueOnce({ rows: [{ id: 42, status: "dead_letter" }] })
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
