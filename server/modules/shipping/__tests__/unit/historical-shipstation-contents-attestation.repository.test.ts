import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";

import {
  HistoricalShipStationContentsAttestationRepositoryError,
  PgHistoricalShipStationContentsAttestationRepository,
} from "../../historical-shipstation-contents-attestation.repository";

function repositoryWith(input: Readonly<{
  readonly query?: (text: string) => Promise<{ rows: Record<string, unknown>[] }>;
  readonly release?: (error?: Error) => void;
  readonly connectError?: Error;
}> = {}) {
  const query = vi.fn(input.query ?? (async () => ({ rows: [] })));
  const release = vi.fn(input.release ?? (() => undefined));
  const client = { query, release } as unknown as PoolClient;
  const connect = vi.fn(async () => {
    if (input.connectError) throw input.connectError;
    return client;
  });
  const pool = { connect } as unknown as Pool;
  return {
    repository: new PgHistoricalShipStationContentsAttestationRepository(pool),
    query,
    release,
    connect,
  };
}

describe("historical ShipStation contents attestation repository transaction", () => {
  it("rolls back and preserves the application failure", async () => {
    const harness = repositoryWith();
    const primary = new Error("classified application failure");

    const promise = harness.repository.withSerializableTransaction(async () => {
      throw primary;
    });

    await expect(promise).rejects.toBe(primary);
    expect(harness.query.mock.calls.map(([text]) => text)).toEqual([
      "BEGIN TRANSACTION ISOLATION LEVEL SERIALIZABLE",
      "ROLLBACK",
    ]);
    expect(harness.release).toHaveBeenCalledWith(primary);
  });

  it("preserves primary, rollback, and release failures in one classified cleanup error", async () => {
    const primary = new Error("primary");
    const rollback = new Error("rollback");
    const release = new Error("release");
    const harness = repositoryWith({
      query: async (text) => {
        if (text === "ROLLBACK") throw rollback;
        return { rows: [] };
      },
      release: () => {
        throw release;
      },
    });

    const promise = harness.repository.withSerializableTransaction(async () => {
      throw primary;
    });

    await expect(promise).rejects.toMatchObject({ code: "TRANSACTION_CLEANUP_FAILED" });
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(HistoricalShipStationContentsAttestationRepositoryError);
      const cause = (error as Error & { cause?: unknown }).cause;
      expect(cause).toBeInstanceOf(AggregateError);
      expect((cause as AggregateError).errors).toEqual([primary, rollback, release]);
    });
    expect(harness.release).toHaveBeenCalledWith(rollback);
  });

  it("classifies pool connection failures without opening a transaction", async () => {
    const connectError = Object.assign(new Error("connect failed"), { code: "08006" });
    const harness = repositoryWith({ connectError });

    await expect(harness.repository.withSerializableTransaction(async () => "unused"))
      .rejects.toMatchObject({
        code: "DATABASE_ERROR",
        context: { postgresCode: "08006", constraint: null },
      });
    expect(harness.query).not.toHaveBeenCalled();
    expect(harness.release).not.toHaveBeenCalled();
  });
});
