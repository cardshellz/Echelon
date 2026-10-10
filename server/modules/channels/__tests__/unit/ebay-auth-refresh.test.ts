import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EbayAuthService } from "../../adapters/ebay/ebay-auth.service";

const now = new Date("2026-10-10T00:00:00Z");
const config = { clientId: "client", clientSecret: "secret", ruName: "return", environment: "production" as const };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const token = (id: number) => ({ channelId: id, environment: "production", accessToken: `old-${id}`, accessTokenExpiresAt: new Date(now.getTime() - 1000), refreshToken: `refresh-${id}`, refreshTokenExpiresAt: new Date("2027-10-10T00:00:00Z") });
function database() {
  const rows = new Map([[67, token(67)], [68, token(68)]]);
  const writes: Array<Record<string, unknown>> = [];
  const params = (where: SQL) => new PgDialect().sqlToQuery(where).params;
  const db = {
    select: () => ({ from: () => ({ where: (where: SQL) => ({ limit: async () => { const row = rows.get(Number(params(where)[0])); return row ? [row] : []; } }) }) }),
    update: () => ({ set: (values: Record<string, unknown>) => ({ where: (where: SQL) => ({ returning: async () => {
      const valuesInWhere = params(where); const id = Number(valuesInWhere[0]); const row = rows.get(id);
      if (!row || (typeof valuesInWhere[2] === "string" && row.refreshToken !== valuesInWhere[2])) return [];
      rows.set(id, { ...row, ...values }); writes.push(values); return [{ externalAccountId: null }];
    } }) }) }),
    insert: vi.fn(), delete: vi.fn(),
  };
  return { db, rows, writes };
}
afterEach(() => { vi.useRealTimers(); });

describe("eBay authorization refresh isolation", () => {
  it("never shares channel A's refreshed credentials with channel B", async () => {
    const state = database();
    const releases = new Map<string, (value: Response) => void>();
    const fetch = vi.fn<typeof globalThis.fetch>((_url, init) => new Promise((resolve) => releases.set(new URLSearchParams(String(init?.body)).get("refresh_token")!, resolve)));
    const service = new EbayAuthService(state.db, config, { fetch, now: () => now });
    const first = service.getAccessToken(67); const second = service.getAccessToken(68);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    releases.get("refresh-68")!(response({ access_token: "fresh-68", expires_in: 7200 }));
    releases.get("refresh-67")!(response({ access_token: "fresh-67", expires_in: 7200 }));
    await expect(first).resolves.toBe("fresh-67"); await expect(second).resolves.toBe("fresh-68");
    expect(state.rows.get(67)?.accessToken).toBe("fresh-67"); expect(state.rows.get(68)?.accessToken).toBe("fresh-68");
  });
  it("coalesces same-channel refreshes and preserves the original refresh expiry", async () => {
    const state = database(); let release!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise((resolve) => { release = resolve; }));
    const service = new EbayAuthService(state.db, config, { fetch, now: () => now });
    const first = service.getAccessToken(67); const second = service.getAccessToken(67);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    release(response({ access_token: "fresh", expires_in: 7200 }));
    await expect(Promise.all([first, second])).resolves.toEqual(["fresh", "fresh"]);
    expect(state.rows.get(67)?.refreshTokenExpiresAt).toEqual(token(67).refreshTokenExpiresAt);
    expect(state.writes).toHaveLength(1);
  });
  it("does not overwrite a reconnect that completed during the refresh", async () => {
    const state = database(); let release!: (value: Response) => void;
    const fetch = vi.fn<typeof globalThis.fetch>(() => new Promise((resolve) => { release = resolve; }));
    const service = new EbayAuthService(state.db, config, { fetch, now: () => now });
    const access = service.getAccessToken(67);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    state.rows.set(67, { ...token(67), refreshToken: "new-authorization", accessToken: "new-session-access" });
    release(response({ access_token: "obsolete-refresh", expires_in: 7200 }));
    await expect(access).rejects.toMatchObject({ code: "EBAY_AUTH_REFRESH_SUPERSEDED" });
    expect(state.rows.get(67)?.accessToken).toBe("new-session-access"); expect(state.writes).toEqual([]);
  });
  it.each([
    [{ error: "invalid_grant", error_description: "secret refresh-token" }, 400, "EBAY_AUTH_EXPIRED"],
    [{ error: "invalid_client", error_description: "secret client-token" }, 401, "EBAY_AUTH_CONFIGURATION_INVALID"],
    [{ error: "temporarily_unavailable" }, 503, "EBAY_AUTH_UNAVAILABLE"],
    [{ access_token: "bad", expires_in: -1 }, 200, "EBAY_AUTH_RESPONSE_INVALID"],
  ])("classifies failed authorization without exposing provider bodies: %j", async (body, status, code) => {
    const state = database();
    const service = new EbayAuthService(state.db, config, { fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(response(body, Number(status))), now: () => now });
    const error = await service.getAccessToken(67).catch((value: unknown) => value);
    expect(error).toMatchObject({ code }); expect(String(error)).not.toContain("secret"); expect(state.writes).toEqual([]);
  });
  it("fails expired refresh authorization before making a provider call", async () => {
    const state = database(); state.rows.set(67, { ...token(67), refreshTokenExpiresAt: new Date(now.getTime() - 1) });
    const fetch = vi.fn<typeof globalThis.fetch>();
    const service = new EbayAuthService(state.db, config, { fetch, now: () => now });
    await expect(service.getAccessToken(67)).rejects.toMatchObject({ code: "EBAY_AUTH_EXPIRED" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("aborts a timed-out token request and allows a later clean retry", async () => {
    vi.useFakeTimers(); const state = database();
    const fetch = vi.fn<typeof globalThis.fetch>()
      .mockImplementationOnce((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")))))
      .mockResolvedValueOnce(response({ access_token: "retried", expires_in: 7200 }));
    const service = new EbayAuthService(state.db, config, { fetch, now: () => now });
    const failure = expect(service.getAccessToken(67)).rejects.toMatchObject({ code: "EBAY_AUTH_UNAVAILABLE" });
    await vi.advanceTimersByTimeAsync(30_000); await failure;
    expect(state.writes).toEqual([]);
    await expect(service.getAccessToken(67)).resolves.toBe("retried");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
