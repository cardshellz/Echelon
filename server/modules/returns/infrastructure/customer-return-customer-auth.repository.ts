import type { Pool } from "pg";
import { z } from "zod";
import type { ReturnLoginChallengeStore } from "../application/customer-return-customer-auth.service";

export class PostgresReturnLoginChallengeStore implements ReturnLoginChallengeStore {
  constructor(private readonly database: Pick<Pool, "query">) {}
  async create(input: Parameters<ReturnLoginChallengeStore["create"]>[0]): Promise<void> {
    // Challenges are ephemeral credentials. Bound cleanup in the same statement
    // retains one day of expired evidence without an unbounded login table.
    await this.database.query(`WITH expired AS (
      SELECT state_hash FROM returns.customer_login_challenges
      WHERE expires_at < $5::timestamptz - interval '24 hours' ORDER BY expires_at LIMIT 100
    ), cleanup AS (
      DELETE FROM returns.customer_login_challenges c USING expired e WHERE c.state_hash=e.state_hash
    ) INSERT INTO returns.customer_login_challenges
      (state_hash,browser_hash,shop_domain,expires_at,created_at) VALUES ($1,$2,$3,$4,$5)`,
    [input.stateHash, input.browserHash, input.shopDomain, input.expiresAt, input.now]);
  }
  async consume(input: Parameters<ReturnLoginChallengeStore["consume"]>[0]): Promise<Date | null> {
    const result = await this.database.query(`UPDATE returns.customer_login_challenges SET consumed_at=$4
      WHERE state_hash=$1 AND browser_hash=$2 AND shop_domain=$3 AND consumed_at IS NULL
        AND created_at <= $4 AND expires_at > $4 RETURNING expires_at`,
    [input.stateHash, input.browserHash, input.shopDomain, input.now]);
    return result.rowCount === 1 ? z.coerce.date().parse(result.rows[0].expires_at) : null;
  }
}
