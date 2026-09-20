import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type { DropshipVendorCreditProfile } from "../domain/vendor-credit";
import type {
  DropshipVendorCreditProfileMutationResult,
  DropshipVendorCreditProfileRepository,
  SetDropshipVendorCreditProfileRepositoryInput,
} from "../application/dropship-wallet-policy-service";
import {
  claimAdminConfigCommand,
  completeAdminConfigCommand,
  parseAdminConfigCommandEntityId,
  rollbackQuietly,
} from "./dropship-admin-config-command";

/**
 * PG repository for the per-vendor credit profile (migration 0683).
 *
 * Unlike the policy, the profile is MUTABLE configuration: one row per
 * vendor, upserted in place. What makes it auditable is the transaction, not
 * immutability — the command claim, the row write and the audit row (with the
 * previous values, read under FOR UPDATE in the same transaction) commit or
 * roll back together.
 */

const COMMAND_TYPE = "vendor_credit_profile_set";
const ENTITY_TYPE = "dropship_vendor_credit_profile";
const COMMAND_CODES = {
  idempotencyConflict: "DROPSHIP_VENDOR_CREDIT_PROFILE_IDEMPOTENCY_CONFLICT",
  commandIncomplete: "DROPSHIP_VENDOR_CREDIT_PROFILE_COMMAND_INCOMPLETE",
};

interface ProfileRow {
  id: number;
  vendor_id: number;
  advance_cap_override_cents: string | number | null;
  note: string | null;
  created_at: Date;
  updated_at: Date;
  updated_by_actor_type: "admin" | "system";
  updated_by_actor_id: string | null;
}

export class PgDropshipVendorCreditProfileRepository implements DropshipVendorCreditProfileRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async getByVendorId(vendorId: number): Promise<DropshipVendorCreditProfile | null> {
    try {
      const result = await this.dbPool.query<ProfileRow>(
        `SELECT * FROM dropship.dropship_vendor_credit_profiles WHERE vendor_id = $1 LIMIT 1`,
        [vendorId],
      );
      const row = result.rows[0];
      return row ? mapProfileRow(row) : null;
    } catch (error) {
      throw mapVendorCreditProfileError(error);
    }
  }

  async set(input: SetDropshipVendorCreditProfileRepositoryInput): Promise<DropshipVendorCreditProfileMutationResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const command = await claimAdminConfigCommand(client, {
        commandType: COMMAND_TYPE,
        entityType: ENTITY_TYPE,
        idempotencyKey: input.idempotencyKey,
        requestHash: input.requestHash,
        actor: input.actor,
        now: input.now,
        codes: COMMAND_CODES,
      });
      if (command.idempotentReplay) {
        // The command's entity is the vendor: the profile row is keyed by it.
        const replayVendorId = parseAdminConfigCommandEntityId(command.entityId, COMMAND_CODES.commandIncomplete);
        const profile = await loadProfileByVendorId(client, replayVendorId);
        await client.query("COMMIT");
        return { profile, previousProfile: null, idempotentReplay: true };
      }

      const existing = await client.query<ProfileRow>(
        `SELECT * FROM dropship.dropship_vendor_credit_profiles WHERE vendor_id = $1 FOR UPDATE`,
        [input.vendorId],
      );
      const previousProfile = existing.rows[0] ? mapProfileRow(existing.rows[0]) : null;

      const written = await client.query<ProfileRow>(
        `INSERT INTO dropship.dropship_vendor_credit_profiles
          (vendor_id, advance_cap_override_cents, note, created_at, updated_at,
           updated_by_actor_type, updated_by_actor_id)
         VALUES ($1, $2, $3, $4, $4, $5, $6)
         ON CONFLICT (vendor_id) DO UPDATE
           SET advance_cap_override_cents = EXCLUDED.advance_cap_override_cents,
               note = EXCLUDED.note,
               updated_at = EXCLUDED.updated_at,
               updated_by_actor_type = EXCLUDED.updated_by_actor_type,
               updated_by_actor_id = EXCLUDED.updated_by_actor_id
         RETURNING *`,
        [
          input.vendorId,
          input.advanceCapOverrideCents,
          input.note,
          input.now,
          input.actor.actorType,
          input.actor.actorId ?? null,
        ],
      );
      const profile = mapProfileRow(requiredRow(written.rows[0], "Vendor credit profile upsert returned no row."));

      await completeAdminConfigCommand(client, {
        commandId: command.commandId,
        entityType: ENTITY_TYPE,
        entityId: String(profile.vendorId),
        now: input.now,
      });
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, entity_type, entity_id, event_type, actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'info', $7::jsonb, $8)`,
        [
          profile.vendorId,
          ENTITY_TYPE,
          String(profile.vendorId),
          COMMAND_TYPE,
          input.actor.actorType,
          input.actor.actorId ?? null,
          JSON.stringify({
            idempotencyKey: input.idempotencyKey,
            before: previousProfile
              ? { advanceCapOverrideCents: previousProfile.advanceCapOverrideCents, note: previousProfile.note }
              : null,
            after: { advanceCapOverrideCents: profile.advanceCapOverrideCents, note: profile.note },
          }),
          input.now,
        ],
      );
      await client.query("COMMIT");
      return { profile, previousProfile, idempotentReplay: false };
    } catch (error) {
      await rollbackQuietly(client);
      throw mapVendorCreditProfileError(error);
    } finally {
      client.release();
    }
  }
}

async function loadProfileByVendorId(client: PoolClient, vendorId: number): Promise<DropshipVendorCreditProfile> {
  const result = await client.query<ProfileRow>(
    `SELECT * FROM dropship.dropship_vendor_credit_profiles WHERE vendor_id = $1 LIMIT 1`,
    [vendorId],
  );
  return mapProfileRow(requiredRow(result.rows[0], "Vendor credit profile row was not found."));
}

function mapProfileRow(row: ProfileRow): DropshipVendorCreditProfile {
  return {
    vendorId: row.vendor_id,
    advanceCapOverrideCents: optionalMoney(row.advance_cap_override_cents, "advance_cap_override_cents"),
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: { actorType: row.updated_by_actor_type, actorId: row.updated_by_actor_id },
  };
}

/** bigint cents arrive as strings from pg; NULL is "no override". Zero is a real override. */
function optionalMoney(value: string | number | null, column: string): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new DropshipError(
      "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_STORED_VALUE",
      "Stored vendor credit profile money is not a non-negative integer number of cents.",
      { classification: "fatal", column, value },
    );
  }
  return parsed;
}

function requiredRow<T>(row: T | null | undefined, message: string): T {
  if (!row) {
    throw new DropshipError("DROPSHIP_VENDOR_CREDIT_PROFILE_NOT_FOUND", message, { classification: "permanent" });
  }
  return row;
}

/**
 * Turns the PG failures this repository can actually provoke into classified
 * dropship errors. Anything else propagates untouched.
 */
export function mapVendorCreditProfileError(error: unknown): unknown {
  if (error instanceof DropshipError) return error;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    if (code === "42P01") {
      return new DropshipError(
        "DROPSHIP_VENDOR_CREDIT_PROFILE_TABLE_MISSING",
        "Dropship vendor credit profile table does not exist yet.",
        { classification: "transient", sqlState: code },
      );
    }
    if (code === "23503") {
      return new DropshipError(
        "DROPSHIP_VENDOR_CREDIT_PROFILE_VENDOR_NOT_FOUND",
        "No dropship vendor exists with that id.",
        { classification: "permanent", sqlState: code },
      );
    }
    if (code === "23514") {
      return new DropshipError(
        "DROPSHIP_VENDOR_CREDIT_PROFILE_INVALID_INPUT",
        "Vendor credit profile values violate a database invariant.",
        { classification: "permanent", sqlState: code },
      );
    }
  }
  return error;
}
