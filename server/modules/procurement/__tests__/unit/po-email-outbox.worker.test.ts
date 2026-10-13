import { describe, expect, it, vi } from "vitest";
import { poEmailDocumentHash } from "../../po-email-document-contract";
import {
  claimDeliveries,
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
  contractVersion: 1,
  documentHash: poEmailDocumentHash("<html>snapshot</html>"),
  sourceRevision: "b".repeat(64),
  documentPurpose: "current_copy",
  documentHoldReason: null,
};

describe("PO email outbox worker", () => {
  it("delivers a claimed snapshot and atomically appends PO history", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
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

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, deadLettered: 0, held: 0 });
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

    expect(result).toEqual({ claimed: 1, sent: 0, retried: 1, deadLettered: 0, held: 0 });
    expect(poolQuery.mock.calls[3][1]).toEqual(expect.arrayContaining([
      42,
      "lease-1",
      "queued",
      new Date("2026-07-14T12:01:00.000Z"),
    ]));
  });

  it("records partial acceptance as terminal instead of duplicating accepted recipients", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
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

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, deadLettered: 0, held: 0 });
    const updateCall = clientQuery.mock.calls.find(([sql]) => String(sql).includes("UPDATE procurement.po_email_outbox"));
    expect(updateCall?.[1]).toEqual(expect.arrayContaining([
      "partially_sent",
      "PARTIAL_RECIPIENT_REJECTION",
    ]));
  });

  it("dead-letters deterministic recipient failures without retrying", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
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

    expect(result).toEqual({ claimed: 1, sent: 0, retried: 0, deadLettered: 1, held: 0 });
    expect(poolQuery.mock.calls[3][1][2]).toBe("dead_letter");
    // The dead-letter time is a plain value: comparing the status parameter
    // with a literal in SQL made PostgreSQL refuse the statement.
    expect(String(poolQuery.mock.calls[3][0])).toContain("dead_lettered_at = $8");
    expect(String(poolQuery.mock.calls[3][0])).not.toContain("CASE WHEN $3");
    expect(poolQuery.mock.calls[3][1][7]).toEqual(new Date("2026-07-14T12:00:00.000Z"));
  });

  it("keeps a retried delivery's dead-letter time empty", async () => {
    const poolQuery = vi.fn()
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [claimedDelivery] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ status: "queued" }] });

    const result = await processPoEmailOutboxBatch({
      dbPool: { query: poolQuery },
      deliver: vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEDOUT", responseCode: 421 })),
      now: new Date("2026-07-14T12:00:00.000Z"),
    });

    expect(result).toEqual({ claimed: 1, sent: 0, retried: 1, deadLettered: 0, held: 0 });
    expect(poolQuery.mock.calls[3][1][2]).toBe("queued");
    expect(poolQuery.mock.calls[3][1][7]).toBeNull();
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

describe("PO email worker content gate", () => {
  it.each([
    { contractVersion: null },
    { contractVersion: 2 },
    { sourceRevision: null },
    { documentPurpose: "cancelled_record" },
    { htmlBody: "<html>tampered after certification</html>" },
  ])("holds an unsafe claimed snapshot without contacting SMTP: %j", async (patch) => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ ...claimedDelivery, ...patch }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{
        deliveryId: 42, poId: 7, newHoldReason: "DOCUMENT_HASH_MISMATCH",
        heldAt: new Date("2026-10-12T12:00:00Z"),
      }], rowCount: 1 });
    const deliver = vi.fn();
    const result = await processPoEmailOutboxBatch({
      dbPool: { query }, deliver, now: new Date("2026-10-12T12:00:00Z"),
    });
    expect(result).toEqual({ claimed: 1, sent: 0, retried: 0, deadLettered: 0, held: 1 });
    expect(deliver).not.toHaveBeenCalled();
    expect(query.mock.calls[3][0]).toContain("document_hold_reason = $3");
    expect(query.mock.calls[3][0]).not.toContain("html_body =");
  });
});

describe("PO email document hold audit logging", () => {
  const now = new Date("2026-10-12T12:00:00Z");
  const expectedAudit = {
    event: "po_email_document_hold_applied", actorType: "system", actorId: "po_email_outbox_worker",
    deliveryId: 42, poId: 7, previousHold: null, newHoldReason: "DOCUMENT_HASH_MISMATCH", heldAt: now.toISOString(),
  };
  const returnedHold = {
    deliveryId: 42, poId: 7, newHoldReason: "DOCUMENT_HASH_MISMATCH", heldAt: now,
    // Even an adapter returning extra data must not leak it into the audit event.
    toEmail: "private-vendor@example.com", subject: "Private subject", htmlBody: "<html>Secret terms</html>",
  };

  it("logs only new sweep holds, using one minimal JSON event per affected delivery", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [returnedHold, { ...returnedHold, deliveryId: 43, poId: 8 }], rowCount: 2 })
        .mockResolvedValue({ rows: [], rowCount: 0 });
      const input = { batchSize: 10, leaseSeconds: 120, now };
      await claimDeliveries({ query }, input);
      await claimDeliveries({ query }, input); // Already held rows are not returned or logged again.
      expect(warning.mock.calls.map(([entry]) => JSON.parse(entry))).toEqual([
        expectedAudit, { ...expectedAudit, deliveryId: 43, poId: 8 },
      ]);
      expect(warning.mock.calls.every(call => call.length === 1)).toBe(true);
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-vendor|Private subject|Secret terms|htmlBody|toEmail/);
      expect(query.mock.calls[0][0]).toContain('RETURNING id AS "deliveryId"');
    } finally { warning.mockRestore(); }
  });

  it("logs a persisted claimed hold without exposing the message or recipients", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ ...claimedDelivery, htmlBody: "<html>Secret terms</html>" }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [returnedHold], rowCount: 1 });
      const deliver = vi.fn();
      await processPoEmailOutboxBatch({ dbPool: { query }, deliver, now });
      expect(warning).toHaveBeenCalledExactlyOnceWith(JSON.stringify(expectedAudit));
      expect(deliver).not.toHaveBeenCalled();
      expect(JSON.stringify(warning.mock.calls)).not.toMatch(/private-vendor|Private subject|Secret terms|htmlBody|toEmail/);
    } finally { warning.mockRestore(); }
  });

  it("does not claim an audit event when the hold write loses its lease", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ ...claimedDelivery, contractVersion: null }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });
      await expect(processPoEmailOutboxBatch({ dbPool: { query }, deliver: vi.fn(), now }))
        .rejects.toThrow("lost its lease while recording a document hold");
      expect(warning).not.toHaveBeenCalled();
    } finally { warning.mockRestore(); }
  });
});
