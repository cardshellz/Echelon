import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import {
  emailChallengeHashMatches,
  type DropshipAuthChallengeConsumeResult,
  type DropshipAuthChallengeCreateResult,
  type DropshipAuthIdentityRecord,
  type DropshipAuthIdentityRepository,
} from "../application/dropship-auth-service";
import type {
  DropshipPasskeyCredentialRecord,
  DropshipPasskeyRepository,
} from "../application/dropship-passkey-service";
import type { DropshipSensitiveAction } from "../domain/auth";
import { normalizeCardShellzEmail } from "../domain/auth";

interface AuthIdentityRow {
  id: number;
  member_id: string;
  primary_email: string;
  password_hash: string | null;
  password_hash_algorithm: string | null;
  status: string;
  passkey_enrolled_at: Date | null;
}

interface ChallengeRow {
  id: number;
  challenge_hash: string;
  attempts: number;
  expires_at: Date;
}

interface PasskeyCredentialRow {
  id: number;
  auth_identity_id: number;
  member_id: string;
  credential_id: string;
  public_key: string;
  sign_count: number;
  transports: unknown;
  aaguid: string | null;
  backup_eligible: boolean | null;
  backup_state: boolean | null;
}

export class PgDropshipAuthIdentityRepository implements DropshipAuthIdentityRepository, DropshipPasskeyRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async findAuthIdentityByMemberId(memberId: string): Promise<DropshipAuthIdentityRecord | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<AuthIdentityRow>(
        `SELECT id, member_id, primary_email, password_hash, password_hash_algorithm, status, passkey_enrolled_at
         FROM dropship.dropship_auth_identities
         WHERE member_id::text = $1
         LIMIT 1`,
        [memberId],
      );
      return mapAuthIdentity(result.rows[0]);
    } finally {
      client.release();
    }
  }

  async findAuthIdentityByPrimaryEmail(email: string): Promise<DropshipAuthIdentityRecord | null> {
    const normalizedEmail = normalizeCardShellzEmail(email);
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<AuthIdentityRow>(
        `SELECT id, member_id, primary_email, password_hash, password_hash_algorithm, status, passkey_enrolled_at
         FROM dropship.dropship_auth_identities
         WHERE LOWER(primary_email) = LOWER($1)
         LIMIT 1`,
        [normalizedEmail],
      );
      return mapAuthIdentity(result.rows[0]);
    } finally {
      client.release();
    }
  }

  async upsertPasswordIdentity(input: {
    memberId: string;
    cardShellzEmail: string;
    passwordHash: string;
    passwordHashAlgorithm: string;
    verifiedAt: Date;
  }): Promise<DropshipAuthIdentityRecord> {
    const normalizedEmail = normalizeCardShellzEmail(input.cardShellzEmail);
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<AuthIdentityRow>(
        `INSERT INTO dropship.dropship_auth_identities
          (member_id, primary_email, password_hash, password_hash_algorithm, password_updated_at,
           last_card_shellz_proof_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $5, $5, $5)
         ON CONFLICT (member_id) DO UPDATE
           SET primary_email = EXCLUDED.primary_email,
               password_hash = EXCLUDED.password_hash,
               password_hash_algorithm = EXCLUDED.password_hash_algorithm,
               password_updated_at = EXCLUDED.password_updated_at,
               last_card_shellz_proof_at = EXCLUDED.last_card_shellz_proof_at,
               updated_at = EXCLUDED.updated_at
         RETURNING id, member_id, primary_email, password_hash, password_hash_algorithm, status, passkey_enrolled_at`,
        [
          input.memberId,
          normalizedEmail,
          input.passwordHash,
          input.passwordHashAlgorithm,
          input.verifiedAt,
        ],
      );
      await client.query("COMMIT");
      const identity = mapAuthIdentity(result.rows[0]);
      if (!identity) {
        throw new Error("Dropship auth identity upsert did not return a row.");
      }
      return identity;
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async touchLastLogin(authIdentityId: number, loggedInAt: Date): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await client.query(
        `UPDATE dropship.dropship_auth_identities
         SET last_login_at = $2, updated_at = $2
         WHERE id = $1`,
        [authIdentityId, loggedInAt],
      );
    } finally {
      client.release();
    }
  }

  async createEmailChallenge(input: {
    memberId: string;
    action: DropshipSensitiveAction;
    challengeHash: string;
    idempotencyKey: string;
    expiresAt: Date;
    createdAt: Date;
    metadata?: Record<string, unknown>;
  }): Promise<DropshipAuthChallengeCreateResult> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<{
        id: number;
        expires_at: Date;
        created: boolean;
      }>(
        `WITH inserted AS (
           INSERT INTO dropship.dropship_sensitive_action_challenges
             (member_id, action, method, challenge_hash, idempotency_key, expires_at, metadata, created_at)
           VALUES ($1, $2, 'email_mfa', $3, $4, $5, $6::jsonb, $7)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id, expires_at, true AS created
         )
         SELECT id, expires_at, created FROM inserted
         UNION ALL
         SELECT id, expires_at, false AS created
         FROM dropship.dropship_sensitive_action_challenges
         WHERE idempotency_key = $4
         LIMIT 1`,
        [
          input.memberId,
          input.action,
          input.challengeHash,
          input.idempotencyKey,
          input.expiresAt,
          JSON.stringify(input.metadata ?? {}),
          input.createdAt,
        ],
      );

      const row = result.rows[0];
      if (!row) {
        throw new Error("Dropship email challenge insert did not return a row.");
      }

      return {
        challengeId: row.id,
        expiresAt: row.expires_at,
        created: row.created,
      };
    } finally {
      client.release();
    }
  }

  async consumeLatestEmailChallenge(input: {
    memberId: string;
    action: DropshipSensitiveAction;
    challengeHash: string;
    now: Date;
    maxAttempts: number;
  }): Promise<DropshipAuthChallengeConsumeResult> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ChallengeRow>(
        `SELECT id, challenge_hash, attempts, expires_at
         FROM dropship.dropship_sensitive_action_challenges
         WHERE member_id::text = $1
           AND action = $2
           AND method = 'email_mfa'
           AND consumed_at IS NULL
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [input.memberId, input.action],
      );

      const row = result.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return { consumed: false, failureReason: "not_found" };
      }

      if (row.expires_at.getTime() <= input.now.getTime()) {
        await client.query("COMMIT");
        return { consumed: false, challengeId: row.id, failureReason: "expired" };
      }

      if (row.attempts >= input.maxAttempts) {
        await client.query("COMMIT");
        return { consumed: false, challengeId: row.id, failureReason: "too_many_attempts" };
      }

      if (!emailChallengeHashMatches(row.challenge_hash, input.challengeHash)) {
        await client.query(
          `UPDATE dropship.dropship_sensitive_action_challenges
           SET attempts = attempts + 1
           WHERE id = $1`,
          [row.id],
        );
        await client.query("COMMIT");
        return { consumed: false, challengeId: row.id, failureReason: "invalid_code" };
      }

      await client.query(
        `UPDATE dropship.dropship_sensitive_action_challenges
         SET consumed_at = $2
         WHERE id = $1`,
        [row.id, input.now],
      );
      await client.query("COMMIT");
      return { consumed: true, challengeId: row.id };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async findPasskeyCredentialByCredentialId(
    credentialId: string,
  ): Promise<DropshipPasskeyCredentialRecord | null> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<PasskeyCredentialRow>(
        `${PASSKEY_SELECT_SQL}
         WHERE credential_id = $1
         LIMIT 1`,
        [credentialId],
      );
      return mapPasskeyCredential(result.rows[0]);
    } finally {
      client.release();
    }
  }

  async listPasskeyCredentialsByMemberId(memberId: string): Promise<DropshipPasskeyCredentialRecord[]> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<PasskeyCredentialRow>(
        `${PASSKEY_SELECT_SQL}
         WHERE member_id::text = $1
         ORDER BY created_at DESC`,
        [memberId],
      );
      return result.rows.map((row) => mapPasskeyCredential(row)).filter((row): row is DropshipPasskeyCredentialRecord => !!row);
    } finally {
      client.release();
    }
  }

  async createPasskeyCredential(input: {
    authIdentityId: number;
    memberId: string;
    credentialId: string;
    publicKey: string;
    signCount: number;
    transports: string[];
    aaguid: string | null;
    backupEligible: boolean;
    backupState: boolean;
    createdAt: Date;
  }): Promise<DropshipPasskeyCredentialRecord> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<PasskeyCredentialRow>(
        `INSERT INTO dropship.dropship_passkey_credentials
          (auth_identity_id, member_id, credential_id, public_key, sign_count, transports,
           aaguid, backup_eligible, backup_state, created_at)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
         RETURNING id, auth_identity_id, member_id, credential_id, public_key, sign_count, transports,
           aaguid, backup_eligible, backup_state`,
        [
          input.authIdentityId,
          input.memberId,
          input.credentialId,
          input.publicKey,
          input.signCount,
          JSON.stringify(input.transports),
          input.aaguid,
          input.backupEligible,
          input.backupState,
          input.createdAt,
        ],
      );

      const credential = mapPasskeyCredential(result.rows[0]);
      if (!credential) {
        throw new Error("Dropship passkey insert did not return a row.");
      }
      return credential;
    } finally {
      client.release();
    }
  }

  async updatePasskeyCredentialAfterAuthentication(input: {
    credentialId: string;
    newSignCount: number;
    backupState: boolean;
    usedAt: Date;
  }): Promise<void> {
    const client = await this.dbPool.connect();
    try {
      await client.query(
        `UPDATE dropship.dropship_passkey_credentials
         SET sign_count = $2,
             backup_state = $3,
             last_used_at = $4
         WHERE credential_id = $1`,
        [input.credentialId, input.newSignCount, input.backupState, input.usedAt],
      );
    } finally {
      client.release();
    }
  }

  async markPasskeyEnrolled(input: {
    authIdentityId: number;
    enrolledAt: Date;
  }): Promise<DropshipAuthIdentityRecord> {
    const client = await this.dbPool.connect();
    try {
      const result = await client.query<AuthIdentityRow>(
        `UPDATE dropship.dropship_auth_identities
         SET passkey_enrolled_at = COALESCE(passkey_enrolled_at, $2),
             updated_at = $2
         WHERE id = $1
         RETURNING id, member_id, primary_email, password_hash, password_hash_algorithm, status, passkey_enrolled_at`,
        [input.authIdentityId, input.enrolledAt],
      );

      const identity = mapAuthIdentity(result.rows[0]);
      if (!identity) {
        throw new Error("Dropship auth identity passkey enrollment update did not return a row.");
      }
      return identity;
    } finally {
      client.release();
    }
  }
}

const PASSKEY_SELECT_SQL = `
  SELECT id, auth_identity_id, member_id, credential_id, public_key, sign_count, transports,
         aaguid, backup_eligible, backup_state
  FROM dropship.dropship_passkey_credentials
`;

function mapAuthIdentity(row: AuthIdentityRow | undefined): DropshipAuthIdentityRecord | null {
  if (!row) return null;
  return {
    authIdentityId: row.id,
    memberId: String(row.member_id),
    primaryEmail: normalizeCardShellzEmail(row.primary_email),
    passwordHash: row.password_hash,
    passwordHashAlgorithm: row.password_hash_algorithm,
    status: row.status,
    passkeyEnrolledAt: row.passkey_enrolled_at,
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The original error is more useful to the caller than a rollback failure.
  }
}

function mapPasskeyCredential(row: PasskeyCredentialRow | undefined): DropshipPasskeyCredentialRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    authIdentityId: row.auth_identity_id,
    memberId: String(row.member_id),
    credentialId: row.credential_id,
    publicKey: row.public_key,
    signCount: row.sign_count,
    transports: Array.isArray(row.transports)
      ? row.transports.filter((transport): transport is string => typeof transport === "string")
      : [],
    aaguid: row.aaguid,
    backupEligible: row.backup_eligible,
    backupState: row.backup_state,
  };
}
