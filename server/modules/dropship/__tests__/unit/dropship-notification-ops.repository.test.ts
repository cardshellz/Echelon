import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import { PgDropshipNotificationOpsRepository } from "../../infrastructure/dropship-notification-ops.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const now = new Date("2026-05-07T19:15:00.000Z");

describe("PgDropshipNotificationOpsRepository", () => {
  it("moves failed email events to pending and records an ops audit event before retry delivery", async () => {
    let selectCount = 0;
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_notification_events ne") && sqlText.includes("FOR UPDATE OF ne")) {
        selectCount += 1;
        return {
          rows: [
            makeNotificationRow({
              status: selectCount === 1 ? "failed" : "pending",
              delivered_at: null,
            }),
          ],
        };
      }
      if (sqlText.includes("UPDATE dropship.dropship_notification_events")) {
        return { rows: [] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipNotificationOpsRepository(makePool(makeClient(query)));

    const result = await repository.prepareEmailRetry(makeRetryInput());

    expect(result).toMatchObject({
      previousStatus: "failed",
      event: {
        notificationEventId: 72,
        status: "pending",
        channel: "email",
      },
    });

    const updateCall = query.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_notification_events"),
    );
    expect(String(updateCall?.[0])).toContain("AND status = 'failed'");
    expect(updateCall?.[1]).toEqual([72, 10]);

    const auditCall = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(auditCall?.[1]).toEqual([
      10,
      "72",
      "notification_email_retry_requested",
      "admin",
      "ops-user",
      "info",
      JSON.stringify({
        idempotencyKey: "notification-retry-72",
        previousStatus: "failed",
        reason: "SMTP outage cleared",
      }),
      now,
    ]);
  });

  it("rejects delivered email retries without updating or auditing", async () => {
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "ROLLBACK") {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_notification_events ne") && sqlText.includes("FOR UPDATE OF ne")) {
        return { rows: [makeNotificationRow({ status: "delivered" })] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipNotificationOpsRepository(makePool(makeClient(query)));

    await expect(repository.prepareEmailRetry(makeRetryInput())).rejects.toMatchObject({
      code: "DROPSHIP_NOTIFICATION_OPS_STATUS_NOT_RETRYABLE",
      context: {
        notificationEventId: 72,
        channel: "email",
        status: "delivered",
      },
    });
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_notification_events"),
    )).toBe(false);
    expect(query.mock.calls.some((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    )).toBe(false);
  });

  it("records retry delivery outcome with failure context", async () => {
    const query = vi.fn(async (sql: string) => {
      const sqlText = String(sql);
      if (sqlText === "BEGIN" || sqlText === "COMMIT") {
        return { rows: [] };
      }
      if (sqlText.includes("UPDATE dropship.dropship_notification_events")) {
        return { rows: [] };
      }
      if (sqlText.includes("FROM dropship.dropship_notification_events ne") && sqlText.includes("FOR UPDATE OF ne")) {
        return { rows: [makeNotificationRow({ status: "failed", delivered_at: null })] };
      }
      if (sqlText.includes("INSERT INTO dropship.dropship_audit_events")) {
        return { rows: [] };
      }
      throw new Error(`Unexpected SQL in test: ${sqlText}`);
    });
    const repository = new PgDropshipNotificationOpsRepository(makePool(makeClient(query)));

    const result = await repository.updateEmailRetryDelivery({
      vendorId: 10,
      notificationEventId: 72,
      status: "failed",
      deliveredAt: null,
      failureCode: "DROPSHIP_NOTIFICATION_EMAIL_SEND_FAILED",
      failureMessage: "SMTP timeout",
      actor: { actorType: "admin", actorId: "ops-user" },
      idempotencyKey: "notification-retry-72",
      now,
    });

    expect(result).toMatchObject({
      notificationEventId: 72,
      status: "failed",
    });
    const updateCall = query.mock.calls.find((call) =>
      String(call[0]).includes("UPDATE dropship.dropship_notification_events"),
    );
    expect(updateCall?.[1]).toEqual([72, 10, "failed", null]);

    const auditCall = query.mock.calls.find((call) =>
      String(call[0]).includes("INSERT INTO dropship.dropship_audit_events"),
    );
    expect(auditCall?.[1]).toEqual([
      10,
      "72",
      "notification_email_retry_failed",
      "admin",
      "ops-user",
      "error",
      JSON.stringify({
        idempotencyKey: "notification-retry-72",
        status: "failed",
        failureCode: "DROPSHIP_NOTIFICATION_EMAIL_SEND_FAILED",
        failureMessage: "SMTP timeout",
      }),
      now,
    ]);
  });
});

function makeRetryInput() {
  return {
    notificationEventId: 72,
    idempotencyKey: "notification-retry-72",
    reason: "SMTP outage cleared",
    actor: { actorType: "admin" as const, actorId: "ops-user" },
    now,
  };
}

function makeNotificationRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 72,
    vendor_id: 10,
    event_type: "dropship_order_rejected",
    channel: "email",
    critical: true,
    title: "Order rejected",
    message: "Order rejected.",
    payload: { intakeId: 55 },
    status: "failed",
    delivered_at: null,
    read_at: null,
    idempotency_key: "notification-order-rejected-55",
    request_hash: "request-hash",
    created_at: now,
    member_id: "member-1",
    business_name: "Vendor",
    email: "vendor@cardshellz.test",
    vendor_status: "active",
    entitlement_status: "active",
    ...overrides,
  };
}

function makeClient(query: ReturnType<typeof vi.fn>): PoolClient {
  return { query, release: vi.fn() } as unknown as PoolClient;
}

function makePool(client: PoolClient): Pool {
  return { connect: vi.fn(async () => client) } as unknown as Pool;
}
