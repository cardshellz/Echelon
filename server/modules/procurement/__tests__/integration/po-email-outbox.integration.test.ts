import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import pg from "pg";
import { claimDeliveries, processPoEmailOutboxBatch } from "../../po-email-outbox.worker";
import { enqueuePurchaseOrderEmail, replayDeadLetterPurchaseOrderEmail } from "../../po-email-outbox.service";
import { poEmailDocumentHash } from "../../po-email-document-contract";

// Never load .env here. The caller must provision a dedicated local database.
const TEST_DB_URL = process.env.ECHELON_TEST_DATABASE_URL;
const DISPOSABLE_DB = process.env.ECHELON_TEST_DATABASE_DISPOSABLE === "true";
const describeWithDisposableDb = TEST_DB_URL && DISPOSABLE_DB ? describe : describe.skip;
const migrationSql = readFileSync(resolve(process.cwd(), "migrations/138_po_email_outbox.sql"), "utf8");
const documentGateSql = readFileSync(resolve(process.cwd(), "migrations/259_po_email_document_gate.sql"), "utf8");

async function expectDatabaseError(operation: () => Promise<unknown>, code: string): Promise<void> {
  let error: unknown;
  try { await operation(); } catch (caught) { error = caught; }
  expect(error).toBeTruthy();
  expect((error as { code?: string }).code).toBe(code);
}

describeWithDisposableDb.sequential("PO email outbox PostgreSQL guarantees", () => {
  const actorId = "po-email-outbox-integration-user";
  const purchaseOrderId = 71001;
  const html = "<html>Verified supplier copy: café 📦</html>";
  const sourceRevision = "a".repeat(64);
  let pool: pg.Pool;
  let ownsSchemas = false;

  beforeAll(async () => {
    const url = new URL(TEST_DB_URL!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !DISPOSABLE_DB) {
      throw new Error("PO email integration requires an explicitly disposable local PostgreSQL database");
    }
    if ([process.env.DATABASE_URL, process.env.EXTERNAL_DATABASE_URL].includes(TEST_DB_URL)) {
      throw new Error("Test URL must not equal an application database URL");
    }
    pool = new pg.Pool({ connectionString: TEST_DB_URL, max: 8, ssl: false });
    const existing = await pool.query("SELECT nspname FROM pg_namespace WHERE nspname IN ('identity', 'procurement')");
    if (existing.rows.length) throw new Error("Refusing an existing identity/procurement schema; provision a fresh database");
    await pool.query(`
      CREATE SCHEMA identity;
      CREATE SCHEMA procurement;
      CREATE TABLE identity.users (id VARCHAR PRIMARY KEY);
      CREATE TABLE procurement.purchase_orders (id INTEGER PRIMARY KEY);
      CREATE TABLE procurement.po_status_history (
        id INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        purchase_order_id INTEGER NOT NULL REFERENCES procurement.purchase_orders(id),
        from_status VARCHAR(20), to_status VARCHAR(20) NOT NULL,
        changed_by VARCHAR REFERENCES identity.users(id), notes TEXT
      );
    `);
    ownsSchemas = true;
    await pool.query("INSERT INTO identity.users (id) VALUES ($1)", [actorId]);
    await pool.query("INSERT INTO procurement.purchase_orders (id) VALUES ($1)", [purchaseOrderId]);
  });

  beforeEach(async () => {
    await pool.query("DROP TABLE IF EXISTS procurement.po_email_outbox CASCADE");
    await pool.query("TRUNCATE procurement.po_status_history RESTART IDENTITY");
    await pool.query(migrationSql);
  });

  afterAll(async () => {
    if (!pool) return;
    if (ownsSchemas) {
      await pool.query("DROP SCHEMA procurement CASCADE");
      await pool.query("DROP SCHEMA identity CASCADE");
    }
    await pool.end();
  });

  async function installGate(): Promise<void> { await pool.query(documentGateSql); }

  async function insertDelivery(input: {
    key: string;
    status?: "queued" | "processing" | "sent" | "partially_sent" | "dead_letter";
    legacy?: boolean;
    metadata?: { version?: number | null; hash?: string | null; revision?: string | null; purpose?: string | null };
  }): Promise<number> {
    const status = input.status ?? "queued";
    const metadataColumns = input.legacy ? "" : ", document_contract_version, document_hash, document_source_revision, document_purpose";
    const metadataValues = input.legacy ? "" : ", $15, $16, $17, $18";
    const params: unknown[] = [
      purchaseOrderId, input.key, input.key.padEnd(64, "0").slice(0, 64),
      "vendor@example.com", "Purchase Order PO-71001", html, "Verified supplier copy",
      `<po-71001.${input.key}@example.test>`, actorId, status,
      status === "processing" ? "original-lease" : null,
      status === "processing" ? new Date("2026-01-01T00:00:00Z") : null,
      ["sent", "partially_sent"].includes(status) ? new Date("2026-01-01T00:00:00Z") : null,
      status === "dead_letter" ? new Date("2026-01-01T00:00:00Z") : null,
    ];
    if (!input.legacy) {
      const m = input.metadata;
      params.push(m && "version" in m ? m.version : 1, m && "hash" in m ? m.hash : poEmailDocumentHash(html),
        m && "revision" in m ? m.revision : sourceRevision, m && "purpose" in m ? m.purpose : "current_copy");
    }
    const result = await pool.query(`
      INSERT INTO procurement.po_email_outbox (
        purchase_order_id, idempotency_key, request_hash, to_email, subject, html_body, text_body,
        message_id, created_by, status, lease_token, lease_expires_at, sent_at, dead_lettered_at
        ${metadataColumns}
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14 ${metadataValues}) RETURNING id
    `, params);
    return result.rows[0].id;
  }

  it("holds legacy pending/failed rows without rewriting bodies, status, or transport history", async () => {
    for (const status of ["queued", "processing", "sent", "partially_sent", "dead_letter"] as const) {
      await insertDelivery({ key: status, status, legacy: true });
    }
    await pool.query(`UPDATE procurement.po_email_outbox SET provider_message_id = 'legacy-provider-id',
      provider_response = 'legacy-provider-evidence' WHERE status IN ('sent', 'partially_sent')`);
    await pool.query(`UPDATE procurement.po_email_outbox SET last_error_code = 'LEGACY_FAILURE',
      last_error_message = 'Original error evidence' WHERE status = 'dead_letter'`);
    const before = await pool.query("SELECT * FROM procurement.po_email_outbox ORDER BY id");
    await installGate();
    const after = await pool.query("SELECT * FROM procurement.po_email_outbox ORDER BY id");
    after.rows.forEach((row, index) => {
      const { document_contract_version, document_hash, document_source_revision, document_purpose,
        document_hold_reason, document_held_at, ...originalFields } = row;
      expect(originalFields).toEqual(before.rows[index]);
      expect([document_contract_version, document_hash, document_source_revision, document_purpose]).toEqual([null, null, null, null]);
      if (["sent", "partially_sent"].includes(row.status)) {
        expect(document_hold_reason).toBeNull();
        expect(document_held_at).toBeNull();
      } else {
        expect(document_hold_reason).toBe("LEGACY_DOCUMENT_UNVERIFIED");
        expect(document_held_at).toBeInstanceOf(Date);
      }
    });
    const deliver = vi.fn();
    expect(await processPoEmailOutboxBatch({ dbPool: pool, deliver, now: new Date("2099-01-01T00:00:00Z") }))
      .toEqual({ claimed: 0, sent: 0, retried: 0, deadLettered: 0, held: 0 });
    expect(deliver).not.toHaveBeenCalled();
    expect((await pool.query("SELECT * FROM procurement.po_email_outbox ORDER BY id")).rows).toEqual(after.rows);
  });

  it("does not allow old writers, held lease acquisition/reclamation, or held replay", async () => {
    const queuedId = await insertDelivery({ key: "legacy-queued", legacy: true });
    const processingId = await insertDelivery({ key: "legacy-processing", status: "processing", legacy: true });
    const failedId = await insertDelivery({ key: "legacy-failed", status: "dead_letter", legacy: true });
    await installGate();
    await expectDatabaseError(() => insertDelivery({ key: "old-writer", legacy: true }), "23514");
    for (const id of [queuedId, processingId]) {
      await expectDatabaseError(() => pool.query(`UPDATE procurement.po_email_outbox
        SET status = 'processing', lease_token = 'new-lease', lease_expires_at = now() + interval '2 minutes',
            attempt_count = attempt_count + 1 WHERE id = $1`, [id]), "23514");
    }
    await expectDatabaseError(() => pool.query("UPDATE procurement.po_email_outbox SET lease_expires_at = now() + interval '1 hour' WHERE id = $1", [processingId]), "23514");
    await expect(replayDeadLetterPurchaseOrderEmail({
      purchaseOrderId, deliveryId: failedId, idempotencyKey: "unsafe-replay", dbPool: pool,
    })).rejects.toMatchObject({ code: "PURCHASE_ORDER_DOCUMENT_UNVERIFIED", statusCode: 409 });
    expect((await pool.query("SELECT count(*)::integer AS count FROM procurement.po_email_outbox")).rows[0].count).toBe(3);
    await expectDatabaseError(() => pool.query("UPDATE procurement.po_email_outbox SET document_hold_reason = NULL, document_held_at = NULL WHERE id = $1", [failedId]), "23514");
  });

  it("allows an already in-flight legacy attempt to record real provider acceptance with its hold intact", async () => {
    const id = await insertDelivery({ key: "in-flight", status: "processing", legacy: true });
    await installGate();
    await pool.query(`UPDATE procurement.po_email_outbox SET status = 'sent', sent_at = now(),
      provider_message_id = 'actual-provider-id', lease_token = NULL, lease_expires_at = NULL WHERE id = $1`, [id]);
    expect((await pool.query("SELECT status, document_hold_reason, provider_message_id FROM procurement.po_email_outbox WHERE id = $1", [id])).rows[0])
      .toEqual({ status: "sent", document_hold_reason: "LEGACY_DOCUMENT_UNVERIFIED", provider_message_id: "actual-provider-id" });
  });

  it.each([
    { version: null }, { version: 2 }, { hash: "0".repeat(64) }, { revision: null },
    { purpose: "draft_preview" }, { purpose: "cancelled_record" },
  ])("fails closed for unverified inserted metadata %j", async (metadata) => {
    await installGate();
    await expectDatabaseError(() => insertDelivery({ key: "invalid", metadata }), "23514");
    expect((await pool.query("SELECT count(*)::integer AS count FROM procurement.po_email_outbox")).rows[0].count).toBe(0);
  });

  it("enforces idempotency and immutable document metadata/body", async () => {
    await installGate();
    const id = await insertDelivery({ key: "immutable" });
    await expectDatabaseError(() => insertDelivery({ key: "immutable" }), "23505");
    for (const statement of [
      "html_body = '<html>mutated</html>'", "document_contract_version = 2",
      "document_hash = repeat('b', 64)", "document_source_revision = repeat('b', 64)", "document_purpose = 'draft_preview'",
    ]) {
      await expectDatabaseError(() => pool.query(`UPDATE procurement.po_email_outbox SET ${statement} WHERE id = $1`, [id]), "23514");
    }
    await expectDatabaseError(() => pool.query("UPDATE procurement.po_email_outbox SET status = 'sent' WHERE id = $1", [id]), "23514");
  });

  it("claims verified rows once across concurrent workers and renews an expired verified lease", async () => {
    await installGate();
    await insertDelivery({ key: "concurrent-1" });
    await insertDelivery({ key: "concurrent-2" });
    const now = new Date("2099-01-01T00:00:00Z");
    const [first, second] = await Promise.all([
      claimDeliveries(pool, { batchSize: 1, leaseSeconds: 120, now }),
      claimDeliveries(pool, { batchSize: 1, leaseSeconds: 120, now }),
    ]);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].id).not.toBe(second[0].id);
    const reclaimed = await claimDeliveries(pool, { batchSize: 2, leaseSeconds: 120, now: new Date(now.getTime() + 121_000) });
    expect(reclaimed).toHaveLength(2);
    expect(reclaimed.every(row => row.attemptCount === 2)).toBe(true);
    expect(reclaimed.every(row => row.leaseToken !== first[0].leaseToken && row.leaseToken !== second[0].leaseToken)).toBe(true);
  });

  it("enqueues the actual builder contract once for concurrent matching intents", async () => {
    await installGate();
    const buildSnapshot = vi.fn().mockResolvedValue({
      html, text: "Verified supplier copy", subject: "Purchase Order PO-71001", poNumber: "PO-71001",
      contractVersion: 1, documentHash: poEmailDocumentHash(html), sourceRevision, documentPurpose: "current_copy",
    });
    const input = {
      purchaseOrderId, toEmail: " vendor@example.com ", message: " Confirm receipt ",
      idempotencyKey: "enqueue-concurrent", createdBy: actorId,
    };
    const [first, second] = await Promise.all([
      enqueuePurchaseOrderEmail(input, { dbPool: pool, buildSnapshot }),
      enqueuePurchaseOrderEmail(input, { dbPool: pool, buildSnapshot }),
    ]);
    expect(first.delivery.id).toBe(second.delivery.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.delivery).toMatchObject({
      contractVersion: 1, documentHash: poEmailDocumentHash(html), sourceRevision,
      documentPurpose: "current_copy", documentHoldReason: null, toEmail: "vendor@example.com",
    });
    expect(buildSnapshot).toHaveBeenCalledWith({ poId: purchaseOrderId, message: "Confirm receipt" });
    expect((await pool.query("SELECT count(*)::integer AS count FROM procurement.po_email_outbox")).rows[0].count).toBe(1);
  });

  it("copies verified immutable document metadata and content on failed replay", async () => {
    await installGate();
    const id = await insertDelivery({ key: "failed", status: "dead_letter" });
    const input = { purchaseOrderId, deliveryId: id, idempotencyKey: "replay", createdBy: actorId, dbPool: pool };
    const [first, second] = await Promise.all([replayDeadLetterPurchaseOrderEmail(input), replayDeadLetterPurchaseOrderEmail(input)]);
    expect(first.delivery.id).toBe(second.delivery.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.delivery).toMatchObject({ replayOfId: id, contractVersion: 1, documentHash: poEmailDocumentHash(html), sourceRevision, documentPurpose: "current_copy" });
    expect((await pool.query("SELECT html_body FROM procurement.po_email_outbox WHERE id = $1", [first.delivery.id])).rows[0].html_body).toBe(html);
  });

  it("commits provider acceptance and PO history in one database transaction", async () => {
    await installGate();
    const id = await insertDelivery({ key: "delivery" });
    const deliver = vi.fn().mockResolvedValue({
      messageId: "<provider-accepted@example.test>", response: "250 queued", accepted: ["vendor@example.com"], rejected: [],
    });
    expect(await processPoEmailOutboxBatch({ dbPool: pool, deliver, batchSize: 1, now: new Date("2099-01-01T00:00:00Z") }))
      .toEqual({ claimed: 1, sent: 1, retried: 0, deadLettered: 0, held: 0 });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ html }));
    const stored = await pool.query(`SELECT outbox.status, outbox.sent_at, outbox.provider_message_id,
      COUNT(history.id)::text AS history_count, MAX(history.changed_by) AS changed_by, MAX(history.notes) AS notes
      FROM procurement.po_email_outbox outbox LEFT JOIN procurement.po_status_history history
      ON history.purchase_order_id = outbox.purchase_order_id AND history.to_status = 'email_sent'
      WHERE outbox.id = $1 GROUP BY outbox.id`, [id]);
    expect(stored.rows[0]).toMatchObject({ status: "sent", provider_message_id: "<provider-accepted@example.test>", history_count: "1", changed_by: actorId });
    expect(stored.rows[0].sent_at).toBeInstanceOf(Date);
    expect(stored.rows[0].notes).toContain("accepted by provider");
    await expectDatabaseError(() => pool.query(`UPDATE procurement.po_email_outbox
      SET document_hold_reason = 'SHOULD_NOT_REWRITE_COMPLETED', document_held_at = now() WHERE id = $1`, [id]), "23514");
  });
});
