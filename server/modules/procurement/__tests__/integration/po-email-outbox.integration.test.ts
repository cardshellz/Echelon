import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "dotenv";
import pg from "pg";
import {
  claimDeliveries,
  processPoEmailOutboxBatch,
} from "../../po-email-outbox.worker";

config({ path: resolve(process.cwd(), ".env.test") });

const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;
const migrationSql = readFileSync(
  resolve(process.cwd(), "migrations/138_po_email_outbox.sql"),
  "utf8",
);

function sslConfig(connectionString: string) {
  return /localhost|127\.0\.0\.1/.test(connectionString)
    ? false
    : { rejectUnauthorized: false };
}

async function expectDatabaseError(
  operation: () => Promise<unknown>,
  code: string,
): Promise<void> {
  let error: unknown;
  try {
    await operation();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeTruthy();
  expect((error as { code?: string }).code).toBe(code);
}

describeWithDisposableDb.sequential("PO email outbox PostgreSQL guarantees", () => {
  const actorId = "po-email-outbox-integration-user";
  const purchaseOrderId = 71001;
  let pool: pg.Pool;

  beforeAll(async () => {
    const productionUrls = [
      process.env.DATABASE_URL,
      ].filter((value): value is string => Boolean(value));
    if (productionUrls.includes(TEST_DB_URL!)) {
      throw new Error(
        "ECHELON_TEST_DATABASE_URL must not equal DATABASE_URL",
      );
    }
    if (!DISPOSABLE_DB) {
      throw new Error("PO email outbox integration tests require an explicitly disposable database");
    }

    pool = new pg.Pool({
      connectionString: TEST_DB_URL,
      max: 8,
      ssl: sslConfig(TEST_DB_URL!),
    });
    await pool.query(`
      CREATE SCHEMA identity;
      CREATE SCHEMA procurement;

      CREATE TABLE identity.users (
        id VARCHAR PRIMARY KEY
      );

      CREATE TABLE procurement.purchase_orders (
        id INTEGER PRIMARY KEY
      );

      CREATE TABLE procurement.po_status_history (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        purchase_order_id INTEGER NOT NULL
          REFERENCES procurement.purchase_orders(id) ON DELETE CASCADE,
        from_status VARCHAR(20),
        to_status VARCHAR(20) NOT NULL,
        changed_by VARCHAR REFERENCES identity.users(id) ON DELETE SET NULL,
        notes TEXT
      );
    `);
    await pool.query(migrationSql);
    await pool.query("INSERT INTO identity.users (id) VALUES ($1)", [actorId]);
    await pool.query("INSERT INTO procurement.purchase_orders (id) VALUES ($1)", [purchaseOrderId]);
  });

  beforeEach(async () => {
    await pool.query(`
      TRUNCATE procurement.po_email_outbox, procurement.po_status_history
      RESTART IDENTITY
    `);
  });

  afterAll(async () => {
    if (pool) {
      await pool.query("DROP SCHEMA procurement CASCADE");
      await pool.query("DROP SCHEMA identity CASCADE");
      await pool.end();
    }
  });

  async function insertDelivery(input: {
    key: string;
    messageId: string;
    toEmail?: string;
  }): Promise<number> {
    const result = await pool.query<{ id: number }>(
      `INSERT INTO procurement.po_email_outbox (
         purchase_order_id, idempotency_key, request_hash,
         to_email, subject, html_body, text_body, message_id, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        purchaseOrderId,
        input.key,
        input.key.padEnd(64, "0").slice(0, 64),
        input.toEmail ?? "vendor@example.com",
        "Purchase Order PO-71001",
        "<html>immutable snapshot</html>",
        "immutable snapshot",
        input.messageId,
        actorId,
      ],
    );
    return result.rows[0].id;
  }

  it("enforces request idempotency, snapshot immutability, and terminal timestamps", async () => {
    const deliveryId = await insertDelivery({
      key: "po-email-intent-1",
      messageId: "<po-71001.intent-1@example.test>",
    });

    await expectDatabaseError(
      () => insertDelivery({
        key: "po-email-intent-1",
        messageId: "<po-71001.intent-duplicate@example.test>",
      }),
      "23505",
    );
    await expectDatabaseError(
      () => pool.query(
        "UPDATE procurement.po_email_outbox SET html_body = '<html>mutated</html>' WHERE id = $1",
        [deliveryId],
      ),
      "23514",
    );
    await expectDatabaseError(
      () => pool.query(
        "UPDATE procurement.po_email_outbox SET status = 'sent' WHERE id = $1",
        [deliveryId],
      ),
      "23514",
    );
  });

  it("claims due rows once across concurrent workers", async () => {
    await insertDelivery({
      key: "po-email-concurrent-1",
      messageId: "<po-71001.concurrent-1@example.test>",
    });
    await insertDelivery({
      key: "po-email-concurrent-2",
      messageId: "<po-71001.concurrent-2@example.test>",
    });
    const now = new Date(Date.now() + 1_000);

    const [first, second] = await Promise.all([
      claimDeliveries(pool, { batchSize: 1, leaseSeconds: 120, now }),
      claimDeliveries(pool, { batchSize: 1, leaseSeconds: 120, now }),
    ]);

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].id).not.toBe(second[0].id);
    const stored = await pool.query<{ status: string; attempt_count: number }>(
      `SELECT status, attempt_count
       FROM procurement.po_email_outbox
       ORDER BY id`,
    );
    expect(stored.rows).toEqual([
      { status: "processing", attempt_count: 1 },
      { status: "processing", attempt_count: 1 },
    ]);
  });

  it("commits provider acceptance and PO history in one database transaction", async () => {
    const messageId = "<po-71001.delivery@example.test>";
    const deliveryId = await insertDelivery({
      key: "po-email-delivery-1",
      messageId,
    });
    const deliver = vi.fn().mockResolvedValue({
      messageId: "<provider-accepted@example.test>",
      response: "250 queued",
      accepted: ["vendor@example.com"],
      rejected: [],
    });

    const result = await processPoEmailOutboxBatch({
      dbPool: pool,
      deliver,
      batchSize: 1,
      now: new Date(Date.now() + 1_000),
    });

    expect(result).toEqual({ claimed: 1, sent: 1, retried: 0, deadLettered: 0 });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ messageId }));
    const stored = await pool.query<{
      status: string;
      sent_at: Date | null;
      provider_message_id: string | null;
      history_count: string;
      changed_by: string | null;
    }>(
      `SELECT outbox.status,
              outbox.sent_at,
              outbox.provider_message_id,
              COUNT(history.id)::text AS history_count,
              MAX(history.changed_by) AS changed_by
       FROM procurement.po_email_outbox outbox
       LEFT JOIN procurement.po_status_history history
         ON history.purchase_order_id = outbox.purchase_order_id
        AND history.to_status = 'email_sent'
       WHERE outbox.id = $1
       GROUP BY outbox.id`,
      [deliveryId],
    );
    expect(stored.rows[0]).toMatchObject({
      status: "sent",
      provider_message_id: "<provider-accepted@example.test>",
      history_count: "1",
      changed_by: actorId,
    });
    expect(stored.rows[0].sent_at).toBeInstanceOf(Date);
  });
});
