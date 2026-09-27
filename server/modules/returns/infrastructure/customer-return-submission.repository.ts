import type { Pool } from "pg";
import { z } from "zod";
import { customerReturnLabelSubmitInputSchema } from "@shared/returns/customer-return-label.contract";
import { CustomerReturnIntakeError } from "../application/customer-return-intake.ports";
import {
  processing,
  submissionNotFound,
  type CustomerReturnSubmissionStore,
  type ReturnSubmissionCommand,
} from "../application/customer-return-submission.service";

export const RETURN_SUBMISSION_LEASE_MS = 120_000;
export class PostgresCustomerReturnSubmissionStore
  implements CustomerReturnSubmissionStore
{
  constructor(private readonly pool: Pool) {}
  async read(
    channelId: number,
    key: string,
  ): Promise<ReturnSubmissionCommand | null> {
    const row = (
      await this.pool.query(
        `SELECT * FROM returns.customer_return_submission_commands WHERE channel_id=$1 AND idempotency_key=$2`,
        [channelId, key],
      )
    ).rows[0];
    return row ? parse(row) : null;
  }
  async acquire(
    input: Parameters<CustomerReturnSubmissionStore["acquire"]>[0],
  ): Promise<ReturnSubmissionCommand> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let inserted = false;
      if (input.request) {
        const result = await client.query(
          `INSERT INTO returns.customer_return_submission_commands
          (channel_id,idempotency_key,request_hash,request_snapshot,status,actor,lease_actor,lease_token,lease_until,created_at,updated_at)
          VALUES($1,$2,$3,$4::jsonb,'preparing',$5,$5,$6,$7,$8,$8) ON CONFLICT(channel_id,idempotency_key) DO NOTHING RETURNING channel_id`,
          [
            input.channelId,
            input.key,
            input.hash,
            JSON.stringify(input.request),
            input.actor,
            input.token,
            new Date(input.now.getTime() + RETURN_SUBMISSION_LEASE_MS),
            input.now,
          ],
        );
        inserted = result.rowCount === 1;
      }
      const row = (
        await client.query(
          `SELECT * FROM returns.customer_return_submission_commands WHERE channel_id=$1 AND idempotency_key=$2 FOR UPDATE`,
          [input.channelId, input.key],
        )
      ).rows[0];
      if (!row) throw submissionNotFound();
      if (input.hash && row.request_hash !== input.hash)
        throw new CustomerReturnIntakeError(
          "RETURN_LABEL_COMMAND_CONFLICT",
          "This request was already used for different return items. Check its saved status.",
          409,
        );
      if (row.status === "preparing" && !inserted) {
        if (new Date(row.lease_until).getTime() > input.now.getTime())
          throw processing();
        await client.query(
          `UPDATE returns.customer_return_submission_commands SET lease_token=$3,lease_until=$4,updated_at=$5,lease_actor=$6
          WHERE channel_id=$1 AND idempotency_key=$2`,
          [
            input.channelId,
            input.key,
            input.token,
            new Date(input.now.getTime() + RETURN_SUBMISSION_LEASE_MS),
            input.now,
            input.actor,
          ],
        );
        row.lease_token = input.token;
        row.lease_actor = input.actor;
      }
      await client.query("COMMIT");
      return parse(row);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async reject(
    channelId: number,
    key: string,
    token: string,
    code: string,
    now: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE returns.customer_return_submission_commands SET status='rejected',error_code=$4,updated_at=$5
      WHERE channel_id=$1 AND idempotency_key=$2 AND lease_token=$3 AND status='preparing'`,
      [channelId, key, token, code, now],
    );
  }
}
function parse(row: Record<string, unknown>): ReturnSubmissionCommand {
  return {
    request: customerReturnLabelSubmitInputSchema.parse(row.request_snapshot),
    actor: z
      .string()
      .min(1)
      .max(255)
      .parse(row.lease_actor ?? row.actor),
    leaseToken: z.string().uuid().parse(row.lease_token),
    status: z.enum(["preparing", "accepted", "rejected"]).parse(row.status),
    authorizationId:
      row.authorization_id === null
        ? null
        : z.coerce.number().int().positive().safe().parse(row.authorization_id),
  };
}
