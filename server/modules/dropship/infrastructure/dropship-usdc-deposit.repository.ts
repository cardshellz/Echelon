/**
 * Per-vendor USDC deposit addresses, the watcher's cursor and the custody
 * expectations (funding design phase 6, migration 0691).
 *
 * The wallet ledger side of a deposit (balances, ledger rows, the chain
 * observation) lives in the wallet repository; this one owns the address
 * book and the watcher's place. Index allocation is serialized with a
 * transaction-scoped advisory lock so two vendors can never be handed the
 * same address, and every assignment writes its audit row in the same
 * transaction.
 */

import type { Pool, PoolClient } from "pg";
import { pool as defaultPool } from "../../../db";
import { DropshipError } from "../domain/errors";
import type {
  AssignDropshipUsdcDepositAddressRepositoryInput,
  DropshipUsdcCustodyExpectation,
  DropshipUsdcDepositAddressRecord,
  DropshipUsdcDepositRepository,
  DropshipUsdcWatcherCursorRecord,
} from "../application/dropship-usdc-deposit-service";

/** Serializes derivation-index allocation across processes. Distinct from every worker lock id. */
export const USDC_DEPOSIT_ADDRESS_ALLOCATION_LOCK_ID = 736214;

interface DepositAddressRow {
  id: number;
  vendor_id: number;
  chain_id: number;
  key_fingerprint: string;
  derivation_index: number;
  address: string;
  checksum_address: string;
  assigned_at: Date;
}

interface WatcherCursorRow {
  chain_id: number;
  token_address: string;
  last_scanned_block: string | number;
  updated_at: Date;
}

interface CustodyExpectationRow {
  id: number;
  vendor_id: number;
  address: string;
  checksum_address: string;
  expected_atomic_units: string | number | null;
  credited_cents: string | number | null;
  observation_count: string | number;
}

const DEPOSIT_ADDRESS_COLUMNS = "id, vendor_id, chain_id, key_fingerprint, derivation_index, address, checksum_address, assigned_at";

export class PgDropshipUsdcDepositRepository implements DropshipUsdcDepositRepository {
  constructor(private readonly dbPool: Pool = defaultPool) {}

  async findDepositAddress(input: { vendorId: number; chainId: number }): Promise<DropshipUsdcDepositAddressRecord | null> {
    const result = await this.dbPool.query<DepositAddressRow>(
      `SELECT ${DEPOSIT_ADDRESS_COLUMNS}
       FROM dropship.dropship_usdc_deposit_addresses
       WHERE vendor_id = $1
         AND chain_id = $2
       LIMIT 1`,
      [input.vendorId, input.chainId],
    );
    return result.rows[0] ? mapDepositAddressRow(result.rows[0]) : null;
  }

  async findDepositAddressByAddress(input: { chainId: number; address: string }): Promise<DropshipUsdcDepositAddressRecord | null> {
    const result = await this.dbPool.query<DepositAddressRow>(
      `SELECT ${DEPOSIT_ADDRESS_COLUMNS}
       FROM dropship.dropship_usdc_deposit_addresses
       WHERE chain_id = $1
         AND address = $2
       LIMIT 1`,
      [input.chainId, input.address.toLowerCase()],
    );
    return result.rows[0] ? mapDepositAddressRow(result.rows[0]) : null;
  }

  async listDepositAddresses(input: { chainId: number }): Promise<DropshipUsdcDepositAddressRecord[]> {
    const result = await this.dbPool.query<DepositAddressRow>(
      `SELECT ${DEPOSIT_ADDRESS_COLUMNS}
       FROM dropship.dropship_usdc_deposit_addresses
       WHERE chain_id = $1
       ORDER BY id ASC`,
      [input.chainId],
    );
    return result.rows.map(mapDepositAddressRow);
  }

  /**
   * Hand the vendor their address, deriving the next unused index under the
   * current key. Idempotent: a vendor who already has one gets it back.
   */
  async assignDepositAddress(
    input: AssignDropshipUsdcDepositAddressRepositoryInput,
  ): Promise<{ address: DropshipUsdcDepositAddressRecord; created: boolean }> {
    const client = await this.dbPool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock($1)", [USDC_DEPOSIT_ADDRESS_ALLOCATION_LOCK_ID]);
      const existing = await findDepositAddressWithClient(client, input);
      if (existing) {
        await client.query("COMMIT");
        return { address: existing, created: false };
      }
      const next = await client.query<{ next_index: number }>(
        `SELECT COALESCE(MAX(derivation_index), -1) + 1 AS next_index
         FROM dropship.dropship_usdc_deposit_addresses
         WHERE chain_id = $1
           AND key_fingerprint = $2`,
        [input.chainId, input.keyFingerprint],
      );
      const derivationIndex = Number(next.rows[0]?.next_index ?? 0);
      const derived = input.derive(derivationIndex);
      if (derived.keyFingerprint !== input.keyFingerprint || derived.derivationIndex !== derivationIndex) {
        throw new DropshipError(
          "DROPSHIP_USDC_DEPOSIT_ADDRESS_DERIVATION_MISMATCH",
          "The derived deposit address does not belong to the key and index being allocated.",
          {
            vendorId: input.vendorId,
            keyFingerprint: input.keyFingerprint,
            derivedKeyFingerprint: derived.keyFingerprint,
            derivationIndex,
            derivedIndex: derived.derivationIndex,
            classification: "fatal",
          },
        );
      }
      const inserted = await client.query<DepositAddressRow>(
        `INSERT INTO dropship.dropship_usdc_deposit_addresses
          (vendor_id, chain_id, key_fingerprint, derivation_index, address, checksum_address, assigned_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING
         RETURNING ${DEPOSIT_ADDRESS_COLUMNS}`,
        [
          input.vendorId,
          input.chainId,
          input.keyFingerprint,
          derivationIndex,
          derived.address,
          derived.checksumAddress,
          input.assignedAt,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        // The lock makes this unreachable for a same-key race; it fires only
        // if the address or index already exists under another row, which is
        // a key or data fault a human must look at.
        throw new DropshipError(
          "DROPSHIP_USDC_DEPOSIT_ADDRESS_CONFLICT",
          "The deposit address or derivation index is already assigned.",
          { vendorId: input.vendorId, keyFingerprint: input.keyFingerprint, derivationIndex, address: derived.address, classification: "fatal" },
        );
      }
      const address = mapDepositAddressRow(row);
      await client.query(
        `INSERT INTO dropship.dropship_audit_events
          (vendor_id, entity_type, entity_id, event_type,
           actor_type, actor_id, severity, payload, created_at)
         VALUES ($1, $2, $3, $4, 'system', NULL, 'info', $5::jsonb, $6)`,
        [
          input.vendorId,
          "dropship_usdc_deposit_addresses",
          String(address.depositAddressId),
          "usdc_deposit_address_assigned",
          JSON.stringify({
            vendorId: address.vendorId,
            chainId: address.chainId,
            keyFingerprint: address.keyFingerprint,
            derivationIndex: address.derivationIndex,
            address: address.address,
            checksumAddress: address.checksumAddress,
          }),
          input.assignedAt,
        ],
      );
      await client.query("COMMIT");
      return { address, created: true };
    } catch (error) {
      await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }

  async readWatcherCursor(input: { chainId: number; tokenAddress: string }): Promise<DropshipUsdcWatcherCursorRecord | null> {
    const result = await this.dbPool.query<WatcherCursorRow>(
      `SELECT chain_id, token_address, last_scanned_block, updated_at
       FROM dropship.dropship_usdc_watcher_cursors
       WHERE chain_id = $1
         AND token_address = $2
       LIMIT 1`,
      [input.chainId, input.tokenAddress.toLowerCase()],
    );
    return result.rows[0] ? mapWatcherCursorRow(result.rows[0]) : null;
  }

  /** Move the cursor forward; it never moves back, so a stale tick cannot re-open scanned blocks. */
  async advanceWatcherCursor(input: {
    chainId: number;
    tokenAddress: string;
    lastScannedBlock: number;
    updatedAt: Date;
  }): Promise<DropshipUsdcWatcherCursorRecord> {
    const result = await this.dbPool.query<WatcherCursorRow>(
      `INSERT INTO dropship.dropship_usdc_watcher_cursors
        (chain_id, token_address, last_scanned_block, updated_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (chain_id, token_address) DO UPDATE
         SET last_scanned_block = EXCLUDED.last_scanned_block,
             updated_at = EXCLUDED.updated_at
         WHERE dropship_usdc_watcher_cursors.last_scanned_block <= EXCLUDED.last_scanned_block
       RETURNING chain_id, token_address, last_scanned_block, updated_at`,
      [input.chainId, input.tokenAddress.toLowerCase(), input.lastScannedBlock, input.updatedAt],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DropshipError(
        "DROPSHIP_USDC_WATCHER_CURSOR_REGRESSION",
        "The USDC watcher cursor is already past the block being recorded.",
        { chainId: input.chainId, tokenAddress: input.tokenAddress, lastScannedBlock: input.lastScannedBlock, classification: "permanent" },
      );
    }
    return mapWatcherCursorRow(row);
  }

  /**
   * What the ledger expects to sit at each address before any sweep: every
   * observation that was not voided, in atomic units, and the cents credited.
   */
  async listCustodyExpectations(input: { chainId: number }): Promise<DropshipUsdcCustodyExpectation[]> {
    const result = await this.dbPool.query<CustodyExpectationRow>(
      `SELECT a.id, a.vendor_id, a.address, a.checksum_address,
              COALESCE(SUM(e.amount_atomic_units) FILTER (WHERE e.status IN ('pending', 'settled', 'dust')), 0)::text AS expected_atomic_units,
              COALESCE(SUM(FLOOR(e.amount_atomic_units / 10000)) FILTER (WHERE e.status IN ('pending', 'settled')), 0)::text AS credited_cents,
              COUNT(e.id) FILTER (WHERE e.status IN ('pending', 'settled', 'dust')) AS observation_count
       FROM dropship.dropship_usdc_deposit_addresses a
       LEFT JOIN dropship.dropship_usdc_ledger_entries e ON e.deposit_address_id = a.id
       WHERE a.chain_id = $1
       GROUP BY a.id, a.vendor_id, a.address, a.checksum_address
       ORDER BY a.id ASC`,
      [input.chainId],
    );
    return result.rows.map((row) => ({
      depositAddressId: row.id,
      vendorId: row.vendor_id,
      address: row.address,
      checksumAddress: row.checksum_address,
      expectedAtomicUnits: String(row.expected_atomic_units ?? "0"),
      creditedCents: toSafeInteger(row.credited_cents ?? 0, "credited_cents"),
      observationCount: toSafeInteger(row.observation_count, "observation_count"),
    }));
  }
}

async function findDepositAddressWithClient(
  client: PoolClient,
  input: { vendorId: number; chainId: number },
): Promise<DropshipUsdcDepositAddressRecord | null> {
  const result = await client.query<DepositAddressRow>(
    `SELECT ${DEPOSIT_ADDRESS_COLUMNS}
     FROM dropship.dropship_usdc_deposit_addresses
     WHERE vendor_id = $1
       AND chain_id = $2
     LIMIT 1`,
    [input.vendorId, input.chainId],
  );
  return result.rows[0] ? mapDepositAddressRow(result.rows[0]) : null;
}

function mapDepositAddressRow(row: DepositAddressRow): DropshipUsdcDepositAddressRecord {
  return {
    depositAddressId: row.id,
    vendorId: row.vendor_id,
    chainId: row.chain_id,
    keyFingerprint: row.key_fingerprint,
    derivationIndex: row.derivation_index,
    address: row.address,
    checksumAddress: row.checksum_address,
    assignedAt: row.assigned_at,
  };
}

function mapWatcherCursorRow(row: WatcherCursorRow): DropshipUsdcWatcherCursorRecord {
  return {
    chainId: row.chain_id,
    tokenAddress: row.token_address,
    lastScannedBlock: toSafeInteger(row.last_scanned_block, "last_scanned_block"),
    updatedAt: row.updated_at,
  };
}

function toSafeInteger(value: string | number, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new DropshipError(
      "DROPSHIP_USDC_INTEGER_RANGE_ERROR",
      "USDC deposit integer value is outside the safe runtime range.",
      { field, value: String(value), classification: "permanent" },
    );
  }
  return parsed;
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // The connection is being released; the failed transaction is discarded either way.
  }
}
