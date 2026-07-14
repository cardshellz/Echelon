import { describe, expect, it, vi } from "vitest";
import {
  classifyDeliveryError,
  computeNextAttemptAt,
  processPoEmailOutboxBatch,
} from "../../po-email-outbox.worker";

const claimedDelivery = {
  id: 42,
  purchaseOrderId: 7,
  toEmail: "vendor@example.com",
  ccEmail: "buyer@example.com",
  subject: "Purchase Order PO-7",
  htmlBody: "<html>snapshot</html>",
  textBody: "snapshot",
  messageId: "<po-7.stable@example.com>",
  attemptCount: 1,
  maxAttempts: 10,
  leaseToken: "lease-1",
  createdBy: "user-1",
};

describe("PO email outbox worker", () => {
  it("delivers a claimed snapshot and atomically appends PO history", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [claimedDelivery] });
    const clientQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("UPDATE procurement.po_email_outbox")) return { rowCount: 1, rows: [{ id: 42 }] };
      return { rowCount: 1, rows: [] };
    });
    const release = vi.fn();
    const deliver = vi.fn().mockResolvedValue({
      messageId: "<provider-id@example.com>",
      response: "250 queued",
      accepted: ["vendor@example.com"],
      rejected: [],
    });

    const result = await processPoEmailOutboxBatch({
      dbPool: {
        query: poolQuery,
        connect: vi.fn().mockResolvedValue({ query: clientQuery, release }),
      },
      deliver,
      now: new Date("2026-07-14T12:00:00.000Z"),
    });

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, deadLettered: 0 });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      html: "<html>snapshot</html>",
      messageId: "<po-7.stable@example.com>",
    }));
    expect(clientQuery.mock.calls.some(([sql]) => String(sql).includes("INSERT INTO procurement.po_status_history"))).toBe(true);
    expect(clientQuery.mock.calls.map(([sql]) => sql)).toContain("COMMIT");
    expect(release).toHaveBeenCalled();
  });

  it("returns a transient SMTP failure to the queue with backoff", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [claimedDelivery] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "queued" }] });
    const smtpError = Object.assign(new Error("temporary upstream failure"), {
      code: "ETIMEDOUT",
      responseCode: 421,
    });

    const result = await processPoEmailOutboxBatch({
      dbPool: { query: poolQuery },
      deliver: vi.fn().mockRejectedValue(smtpError),
      now: new Date("2026-07-14T12:00:00.000Z"),
    });

    expect(result).toEqual({ claimed: 1, sent: 0, retried: 1, deadLettered: 0 });
    expect(poolQuery.mock.calls[2][1]).toEqual(expect.arrayContaining([
      42,
      "lease-1",
      "queued",
      new Date("2026-07-14T12:01:00.000Z"),
    ]));
  });

  it("records partial acceptance as terminal instead of duplicating accepted recipients", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [claimedDelivery] });
    const clientQuery = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("UPDATE procurement.po_email_outbox")) return { rowCount: 1, rows: [{ id: 42 }] };
      return { rowCount: 1, rows: [] };
    });
    const deliver = vi.fn().mockResolvedValue({
      messageId: "<provider-id@example.com>",
      response: "250 accepted with one rejected recipient",
      accepted: ["vendor@example.com"],
      rejected: ["buyer@example.com"],
    });

    const result = await processPoEmailOutboxBatch({
      dbPool: {
        query: poolQuery,
        connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
      },
      deliver,
      now: new Date("2026-07-14T12:00:00.000Z"),
    });

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, deadLettered: 0 });
    const updateCall = clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE procurement.po_email_outbox"));
    expect(updateCall?.[1]).toEqual(expect.arrayContaining([
      "partially_sent",
      "PARTIAL_RECIPIENT_REJECTION",
    ]));
  });

  it("dead-letters deterministic recipient failures without retrying", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [claimedDelivery] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "dead_letter" }] });
    const smtpError = Object.assign(new Error("recipient rejected"), {
      code: "EENVELOPE",
      responseCode: 550,
    });

    const result = await processPoEmailOutboxBatch({
      dbPool: { query: poolQuery },
      deliver: vi.fn().mockRejectedValue(smtpError),
      now: new Date("2026-07-14T12:00:00.000Z"),
    });

    expect(result).toEqual({ claimed: 1, sent: 0, retried: 0, deadLettered: 1 });
    expect(poolQuery.mock.calls[2][1][2]).toBe("dead_letter");
  });
});

describe("PO email retry policy", () => {
  it("classifies SMTP 5xx and envelope failures as permanent", () => {
    expect(classifyDeliveryError({ code: "EENVELOPE", responseCode: 550 })).toMatchObject({ permanent: true });
    expect(classifyDeliveryError({ code: "ETIMEDOUT", responseCode: 421 })).toMatchObject({ permanent: false });
  });

  it("uses bounded exponential backoff", () => {
    const now = new Date("2026-07-14T12:00:00.000Z");
    expect(computeNextAttemptAt(now, 1)).toEqual(new Date("2026-07-14T12:01:00.000Z"));
    expect(computeNextAttemptAt(now, 10)).toEqual(new Date("2026-07-14T18:00:00.000Z"));
  });
});
