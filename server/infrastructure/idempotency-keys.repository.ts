import { idempotencyKeys } from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";

/**
 * Sole persistence owner for `public.idempotency_keys` writes across HTTP
 * middleware and transactional command stores.
 *
 * Accepts caller DB/transaction executors (`tx`, `db`, or `pg` `PoolClient`)
 * and never imports the application DB singleton so unit tests can load it
 * without `DATABASE_URL`.
 */
export async function insertIdempotencyKeyDrizzle(
  executor: { insert: (...args: any[]) => any },
  values: typeof idempotencyKeys.$inferInsert,
): Promise<void> {
  await executor.insert(idempotencyKeys).values(values);
}

export async function updateIdempotencyKeyDrizzle(
  executor: { update: (...args: any[]) => any },
  key: string,
  updates: Partial<typeof idempotencyKeys.$inferInsert>,
): Promise<void> {
  await executor
    .update(idempotencyKeys)
    .set(updates)
    .where(eq(idempotencyKeys.key, key));
}

export async function deleteUnclaimedIdempotencyKeyDrizzle(
  executor: { delete: (...args: any[]) => any },
  key: string,
): Promise<void> {
  await executor
    .delete(idempotencyKeys)
    .where(and(eq(idempotencyKeys.key, key), isNull(idempotencyKeys.responseBody)));
}

export async function deleteIdempotencyKeyDrizzle(
  executor: { delete: (...args: any[]) => any },
  key: string,
): Promise<void> {
  await executor
    .delete(idempotencyKeys)
    .where(eq(idempotencyKeys.key, key));
}

export async function purgeExpiredIdempotencyKeysDrizzle(
  executor: { execute?: (...args: any[]) => any },
  now: Date = new Date(),
  limit = 200,
): Promise<void> {
  if (typeof executor.execute !== "function") {
    return;
  }
  await executor.execute(sql`
    DELETE FROM public.idempotency_keys
    WHERE key IN (
      SELECT key
      FROM public.idempotency_keys
      WHERE expires_at IS NOT NULL
        AND expires_at <= ${now}
      LIMIT ${limit}
    )
  `);
}

export async function insertIdempotencyKeyPgQuery(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  input: {
    key: string;
    requestHash: string;
    responseBodyJson?: string | null;
    createdAt: Date;
  },
): Promise<void> {
  if (input.responseBodyJson === undefined || input.responseBodyJson === null) {
    await client.query(
      `INSERT INTO public.idempotency_keys(
         key, request_hash, response_body, created_at, expires_at
       ) VALUES ($1,$2,NULL,$3,NULL)`,
      [input.key, input.requestHash, input.createdAt],
    );
    return;
  }

  await client.query(
    `INSERT INTO public.idempotency_keys(
       key, request_hash, response_body, created_at, expires_at
     ) VALUES ($1,$2,$3::jsonb,$4,NULL)`,
    [input.key, input.requestHash, input.responseBodyJson, input.createdAt],
  );
}

export async function completeIdempotencyKeyPgQuery(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  key: string,
  responseBodyJson: string,
): Promise<void> {
  await client.query(
    `UPDATE public.idempotency_keys
     SET response_body=$2::jsonb
     WHERE key=$1`,
    [key, responseBodyJson],
  );
}

/**
 * Atomically claim a single-use cryptographic nonce (e.g. OAuth `state.nonce`)
 * in `public.idempotency_keys` (`P3.2`). Returns `true` on first use and `false`
 * on any concurrent or subsequent replay.
 */
export async function claimSingleUseNoncePgQuery(
  client: {
    query: (
      text: string,
      values?: unknown[],
    ) => Promise<{ rowCount?: number | null; rows?: unknown[] }>;
  },
  input: {
    key: string;
    requestHash: string;
    createdAt: Date;
    expiresAt: Date;
  },
): Promise<boolean> {
  const result = await client.query(
    `INSERT INTO public.idempotency_keys(
       key, request_hash, response_body, created_at, expires_at
     ) VALUES ($1, $2, '{"consumed":true}'::jsonb, $3, $4)
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [input.key, input.requestHash, input.createdAt, input.expiresAt],
  );
  return (result.rows?.length ?? result.rowCount ?? 0) > 0;
}
