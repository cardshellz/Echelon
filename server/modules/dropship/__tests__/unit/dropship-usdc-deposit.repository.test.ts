import { describe, expect, it, vi } from "vitest";
import type { Pool, PoolClient } from "pg";
import {
  PgDropshipUsdcDepositRepository,
  USDC_DEPOSIT_ADDRESS_ALLOCATION_LOCK_ID,
} from "../../infrastructure/dropship-usdc-deposit.repository";

vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@localhost:5432/test";
});

const assignedAt = new Date("2026-09-21T10:00:00.000Z");
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const ADDRESS = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266";
const CHECKSUM = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

function makePool(query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>): Pool {
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  return { query, connect: async () => client } as unknown as Pool;
}

function makeAddressRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    vendor_id: 10,
    chain_id: 8453,
    key_fingerprint: "3bf95407",
    derivation_index: 2,
    address: ADDRESS,
    checksum_address: CHECKSUM,
    assigned_at: assignedAt,
    ...overrides,
  };
}

const derive = (derivationIndex: number) => ({ derivationIndex, address: ADDRESS, checksumAddress: CHECKSUM, keyFingerprint: "3bf95407" });

describe("PgDropshipUsdcDepositRepository (funding design phase 6)", () => {
  it("allocates the next index under an advisory lock, inserts the address and its audit row in one transaction", async () => {
    const statements: string[] = [];
    const captured: Record<string, unknown[] | undefined> = {};
    const derived: number[] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("pg_advisory_xact_lock")) {
        captured.lock = params;
        return { rows: [] };
      }
      if (sql.includes("COALESCE(MAX(derivation_index), -1) + 1")) {
        captured.next = params;
        return { rows: [{ next_index: 2 }] };
      }
      if (sql.includes("FROM dropship.dropship_usdc_deposit_addresses")) return { rows: [] };
      if (sql.includes("INSERT INTO dropship.dropship_usdc_deposit_addresses")) {
        captured.insert = params;
        expect(sql).toContain("ON CONFLICT DO NOTHING");
        return { rows: [makeAddressRow()] };
      }
      if (sql.includes("INSERT INTO dropship.dropship_audit_events")) {
        captured.audit = params;
        return { rows: [] };
      }
      return { rows: [] };
    });

    const result = await new PgDropshipUsdcDepositRepository(makePool(query)).assignDepositAddress({
      vendorId: 10,
      chainId: 8453,
      keyFingerprint: "3bf95407",
      derive: (index) => { derived.push(index); return derive(index); },
      assignedAt,
    });

    expect(result).toEqual({
      created: true,
      address: { depositAddressId: 7, vendorId: 10, chainId: 8453, keyFingerprint: "3bf95407", derivationIndex: 2, address: ADDRESS, checksumAddress: CHECKSUM, assignedAt },
    });
    expect(derived).toEqual([2]);
    expect(captured.lock).toEqual([USDC_DEPOSIT_ADDRESS_ALLOCATION_LOCK_ID]);
    expect(captured.next).toEqual([8453, "3bf95407"]);
    expect(captured.insert).toEqual([10, 8453, "3bf95407", 2, ADDRESS, CHECKSUM, assignedAt]);
    expect(captured.audit?.[3]).toBe("usdc_deposit_address_assigned");
    expect(JSON.parse(String(captured.audit?.[4]))).toEqual({ vendorId: 10, chainId: 8453, keyFingerprint: "3bf95407", derivationIndex: 2, address: ADDRESS, checksumAddress: CHECKSUM });
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toBe("SELECT pg_advisory_xact_lock($1)");
    expect(statements.at(-1)).toBe("COMMIT");
  });

  it("hands back the existing address without deriving or inserting anything", async () => {
    const statements: string[] = [];
    const derive = vi.fn();
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("FROM dropship.dropship_usdc_deposit_addresses")) return { rows: [makeAddressRow()] };
      if (sql.includes("INSERT INTO")) throw new Error("must not insert");
      return { rows: [] };
    });

    const result = await new PgDropshipUsdcDepositRepository(makePool(query)).assignDepositAddress({ vendorId: 10, chainId: 8453, keyFingerprint: "3bf95407", derive, assignedAt });

    expect(result.created).toBe(false);
    expect(result.address.depositAddressId).toBe(7);
    expect(derive).not.toHaveBeenCalled();
    expect(statements).toEqual(["BEGIN", "SELECT pg_advisory_xact_lock($1)", "SELECT id,", "COMMIT"]);
  });

  it("rolls back when the derived address does not belong to the key and index being allocated, or when the insert conflicts", async () => {
    const statements: string[] = [];
    const query = vi.fn(async (sql: string) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 2).join(" "));
      if (sql.includes("COALESCE(MAX(derivation_index), -1) + 1")) return { rows: [{ next_index: 0 }] };
      return { rows: [] };
    });
    const repository = new PgDropshipUsdcDepositRepository(makePool(query));

    await expect(repository.assignDepositAddress({
      vendorId: 10, chainId: 8453, keyFingerprint: "3bf95407", assignedAt,
      derive: () => ({ derivationIndex: 0, address: ADDRESS, checksumAddress: CHECKSUM, keyFingerprint: "deadbeef" }),
    })).rejects.toMatchObject({ code: "DROPSHIP_USDC_DEPOSIT_ADDRESS_DERIVATION_MISMATCH", context: { classification: "fatal" } });
    expect(statements.at(-1)).toBe("ROLLBACK");

    // The insert answers no row: the address or index is already taken.
    await expect(repository.assignDepositAddress({ vendorId: 10, chainId: 8453, keyFingerprint: "3bf95407", derive, assignedAt }))
      .rejects.toMatchObject({ code: "DROPSHIP_USDC_DEPOSIT_ADDRESS_CONFLICT" });
    expect(statements.at(-1)).toBe("ROLLBACK");
  });

  it("reads addresses by vendor and by lowercase address, and lists a chain's addresses in id order", async () => {
    const captured: unknown[][] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push(params ?? []);
      if (sql.includes("ORDER BY id ASC")) return { rows: [makeAddressRow({ id: 1 }), makeAddressRow({ id: 2, vendor_id: 11 })] };
      return { rows: [makeAddressRow()] };
    });
    const repository = new PgDropshipUsdcDepositRepository(makePool(query));

    expect((await repository.findDepositAddress({ vendorId: 10, chainId: 8453 }))?.depositAddressId).toBe(7);
    expect((await repository.findDepositAddressByAddress({ chainId: 8453, address: CHECKSUM }))?.vendorId).toBe(10);
    expect((await repository.listDepositAddresses({ chainId: 8453 })).map((row) => row.vendorId)).toEqual([10, 11]);
    expect(captured).toEqual([[10, 8453], [8453, ADDRESS], [8453]]);
  });

  it("moves the watcher cursor forward only, keyed by chain and lowercase token", async () => {
    const captured: unknown[][] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      captured.push(params ?? []);
      if (sql.includes("INSERT INTO dropship.dropship_usdc_watcher_cursors")) {
        expect(sql).toContain("WHERE dropship_usdc_watcher_cursors.last_scanned_block <= EXCLUDED.last_scanned_block");
        return (params?.[2] as number) >= 900
          ? { rows: [{ chain_id: 8453, token_address: USDC, last_scanned_block: String(params?.[2]), updated_at: assignedAt }] }
          : { rows: [] };
      }
      return { rows: [{ chain_id: 8453, token_address: USDC, last_scanned_block: "900", updated_at: assignedAt }] };
    });
    const repository = new PgDropshipUsdcDepositRepository(makePool(query));

    expect(await repository.readWatcherCursor({ chainId: 8453, tokenAddress: USDC.toUpperCase().replace("0X", "0x") })).toEqual({ chainId: 8453, tokenAddress: USDC, lastScannedBlock: 900, updatedAt: assignedAt });
    expect((await repository.advanceWatcherCursor({ chainId: 8453, tokenAddress: USDC, lastScannedBlock: 995, updatedAt: assignedAt })).lastScannedBlock).toBe(995);
    await expect(repository.advanceWatcherCursor({ chainId: 8453, tokenAddress: USDC, lastScannedBlock: 800, updatedAt: assignedAt }))
      .rejects.toMatchObject({ code: "DROPSHIP_USDC_WATCHER_CURSOR_REGRESSION" });
    expect(captured[0]).toEqual([8453, USDC]);
    expect(captured[1]).toEqual([8453, USDC, 995, assignedAt]);
  });

  it("reads the custody expectations per address as exact atomic units and whole cents", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(params).toEqual([8453]);
      expect(sql).toContain("e.status IN ('pending', 'settled', 'dust')");
      expect(sql).toContain("FLOOR(e.amount_atomic_units / 10000)");
      return { rows: [
        { id: 1, vendor_id: 10, address: ADDRESS, checksum_address: CHECKSUM, expected_atomic_units: "123456789012345678901234", credited_cents: "12345678901234567", observation_count: "3" },
        { id: 2, vendor_id: 11, address: "0x" + "b".repeat(40), checksum_address: "0x" + "B".repeat(40), expected_atomic_units: "0", credited_cents: "0", observation_count: 0 },
      ] };
    });

    await expect(new PgDropshipUsdcDepositRepository(makePool(query)).listCustodyExpectations({ chainId: 8453 })).rejects.toMatchObject({ code: "DROPSHIP_USDC_INTEGER_RANGE_ERROR" });

    const smaller = vi.fn(async () => ({ rows: [
      { id: 1, vendor_id: 10, address: ADDRESS, checksum_address: CHECKSUM, expected_atomic_units: "123456789012345678901234", credited_cents: "2512", observation_count: "3" },
    ] }));
    expect(await new PgDropshipUsdcDepositRepository(makePool(smaller)).listCustodyExpectations({ chainId: 8453 })).toEqual([
      { depositAddressId: 1, vendorId: 10, address: ADDRESS, checksumAddress: CHECKSUM, expectedAtomicUnits: "123456789012345678901234", creditedCents: 2512, observationCount: 3 },
    ]);
  });
});
