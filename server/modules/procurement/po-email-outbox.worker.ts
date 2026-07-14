import { randomUUID } from "crypto";
import { pool } from "../../db";
import { sendEmail, type EmailDeliveryResult } from "../notifications/email.service";
import type { PoEmailOutboxDbPool } from "./po-email-outbox.service";

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_BATCH_SIZE = 10;
const DEFAULT_LEASE_SECONDS = 120;
const LOG_PREFIX = "[PO Email Outbox]";

interface ClaimedDelivery {
  id: number;
  purchaseOrderId: number;
  toEmail: string;
  ccEmail: string | null;
  subject: string;
  htmlBody: string;
  textBody: string | null;
  messageId: string;
  attemptCount: number;
  maxAttempts: number;
  leaseToken: string;
  createdBy: string | null;
}

export interface PoEmailOutboxWorkerHeartbeat {
  startedAt: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  inFlight: boolean;
}

let timer: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
let startedAt: Date | null = null;
let lastRunAt: Date | null = null;
let lastSuccessAt: Date | null = null;
let lastError: string | null = null;

export function getPoEmailOutboxWorkerHeartbeat(): PoEmailOutboxWorkerHeartbeat {
  return {
    startedAt: startedAt?.toISOString() ?? null,
    lastRunAt: lastRunAt?.toISOString() ?? null,
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastError,
    inFlight,
  };
}

export function startPoEmailOutboxWorker(): void {
  if (timer) {
    console.warn(`${LOG_PREFIX} Worker already started; ignoring duplicate start`);
    return;
  }
  startedAt = new Date();
  const intervalMs = positiveIntegerEnv("PO_EMAIL_OUTBOX_WORKER_INTERVAL_MS", DEFAULT_INTERVAL_MS);
  const run = () => void runPoEmailOutboxWorkerTick();
  setTimeout(run, Math.min(intervalMs, 5_000));
  timer = setInterval(run, intervalMs);
  console.info(`${LOG_PREFIX} Started durable delivery worker (interval ${intervalMs}ms)`);
}

export async function runPoEmailOutboxWorkerTick(
  processor: () => Promise<unknown> = processPoEmailOutboxBatch,
): Promise<"success" | "error" | "skipped"> {
  if (inFlight) return "skipped";
  inFlight = true;
  lastRunAt = new Date();
  try {
    await processor();
    lastSuccessAt = new Date();
    lastError = null;
    return "success";
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    console.error(`${LOG_PREFIX} Worker tick failed`, error);
    return "error";
  } finally {
    inFlight = false;
  }
}

export async function processPoEmailOutboxBatch(dependencies: {
  dbPool?: PoEmailOutboxDbPool;
  deliver?: typeof sendEmail;
  batchSize?: number;
  leaseSeconds?: number;
  now?: Date;
} = {}): Promise<{ claimed: number; sent: number; retried: number; deadLettered: number }> {
  const dbPool = dependencies.dbPool ?? pool;
  const deliver = dependencies.deliver ?? sendEmail;
  const batchSize = dependencies.batchSize
    ?? positiveIntegerEnv("PO_EMAIL_OUTBOX_WORKER_BATCH_SIZE", DEFAULT_BATCH_SIZE);
  const leaseSeconds = dependencies.leaseSeconds
    ?? positiveIntegerEnv("PO_EMAIL_OUTBOX_LEASE_SECONDS", DEFAULT_LEASE_SECONDS);
  const now = dependencies.now ?? new Date();
  const claimed = await claimDeliveries(dbPool, { batchSize, leaseSeconds, now });
  let sent = 0;
  let retried = 0;
  let deadLettered = 0;

  await Promise.all(claimed.map(async (delivery) => {
    try {
      const result = await deliver({
        to: delivery.toEmail,
        cc: delivery.ccEmail ?? undefined,
        subject: delivery.subject,
        html: delivery.htmlBody,
        text: delivery.textBody ?? undefined,
        messageId: delivery.messageId,
      });
      await markDeliverySent(dbPool, delivery, result);
      sent += 1;
    } catch (error) {
      const disposition = await markDeliveryFailed(dbPool, delivery, error, now);
      if (disposition === "dead_letter") deadLettered += 1;
      else retried += 1;
    }
  }));

  if (claimed.length > 0) {
    console.info(`${LOG_PREFIX} Batch complete`, {
      claimed: claimed.length,
      sent,
      retried,
      deadLettered,
    });
  }
  return { claimed: claimed.length, sent, retried, deadLettered };
}

export async function claimDeliveries(
  dbPool: PoEmailOutboxDbPool,
  input: { batchSize: number; leaseSeconds: number; now: Date },
): Promise<ClaimedDelivery[]> {
  await dbPool.query(
    `UPDATE procurement.po_email_outbox
     SET status = 'dead_letter',
         dead_lettered_at = $1,
         lease_token = NULL,
         lease_expires_at = NULL,
         last_error_code = COALESCE(last_error_code, 'LEASE_EXHAUSTED'),
         last_error_message = COALESCE(last_error_message, 'Worker lease expired after the final allowed attempt'),
         updated_at = $1
     WHERE status = 'processing'
       AND lease_expires_at <= $1
       AND attempt_count >= max_attempts`,
    [input.now],
  );

  const leaseToken = randomUUID();
  const result = await dbPool.query(
    `WITH candidates AS (
       SELECT id
       FROM procurement.po_email_outbox
       WHERE (
         (status = 'queued' AND next_attempt_at <= $1)
         OR
         (status = 'processing' AND lease_expires_at <= $1)
       )
         AND attempt_count < max_attempts
       ORDER BY next_attempt_at ASC, id ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $2
     )
     UPDATE procurement.po_email_outbox outbox
     SET status = 'processing',
         attempt_count = outbox.attempt_count + 1,
         lease_token = $3,
         lease_expires_at = $1 + ($4::text || ' seconds')::interval,
         updated_at = $1
     FROM candidates
     WHERE outbox.id = candidates.id
     RETURNING
       outbox.id,
       outbox.purchase_order_id AS "purchaseOrderId",
       outbox.to_email AS "toEmail",
       outbox.cc_email AS "ccEmail",
       outbox.subject,
       outbox.html_body AS "htmlBody",
       outbox.text_body AS "textBody",
       outbox.message_id AS "messageId",
       outbox.attempt_count AS "attemptCount",
       outbox.max_attempts AS "maxAttempts",
       outbox.lease_token AS "leaseToken",
       outbox.created_by AS "createdBy"`,
    [input.now, input.batchSize, leaseToken, input.leaseSeconds],
  );
  return result.rows as unknown as ClaimedDelivery[];
}

async function markDeliverySent(
  dbPool: PoEmailOutboxDbPool,
  delivery: ClaimedDelivery,
  result: EmailDeliveryResult,
): Promise<void> {
  const client = await dbPool.connect();
  const partiallySent = result.rejected.length > 0;
  const deliveryWarning = partiallySent
    ? `${result.rejected.length} recipient${result.rejected.length === 1 ? " was" : "s were"} rejected after another recipient was accepted; automatic retry suppressed to prevent duplicates`
    : null;
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE procurement.po_email_outbox
       SET status = $5,
           sent_at = now(),
           provider_message_id = $3,
           provider_response = $4,
           last_error_code = $6,
           last_error_message = $7,
           lease_token = NULL,
           lease_expires_at = NULL,
           updated_at = now()
       WHERE id = $1 AND status = 'processing' AND lease_token = $2
       RETURNING id`,
      [
        delivery.id,
        delivery.leaseToken,
        truncate(result.messageId, 500),
        truncate(formatProviderResponse(result), 1000),
        partiallySent ? "partially_sent" : "sent",
        partiallySent ? "PARTIAL_RECIPIENT_REJECTION" : null,
        deliveryWarning,
      ],
    );
    if (updated.rowCount !== 1) {
      throw new Error(`Delivery ${delivery.id} lost its worker lease before completion`);
    }
    await client.query(
      `INSERT INTO procurement.po_status_history (
         purchase_order_id, from_status, to_status, changed_by, notes
       ) VALUES ($1, NULL, 'email_sent', $2, $3)`,
      [
        delivery.purchaseOrderId,
        delivery.createdBy,
        `Email ${partiallySent ? "partially accepted" : "delivered"} to ${delivery.toEmail}${delivery.ccEmail ? `, cc: ${delivery.ccEmail}` : ""} (delivery #${delivery.id})${deliveryWarning ? `; ${deliveryWarning}` : ""}`,
      ],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function markDeliveryFailed(
  dbPool: PoEmailOutboxDbPool,
  delivery: ClaimedDelivery,
  error: unknown,
  now: Date,
): Promise<"queued" | "dead_letter"> {
  const details = classifyDeliveryError(error);
  const deadLetter = details.permanent || delivery.attemptCount >= delivery.maxAttempts;
  const nextAttemptAt = computeNextAttemptAt(now, delivery.attemptCount);
  const result = await dbPool.query(
    `UPDATE procurement.po_email_outbox
     SET status = $3,
         next_attempt_at = $4,
         dead_lettered_at = CASE WHEN $3 = 'dead_letter' THEN $5 ELSE NULL END,
         last_error_code = $6,
         last_error_message = $7,
         lease_token = NULL,
         lease_expires_at = NULL,
         updated_at = $5
     WHERE id = $1 AND status = 'processing' AND lease_token = $2
     RETURNING status`,
    [
      delivery.id,
      delivery.leaseToken,
      deadLetter ? "dead_letter" : "queued",
      nextAttemptAt,
      now,
      truncate(details.code, 100),
      truncate(details.message, 1000),
    ],
  );
  if (result.rowCount !== 1) {
    throw new Error(`Delivery ${delivery.id} lost its worker lease while recording failure`);
  }
  return deadLetter ? "dead_letter" : "queued";
}

export function classifyDeliveryError(error: unknown): {
  code: string;
  message: string;
  permanent: boolean;
} {
  const value = error && typeof error === "object"
    ? error as { code?: unknown; responseCode?: unknown }
    : {};
  const code = typeof value?.code === "string" ? value.code : "SMTP_DELIVERY_FAILED";
  const responseCode = Number(value?.responseCode);
  const permanent = (responseCode >= 500 && responseCode < 600)
    || ["EENVELOPE", "EINVALID", "EAUTH"].includes(code);
  return {
    code,
    message: error instanceof Error ? error.message : String(error),
    permanent,
  };
}

export function computeNextAttemptAt(now: Date, attemptCount: number): Date {
  const delaySeconds = [60, 300, 900, 1_800, 3_600, 7_200, 14_400, 21_600, 21_600, 21_600][
    Math.min(Math.max(attemptCount - 1, 0), 9)
  ];
  return new Date(now.getTime() + delaySeconds * 1000);
}

function formatProviderResponse(result: EmailDeliveryResult): string {
  return JSON.stringify({
    response: result.response,
    accepted: result.accepted,
    rejected: result.rejected,
  });
}

function truncate(value: string | null | undefined, maxLength: number): string | null {
  if (!value) return null;
  return value.length <= maxLength ? value : value.slice(0, maxLength);
}

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
