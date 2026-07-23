import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  createChannelFulfillmentAuthorityRepository,
} from "../../channel-fulfillment-authority.repository";

const dialect = new PgDialect();

function render(query: unknown): string {
  return dialect.sqlToQuery(query as any).sql.replace(/\s+/g, " ").trim();
}

describe("channel fulfillment authority repository", () => {
  it("types the terminal completion timestamp explicitly", async () => {
    const queries: unknown[] = [];
    const tx = {
      execute: vi.fn(async (query: unknown) => {
        queries.push(query);
        if (queries.length === 1) {
          return {
            rows: [{
              id: 91,
              push_status: "processing",
              lease_token: "lease-91",
              attempt_count: 1,
              request_hash: "request-hash",
              correlation_id: null,
              causation_id: null,
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const repository = createChannelFulfillmentAuthorityRepository({
      transaction: (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx),
    });

    await repository.completeAttempt({
      commandId: 91,
      leaseToken: "lease-91",
      outcome: "success",
      providerResponseId: "gid://shopify/Fulfillment/91",
      startedAt: new Date("2026-07-23T15:00:00.000Z"),
      completedAt: new Date("2026-07-23T15:00:01.000Z"),
    });

    const update = queries.map(render).find((query) =>
      query.startsWith("UPDATE oms.channel_fulfillment_pushes"),
    );
    expect(update).toMatch(
      /completed_at = CASE WHEN \$\d+::boolean THEN \$\d+::timestamptz ELSE NULL::timestamptz END/,
    );
  });

  it("types the expired-lease dead-letter timestamp explicitly", async () => {
    const queries: unknown[] = [];
    const now = new Date("2026-07-23T15:10:00.000Z");
    const tx = {
      execute: vi.fn(async (query: unknown) => {
        queries.push(query);
        const text = render(query);
        if (text.includes("WHERE push_status = 'processing'")) {
          return {
            rows: [{
              id: 92,
              attempt_count: 12,
              max_attempts: 12,
              request_hash: "request-hash",
              last_attempt_at: new Date("2026-07-23T15:00:00.000Z"),
              correlation_id: null,
              causation_id: null,
            }],
          };
        }
        return { rows: [] };
      }),
    };
    const repository = createChannelFulfillmentAuthorityRepository({
      transaction: (callback: (executor: typeof tx) => Promise<unknown>) => callback(tx),
    });

    const claimed = await repository.claimCommands({
      now,
      leaseToken: "lease-92",
      leaseDurationMs: 120_000,
      limit: 25,
    });

    expect(claimed).toEqual([]);
    const update = queries.map(render).find((query) =>
      query.startsWith("UPDATE oms.channel_fulfillment_pushes")
      && query.includes("last_error_code = 'LEASE_EXPIRED'"),
    );
    expect(update).toMatch(
      /completed_at = CASE WHEN attempt_count >= max_attempts THEN \$\d+::timestamptz ELSE NULL::timestamptz END/,
    );
  });
});
