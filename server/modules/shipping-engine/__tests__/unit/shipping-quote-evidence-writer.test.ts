import { readFileSync } from "fs";
import { resolve } from "path";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  PostgresShippingQuoteEvidenceWriter,
} from "../../infrastructure/postgres-shipping-quote-evidence.writer";

describe("PostgresShippingQuoteEvidenceWriter", () => {
  it("inserts one normalized evidence snapshot", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "41" }] });
    const release = vi.fn();
    const writer = new PostgresShippingQuoteEvidenceWriter(fakePool({
      query,
      release,
    }));

    const result = await writer.persistOnce(input());

    expect(result).toEqual({ snapshotId: 41, created: true });
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual(expect.arrayContaining([
      "shadow",
      "US",
      "16066",
    ]));
    const requestPayload = JSON.parse(query.mock.calls[0][1][5]);
    expect(requestPayload).toMatchObject({
      evidenceKind: "dropship_shipping_rate_comparison",
      evidenceKey: "77",
      legacyQuoteSnapshotId: 77,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("returns the existing snapshot after an idempotent conflict", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: 41 }] });
    const writer = new PostgresShippingQuoteEvidenceWriter(fakePool({
      query,
      release: vi.fn(),
    }));

    const result = await writer.persistOnce(input());

    expect(result).toEqual({ snapshotId: 41, created: false });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1][0])).toContain(
      "request_payload->>'evidenceKind'",
    );
  });

  it("validates evidence before opening a database connection", async () => {
    const connect = vi.fn();
    const writer = new PostgresShippingQuoteEvidenceWriter({
      connect,
    } as unknown as Pool);

    await expect(writer.persistOnce({
      ...input(),
      destinationCountry: "United States",
    })).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });

  it("rejects non-shadow sources because only shadow evidence is idempotent", async () => {
    const connect = vi.fn();
    const writer = new PostgresShippingQuoteEvidenceWriter({
      connect,
    } as unknown as Pool);

    await expect(writer.persistOnce({
      ...input(),
      source: "manual",
    } as unknown as ReturnType<typeof input>)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("shipping shadow evidence idempotency migration", () => {
  it("creates a namespaced partial unique index", () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        "migrations/0596_shipping_shadow_evidence_idempotency.sql",
      ),
      "utf8",
    );

    expect(sql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS");
    expect(sql).toContain("request_payload->>'evidenceKind'");
    expect(sql).toContain("request_payload->>'evidenceKey'");
    expect(sql).toContain("WHERE source = 'shadow'");
  });
});

function input() {
  return {
    source: "shadow" as const,
    evidenceKind: "dropship_shipping_rate_comparison",
    evidenceKey: "77",
    destinationCountry: "us",
    destinationPostalCode: "16066",
    resolvedZone: "PA",
    requestHash: "a".repeat(64),
    requestPayload: {
      legacyQuoteSnapshotId: 77,
    },
    packing: null,
    rates: null,
    metadata: {
      outcome: "match",
    },
    createdAt: new Date("2026-07-26T12:00:00.000Z"),
  };
}

function fakePool(input: {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}): Pool {
  return {
    connect: vi.fn(async () => ({
      query: input.query,
      release: input.release,
    })),
  } as unknown as Pool;
}
