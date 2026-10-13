import { createHash, randomUUID } from "crypto";
import { pool } from "../../db";
import { buildPurchaseOrderEmail } from "../notifications/email.service";
import { inspectPoEmailDocument, type PoEmailDocumentMetadata } from "./po-email-document-contract";

export type PoEmailDeliveryStatus = "queued" | "processing" | "sent" | "partially_sent" | "dead_letter";

export interface PoEmailOutboxQueryResult {
  rows: Record<string, unknown>[];
  rowCount?: number | null;
}

export interface PoEmailOutboxDbClient {
  query(sql: string, params?: unknown[]): Promise<PoEmailOutboxQueryResult>;
  release(): void;
}

export interface PoEmailOutboxDbPool {
  query(sql: string, params?: unknown[]): Promise<PoEmailOutboxQueryResult>;
  connect(): Promise<PoEmailOutboxDbClient>;
}

export interface PoEmailDelivery extends PoEmailDocumentMetadata {
  documentHeldAt: Date | null;
  id: number;
  purchaseOrderId: number;
  status: PoEmailDeliveryStatus;
  toEmail: string;
  ccEmail: string | null;
  subject: string;
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  providerMessageId: string | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  sentAt: Date | null;
  deadLetteredAt: Date | null;
  replayOfId: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export class PoEmailOutboxError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "PoEmailOutboxError";
  }
}

interface EnqueueInput {
  purchaseOrderId: number;
  toEmail: string;
  ccEmail?: string;
  message?: string;
  idempotencyKey: string;
  createdBy?: string | null;
}

const PUBLIC_COLUMNS = `
  id,
  purchase_order_id AS "purchaseOrderId",
  status,
  to_email AS "toEmail",
  cc_email AS "ccEmail",
  subject,
  attempt_count AS "attemptCount",
  max_attempts AS "maxAttempts",
  next_attempt_at AS "nextAttemptAt",
  provider_message_id AS "providerMessageId",
  last_error_code AS "lastErrorCode",
  last_error_message AS "lastErrorMessage",
  sent_at AS "sentAt",
  dead_lettered_at AS "deadLetteredAt",
  replay_of_id AS "replayOfId",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  document_contract_version AS "contractVersion",
  document_hash AS "documentHash",
  document_source_revision AS "sourceRevision",
  document_purpose AS "documentPurpose",
  document_hold_reason AS "documentHoldReason",
  document_held_at AS "documentHeldAt"
`;

export async function enqueuePurchaseOrderEmail(
  input: EnqueueInput,
  dependencies: {
    dbPool?: PoEmailOutboxDbPool;
    buildSnapshot?: typeof buildPurchaseOrderEmail;
  } = {},
): Promise<{ delivery: PoEmailDelivery; replayed: boolean }> {
  const dbPool = dependencies.dbPool ?? pool;
  const buildSnapshot = dependencies.buildSnapshot ?? buildPurchaseOrderEmail;
  const normalized = {
    purchaseOrderId: input.purchaseOrderId,
    toEmail: input.toEmail.trim(),
    ccEmail: input.ccEmail?.trim() || null,
    message: input.message?.trim() || null,
  };
  const requestHash = sha256(JSON.stringify(normalized));

  const existing = await findByIntent(dbPool, input.purchaseOrderId, input.idempotencyKey);
  if (existing) {
    assertSameIntent(existing.requestHash, requestHash);
    return { delivery: existing.delivery, replayed: true };
  }

  let snapshot: Awaited<ReturnType<typeof buildPurchaseOrderEmail>>;
  try {
    snapshot = await buildSnapshot({
      poId: input.purchaseOrderId,
      message: normalized.message ?? undefined,
    });
    assertVerifiedSnapshot(snapshot);
  } catch (error) {
    const rejectionCode = error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code : "PURCHASE_ORDER_DOCUMENT_BUILD_FAILED";
    console.warn("[PO Email Outbox] Enqueue rejected", {
      code: rejectionCode,
      purchaseOrderId: input.purchaseOrderId,
      actorId: input.createdBy ?? null,
    });
    if (error instanceof Error && error.message === "Purchase order not found") {
      throw new PoEmailOutboxError(error.message, 404, "PURCHASE_ORDER_NOT_FOUND");
    }
    throw error;
  }
  const messageId = createMessageId(input.purchaseOrderId);
  const inserted = await dbPool.query(
    `INSERT INTO procurement.po_email_outbox (
       purchase_order_id, idempotency_key, request_hash, status,
       to_email, cc_email, subject, html_body, text_body, message_id,
       created_by, document_contract_version, document_hash,
       document_source_revision, document_purpose
     ) VALUES ($1, $2, $3, 'queued', $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     ON CONFLICT (purchase_order_id, idempotency_key) DO NOTHING
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      input.purchaseOrderId,
      input.idempotencyKey,
      requestHash,
      normalized.toEmail,
      normalized.ccEmail,
      snapshot.subject,
      snapshot.html,
      snapshot.text,
      messageId,
      input.createdBy ?? null,
      snapshot.contractVersion,
      snapshot.documentHash,
      snapshot.sourceRevision,
      snapshot.documentPurpose,
    ],
  );
  if (inserted.rows[0]) {
    return { delivery: inserted.rows[0] as PoEmailDelivery, replayed: false };
  }

  const concurrent = await findByIntent(dbPool, input.purchaseOrderId, input.idempotencyKey);
  if (!concurrent) {
    throw new Error("Email outbox insert conflicted but the existing delivery could not be loaded");
  }
  assertSameIntent(concurrent.requestHash, requestHash);
  return { delivery: concurrent.delivery, replayed: true };
}

export async function listPurchaseOrderEmailDeliveries(
  purchaseOrderId: number,
  dbPool: PoEmailOutboxDbPool = pool,
): Promise<PoEmailDelivery[]> {
  const result = await dbPool.query(
    `SELECT ${PUBLIC_COLUMNS}
     FROM procurement.po_email_outbox
     WHERE purchase_order_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    [purchaseOrderId],
  );
  return result.rows as unknown as PoEmailDelivery[];
}

export async function replayDeadLetterPurchaseOrderEmail(input: {
  purchaseOrderId: number;
  deliveryId: number;
  idempotencyKey: string;
  createdBy?: string | null;
  dbPool?: PoEmailOutboxDbPool;
}): Promise<{ delivery: PoEmailDelivery; replayed: boolean }> {
  const dbPool = input.dbPool ?? pool;
  const sourceResult = await dbPool.query(
    `SELECT ${PUBLIC_COLUMNS}, html_body AS "html"
     FROM procurement.po_email_outbox
     WHERE id = $1 AND purchase_order_id = $2`,
    [input.deliveryId, input.purchaseOrderId],
  );
  const source = sourceResult.rows[0];
  if (!source) {
    throw new PoEmailOutboxError("Email delivery not found", 404, "DELIVERY_NOT_FOUND");
  }
  if (source.status !== "dead_letter") {
    throw new PoEmailOutboxError(
      "Only dead-lettered email deliveries can be replayed",
      409,
      "DELIVERY_NOT_DEAD_LETTERED",
    );
  }

  assertVerifiedSnapshot(source as unknown as PoEmailDocumentMetadata & { html: string });

  const requestHash = sha256(JSON.stringify({
    purchaseOrderId: input.purchaseOrderId,
    replayOfId: input.deliveryId,
  }));
  const existing = await findByIntent(dbPool, input.purchaseOrderId, input.idempotencyKey);
  if (existing) {
    assertSameIntent(existing.requestHash, requestHash);
    return { delivery: existing.delivery, replayed: true };
  }

  const result = await dbPool.query(
    `INSERT INTO procurement.po_email_outbox (
       purchase_order_id, idempotency_key, request_hash, status,
       to_email, cc_email, subject, html_body, text_body, message_id,
       created_by, replay_of_id, document_contract_version, document_hash,
       document_source_revision, document_purpose
     )
     SELECT
       purchase_order_id, $3, $4, 'queued',
       to_email, cc_email, subject, html_body, text_body, $5,
       $6, id, document_contract_version, document_hash,
       document_source_revision, document_purpose
     FROM procurement.po_email_outbox
     WHERE id = $1 AND purchase_order_id = $2 AND status = 'dead_letter'
       AND document_hold_reason IS NULL
       AND procurement.po_email_document_is_verified(document_contract_version, document_hash,
         document_source_revision, document_purpose, html_body, document_hold_reason)
     ON CONFLICT (purchase_order_id, idempotency_key) DO NOTHING
     RETURNING ${PUBLIC_COLUMNS}`,
    [
      input.deliveryId,
      input.purchaseOrderId,
      input.idempotencyKey,
      requestHash,
      createMessageId(input.purchaseOrderId),
      input.createdBy ?? null,
    ],
  );
  if (result.rows[0]) {
    return { delivery: result.rows[0] as PoEmailDelivery, replayed: false };
  }

  const concurrent = await findByIntent(dbPool, input.purchaseOrderId, input.idempotencyKey);
  if (!concurrent) {
    // A document may have acquired a hold after the initial source read.
    const refreshed = await dbPool.query(
      `SELECT ${PUBLIC_COLUMNS}, html_body AS "html" FROM procurement.po_email_outbox
       WHERE id = $1 AND purchase_order_id = $2`,
      [input.deliveryId, input.purchaseOrderId],
    );
    if (refreshed.rows[0]) {
      assertVerifiedSnapshot(refreshed.rows[0] as unknown as PoEmailDocumentMetadata & { html: string });
    }
    throw new PoEmailOutboxError(
      "The saved delivery changed before replay could be queued. Reload its current state.",
      409,
      "DELIVERY_REPLAY_CONFLICT",
    );
  }
  assertSameIntent(concurrent.requestHash, requestHash);
  return { delivery: concurrent.delivery, replayed: true };
}

function assertVerifiedSnapshot(snapshot: PoEmailDocumentMetadata & { html: string }): void {
  const reason = inspectPoEmailDocument(snapshot);
  if (reason) {
    throw new PoEmailOutboxError(
      "This document cannot be emailed or replayed. Review the current purchase order and create a new verified document.",
      409,
      reason === "DOCUMENT_PURPOSE_NOT_ISSUABLE" ? "PURCHASE_ORDER_DOCUMENT_NOT_ISSUABLE" : "PURCHASE_ORDER_DOCUMENT_UNVERIFIED",
    );
  }
}

async function findByIntent(
  dbPool: PoEmailOutboxDbPool,
  purchaseOrderId: number,
  idempotencyKey: string,
): Promise<{ delivery: PoEmailDelivery; requestHash: string } | null> {
  const result = await dbPool.query(
    `SELECT ${PUBLIC_COLUMNS}, request_hash AS "requestHash"
     FROM procurement.po_email_outbox
     WHERE purchase_order_id = $1 AND idempotency_key = $2`,
    [purchaseOrderId, idempotencyKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  const { requestHash, ...publicDelivery } = row;
  return {
    delivery: publicDelivery as unknown as PoEmailDelivery,
    requestHash: String(requestHash),
  };
}

function assertSameIntent(existingHash: string, requestHash: string): void {
  if (existingHash !== requestHash) {
    throw new PoEmailOutboxError(
      "Idempotency-Key was already used for a different email request",
      409,
      "IDEMPOTENCY_KEY_REUSED",
    );
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createMessageId(purchaseOrderId: number): string {
  const from = process.env.SMTP_FROM || process.env.SMTP_USER || "";
  const domainMatch = from.match(/@([^>\s]+)/);
  const candidate = domainMatch?.[1]?.toLowerCase().replace(/[^a-z0-9.-]/g, "");
  const domain = candidate && candidate.includes(".") ? candidate : "echelon.local";
  return `<po-${purchaseOrderId}.${randomUUID()}@${domain}>`;
}
