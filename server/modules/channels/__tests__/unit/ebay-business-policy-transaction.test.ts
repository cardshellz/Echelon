import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { PgEbayBusinessPolicyRepository } from "../../infrastructure/ebay-business-policies.repository";

vi.mock("../../../../db", () => ({ db: {}, pool: {} }));
const scope = { channelId: 67, connectionId: 9, accountId: "seller", environment: "production" as const, marketplaceId: "EBAY_US" };

function fixture(failures: ReadonlyMap<string, Error> = new Map()) {
  const query = vi.fn(async (statement: string) => {
    const failure = failures.get(statement);
    if (failure) throw failure;
    if (statement.includes("FROM channels.channel_connections")) return { rows: [{ id: 9, metadata: { marketplaceId: "EBAY_US" } }] };
    if (statement.includes("FROM ebay.ebay_oauth_tokens")) return { rows: [{ external_account_id: "seller", external_account_identity_scheme: "provider_user_id", external_account_verified_at: new Date("2026-10-19T00:00:00Z") }] };
    return { rows: [] };
  });
  const release = vi.fn();
  const repository = new PgEbayBusinessPolicyRepository({ connect: async () => ({ query, release }) } as unknown as Pool);
  return { repository, query, release };
}

describe("eBay policy transaction transport failures", () => {
  it("discards a connection when BEGIN fails without running the operation", async () => {
    const original = new Error("begin response lost");
    const { repository, query, release } = fixture(new Map([["BEGIN", original]]));
    const run = vi.fn();
    await expect(repository.withScope(scope, run)).rejects.toBe(original);
    expect(run).not.toHaveBeenCalled();
    expect(query.mock.calls.map(([statement]) => statement)).toEqual(["BEGIN"]);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("preserves a failed COMMIT response and discards the session even if rollback responds", async () => {
    const original = new Error("commit response lost");
    const { repository, query, release } = fixture(new Map([["COMMIT", original]]));
    await expect(repository.withScope(scope, async () => "result")).rejects.toBe(original);
    expect(query.mock.calls.map(([statement]) => statement).slice(-2)).toEqual(["COMMIT", "ROLLBACK"]);
    expect(release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("preserves the operation failure when rollback also fails and destroys the connection", async () => {
    const original = new Error("audit failed");
    const { repository, release } = fixture(new Map([["ROLLBACK", new Error("socket closed")]]));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(repository.withScope(scope, async () => { throw original; })).rejects.toBe(original);
      expect(release).toHaveBeenCalledExactlyOnceWith(true);
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "ebay_policy_rollback_failed", channelId: 67, connectionId: 9 }));
    } finally { log.mockRestore(); }
  });

  it("returns a clean connection after an ordinary failure with a successful rollback", async () => {
    const original = new Error("stale edit");
    const { repository, query, release } = fixture();
    await expect(repository.withScope(scope, async () => { throw original; })).rejects.toBe(original);
    expect(query.mock.calls.at(-1)).toEqual(["ROLLBACK"]);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("returns the result only after commit and releases a clean connection", async () => {
    const { repository, query, release } = fixture();
    await expect(repository.withScope(scope, async () => "committed")).resolves.toBe("committed");
    expect(query.mock.calls.at(-1)).toEqual(["COMMIT"]);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
