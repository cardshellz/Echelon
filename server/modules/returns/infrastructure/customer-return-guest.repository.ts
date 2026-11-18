import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { returnGuestAccountSchema } from "@shared/returns/customer-return-guest.contract";
import { CustomerReturnCustomerAccessError } from "../application/customer-return-customer-auth.service";
import { guestAccessError, RETURN_GUEST_GRANT_LIFETIME_MS } from "../application/customer-return-guest.service";
import { guestPurchaseSchema, type GuestChallenge, type GuestVerificationStore } from "../application/customer-return-guest.ports";

const EMAIL_HOURLY_LIMIT = 5;
const BROWSER_HOURLY_LIMIT = 10;
const DELIVERY_COOLDOWN_MS = 60_000;
const DELIVERY_LEASE_MS = 90_000;
export class PostgresCustomerReturnGuestStore implements GuestVerificationStore {
  private readonly encryptionKey: Buffer;
  constructor(private readonly pool: Pool, secret: string) {
    this.encryptionKey = createHash("sha256").update(`guest-account-url:${z.string().min(32).parse(secret)}`).digest();
  }
  async reserve(input: GuestChallenge & { now: Date }) {
    return this.transaction(async client => {
      // Lock both counters in a fixed order. New browser IDs cannot bypass the
      // destination cap, and changing destination cannot bypass the browser cap.
      for (const key of [`email:${input.channelId}:${input.emailHash}`, `browser:${input.channelId}:${input.browserHash}`].sort())
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
      const existing = await this.row(client, input.id, input.browserHash);
      if (existing) {
        if (existing.inputHash !== input.inputHash) throw guestAccessError();
        return existing;
      }
      const counts = (await client.query(`SELECT
        COUNT(*) FILTER (WHERE email_hash=$2)::int AS email_count,
        COUNT(*) FILTER (WHERE browser_hash=$3)::int AS browser_count
        FROM returns.customer_return_guest_challenges WHERE channel_id=$1 AND created_at>$4`,
      [input.channelId, input.emailHash, input.browserHash, new Date(input.now.getTime() - 3_600_000)])).rows[0];
      if (Number(counts.email_count) >= EMAIL_HOURLY_LIMIT || Number(counts.browser_count) >= BROWSER_HOURLY_LIMIT)
        throw new CustomerReturnCustomerAccessError("RETURN_GUEST_RATE_LIMITED", "Please wait before requesting another email code.", 429);
      const result = await client.query(`INSERT INTO returns.customer_return_guest_challenges
        (id,channel_id,browser_hash,input_hash,email_hash,purchase,created_at,expires_at,next_delivery_at,oms_order_id)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$7,$9) ON CONFLICT(id) DO NOTHING RETURNING *`,
      [input.id, input.channelId, input.browserHash, input.inputHash, input.emailHash,
        input.purchase === null ? null : JSON.stringify(guestPurchaseSchema.parse(input.purchase)), input.now, input.expiresAt, input.purchase?.omsOrderId ?? null]);
      const row = result.rows[0];
      if (!row) throw guestAccessError();
      await this.audit(client, input.id, "created", input.now);
      return parse(row);
    });
  }
  async read(id: string, browserHash: string) { return this.row(this.pool, id, browserHash); }
  async revoke(id: string, browserHash: string, now: Date) {
    await this.transaction(async client => {
      const result = await client.query("UPDATE returns.customer_return_guest_challenges SET revoked_at=$3 WHERE id=$1 AND browser_hash=$2 AND revoked_at IS NULL RETURNING id", [id,browserHash,now]);
      if (result.rowCount === 1) await this.audit(client, id, "signed_out", now);
    });
  }
  async claimDelivery(id: string, browserHash: string, token: string, now: Date) {
    const row = (await this.pool.query(`UPDATE returns.customer_return_guest_challenges SET delivery_token=$3,delivery_until=$5
      WHERE id=$1 AND browser_hash=$2 AND revoked_at IS NULL AND purchase IS NOT NULL AND verified_at IS NULL AND attempts<5 AND created_at<=$4 AND expires_at>$4
      AND next_delivery_at<=$4 AND (delivery_until IS NULL OR delivery_until<=$4) RETURNING *`,
    [id, browserHash, token, now, new Date(now.getTime() + DELIVERY_LEASE_MS)])).rows[0];
    return row ? parse(row) : null;
  }
  async finishDelivery(id: string, token: string, now: Date, delivered: boolean) {
    await this.transaction(async client => {
      const changed = await client.query(`UPDATE returns.customer_return_guest_challenges SET delivery_token=NULL,delivery_until=NULL,next_delivery_at=$3
        WHERE id=$1 AND delivery_token=$2 RETURNING id`, [id, token, new Date(now.getTime() + DELIVERY_COOLDOWN_MS)]);
      if (changed.rowCount === 1) await this.audit(client, id, delivered ? "email_sent" : "email_uncertain", now);
    });
  }
  async verify(id: string, browserHash: string, correct: boolean, now: Date) {
    return this.transaction(async client => {
      const row = await this.row(client, id, browserHash, true);
      if (!row) return null;
      if (row.verifiedAt) {
        if (row.verifiedAt > now || row.verifiedAt.getTime() + RETURN_GUEST_GRANT_LIFETIME_MS <= now.getTime()) return null;
        // Correct retries replay the same grant. A previously successful
        // verification must not turn the code endpoint into an unlimited oracle.
        const replay = await client.query(`UPDATE returns.customer_return_guest_challenges SET attempts=attempts+CASE WHEN $3 THEN 0 ELSE 1 END
          WHERE id=$1 AND browser_hash=$2 AND revoked_at IS NULL AND attempts<5 RETURNING *`, [id,browserHash,correct]);
        if (replay.rowCount !== 1) return null;
        if (!correct) { await this.audit(client,id,"code_rejected",now); return null; }
        return parse(replay.rows[0]);
      }
      const result = await client.query(`UPDATE returns.customer_return_guest_challenges
        SET attempts=attempts+1,verified_at=CASE WHEN $3 AND purchase IS NOT NULL THEN $4 ELSE NULL END
        WHERE id=$1 AND browser_hash=$2 AND revoked_at IS NULL AND created_at<=$4 AND expires_at>$4 AND attempts<5 RETURNING *`, [id, browserHash, correct, now]);
      if (!result.rows[0]) return null;
      const verified = parse(result.rows[0]);
      await this.audit(client, id, verified.verifiedAt ? "verified" : "code_rejected", now);
      return verified.verifiedAt ? verified : null;
    });
  }
  async account(id: string, browserHash: string, now: Date, build: Parameters<GuestVerificationStore["account"]>[3]) {
    return this.transaction(async client => {
      const result = await client.query("SELECT * FROM returns.customer_return_guest_challenges WHERE id=$1 AND browser_hash=$2 AND revoked_at IS NULL FOR UPDATE", [id, browserHash]);
      const raw = result.rows[0];
      if (!raw || !parse(raw).verifiedAt || new Date(raw.verified_at).getTime() + RETURN_GUEST_GRANT_LIFETIME_MS <= now.getTime()) throw guestAccessError();
      const previous = raw.account_result ? returnGuestAccountSchema.parse(this.decrypt(z.string().parse(raw.account_result), id)) : null;
      // Serializing this explicit action prevents simultaneous clicks from
      // generating activation URLs that invalidate one another at Shopify.
      const value = returnGuestAccountSchema.parse(await build(previous));
      if (previous && previous.kind === value.kind && previous.url === value.url) return previous;
      await client.query("UPDATE returns.customer_return_guest_challenges SET account_result=$2 WHERE id=$1", [id, this.encrypt(value, id)]);
      await this.audit(client, id, "account_link", now);
      return value;
    });
  }
  private encrypt(value: unknown, challengeId: string) {
    const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(challengeId, "utf8"));
    const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64url");
  }
  private decrypt(value: string, challengeId: string): unknown {
    const bytes = Buffer.from(value, "base64url"), decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, bytes.subarray(0,12));
    decipher.setAAD(Buffer.from(challengeId, "utf8"));
    decipher.setAuthTag(bytes.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
  }
  private async row(database: Pick<Pool, "query"> | PoolClient, id: string, browserHash: string, lock = false) {
    const result = await database.query(`SELECT * FROM returns.customer_return_guest_challenges WHERE id=$1 AND browser_hash=$2 AND revoked_at IS NULL${lock ? " FOR UPDATE" : ""}`, [id, browserHash]);
    return result.rows[0] ? parse(result.rows[0]) : null;
  }
  private async audit(client: PoolClient, id: string, action: string, now: Date) {
    await client.query("INSERT INTO returns.customer_return_guest_events(challenge_id,action,occurred_at) VALUES($1,$2,$3)", [id, action, now]);
  }
  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const value = await work(client); await client.query("COMMIT"); return value; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
function parse(row: Record<string, unknown>): GuestChallenge {
  return { id: z.string().uuid().parse(row.id), channelId: z.coerce.number().int().positive().safe().parse(row.channel_id),
    browserHash: z.string().length(43).parse(row.browser_hash), inputHash: z.string().length(43).parse(row.input_hash), emailHash: z.string().length(43).parse(row.email_hash),
    purchase: row.purchase === null ? null : guestPurchaseSchema.parse(row.purchase), expiresAt: z.coerce.date().parse(row.expires_at),
    verifiedAt: row.verified_at === null ? null : z.coerce.date().parse(row.verified_at) };
}
