import { createHash, createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createShopifyStaffOAuthService, type ShopifyStaffOAuthTelemetry } from "../../application/shopify-staff-oauth.service";
import { parseShopifyStaffOAuthConfig } from "../../domain/shopify-staff-oauth";
import {
  ShopifyStaffOAuthError,
  type ShopifyStaffOAuthBinding,
  type ShopifyStaffOAuthClaim,
  type ShopifyStaffOAuthClaimInput,
  type ShopifyStaffOAuthClaimResult,
  type ShopifyStaffOAuthConfig,
  type ShopifyStaffOAuthCreate,
  type ShopifyStaffOAuthResult,
  type ShopifyStaffOAuthToken,
} from "../../shopify-staff-oauth.types";

const NOW = new Date("2026-11-03T12:00:00.000Z");
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "staff-fixture";
const SESSION_ID = "private-session-fixture";
const NONCE = "a".repeat(64);
const STATE = `echelon-shopify-${NONCE}`;
const CODE = "one-use-code-fixture";
const SECRET = "private-client-secret-fixture";
const CONFIG = parseShopifyStaffOAuthConfig({ SHOPIFY_API_KEY: "client-fixture", SHOPIFY_API_SECRET: SECRET });
const TOKEN = { accessToken: "private-access-token-fixture", scopes: CONFIG.scopes.join(",") };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");

function signedQuery(overrides: Record<string, string> = {}) {
  const fields: Record<string, string> = {
    code: CODE, shop: CONFIG.shopDomain, state: STATE, timestamp: String(NOW.getTime() / 1000), ...overrides,
  };
  const message = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join("&");
  return new URLSearchParams({ ...fields, hmac: createHmac("sha256", SECRET).update(message).digest("hex") }).toString();
}

function fixture() {
  let clock = new Date(NOW);
  const binding: ShopifyStaffOAuthBinding = {
    actorId: ACTOR_ID, sessionHash: hash(SESSION_ID), stateHash: hash(STATE),
    configFingerprint: CONFIG.fingerprint, shopDomain: CONFIG.shopDomain,
    operationId: OPERATION_ID, channelId: 36, connectionId: 91, connectionFingerprint: "e".repeat(64),
    createdAt: new Date(NOW), expiresAt: new Date(NOW.getTime() + 600_000),
  };
  const claim: ShopifyStaffOAuthClaim = { ...binding, attemptId: ATTEMPT_ID };
  const connected: ShopifyStaffOAuthResult = {
    operationId: OPERATION_ID, channelId: 36, connectionId: 91, status: "connected", replayed: false,
  };
  const repository = {
    create: vi.fn(async (input: ShopifyStaffOAuthCreate): Promise<ShopifyStaffOAuthBinding> => ({
      ...binding, operationId: input.operationId, actorId: input.actorId, sessionHash: input.sessionHash,
      stateHash: input.stateHash, createdAt: input.now, expiresAt: input.expiresAt,
    })),
    claim: vi.fn(async (_input: ShopifyStaffOAuthClaimInput): Promise<ShopifyStaffOAuthClaimResult> => ({ kind: "claimed", claim })),
    complete: vi.fn(async (_claim: ShopifyStaffOAuthClaim, _token: ShopifyStaffOAuthToken, _now: Date): Promise<ShopifyStaffOAuthResult> => connected),
    fail: vi.fn(async (_claim: ShopifyStaffOAuthClaim, _status: "failed" | "exchange_unknown", _code: string, _now: Date): Promise<void> => undefined),
    outcome: vi.fn(async (_input: ShopifyStaffOAuthClaimInput): Promise<ShopifyStaffOAuthResult | null> => null),
  };
  const readConfig = vi.fn(() => CONFIG);
  const exchange = vi.fn(async (_config: ShopifyStaffOAuthConfig, _code: string): Promise<ShopifyStaffOAuthToken> => TOKEN);
  const uuid = vi.fn(() => ATTEMPT_ID);
  const nonce = vi.fn(() => NONCE);
  const telemetry = vi.fn((_event: ShopifyStaffOAuthTelemetry): void => undefined);
  const service = createShopifyStaffOAuthService({ repository, readConfig, exchange, uuid, nonce, telemetry, now: () => new Date(clock) });
  return {
    service, repository, readConfig, exchange, uuid, nonce, telemetry, binding, claim, connected,
    setClock: (next: Date) => { clock = next; },
    callbackInput: { actorId: ACTOR_ID, sessionId: SESSION_ID, rawQuery: signedQuery() },
  };
}

async function safeRejection(promise: Promise<unknown>): Promise<ShopifyStaffOAuthError> {
  const error: unknown = await promise.then(() => { throw new Error("Expected a safe command rejection"); }, failure => failure);
  expect(error).toBeInstanceOf(ShopifyStaffOAuthError);
  const safe = error as ShopifyStaffOAuthError;
  expect(safe.code).toMatch(/^SHOPIFY_OAUTH_[A-Z_]+$/);
  expect(safe.message).toBe(safe.code);
  expect(safe.cause).toBeUndefined();
  for (const secret of [SECRET, SESSION_ID, STATE, CODE, TOKEN.accessToken, "private-database-error"]) {
    expect(safe.message).not.toContain(secret);
  }
  return safe;
}

describe("Shopify staff OAuth begin command", () => {
  it("persists only hashes of the state and session, with exact config/channel binding and a ten-minute expiry", async () => {
    const f = fixture(); f.uuid.mockReturnValue(OPERATION_ID);
    const result = await f.service.begin({ actorId: ACTOR_ID, sessionId: SESSION_ID, channelId: 36 });
    expect(f.repository.create).toHaveBeenCalledExactlyOnceWith({
      actorId: ACTOR_ID, sessionHash: hash(SESSION_ID), operationId: OPERATION_ID, stateHash: hash(STATE),
      configFingerprint: CONFIG.fingerprint, shopDomain: CONFIG.shopDomain, requestedChannelId: 36,
      now: NOW, expiresAt: new Date(NOW.getTime() + 600_000),
    });
    expect(JSON.stringify(f.repository.create.mock.calls)).not.toContain(SESSION_ID);
    expect(JSON.stringify(f.repository.create.mock.calls)).not.toContain(STATE);
    const authorization = new URL(result.authorizationUrl);
    expect(authorization.origin).toBe(`https://${CONFIG.shopDomain}`);
    expect(authorization.pathname).toBe("/admin/oauth/authorize");
    expect(authorization.searchParams.get("state")).toBe(STATE);
    expect(authorization.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(authorization.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(authorization.searchParams.get("scope")).toBe(CONFIG.scopes.join(","));
    expect(result).toMatchObject({ operationId: OPERATION_ID, channelId: 36, connectionId: 91, expiresAt: f.binding.expiresAt });
    expect(f.repository.claim).not.toHaveBeenCalled();
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.telemetry).toHaveBeenCalledWith(expect.objectContaining({
      module: "channels", action: "shopify_oauth.begin", outcome: "issued", operationId: OPERATION_ID, channelId: 36, connectionId: 91,
    }));
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects an invalid explicit channel before storing a challenge", async channelId => {
    const f = fixture();
    await safeRejection(f.service.begin({ actorId: ACTOR_ID, sessionId: SESSION_ID, channelId }));
    expect(f.repository.create).not.toHaveBeenCalled();
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it("rejects malformed nonce material without issuing a challenge", async () => {
    const f = fixture(); f.nonce.mockReturnValue("short");
    await safeRejection(f.service.begin({ actorId: ACTOR_ID, sessionId: SESSION_ID }));
    expect(f.repository.create).not.toHaveBeenCalled();
  });

  it("sanitizes a challenge storage failure and never reaches the provider", async () => {
    const f = fixture(); f.repository.create.mockRejectedValue(new Error(`private-database-error ${SECRET}`));
    await safeRejection(f.service.begin({ actorId: ACTOR_ID, sessionId: SESSION_ID }));
    expect(f.exchange).not.toHaveBeenCalled();
  });
});

describe("Shopify staff OAuth callback command", () => {
  it.each([
    () => "code=%GG",
    () => signedQuery().replace(CODE, "tampered-code"),
    () => signedQuery({ state: "not-a-staff-challenge" }),
    () => `${signedQuery()}&co%64e=duplicate`,
    () => signedQuery({ shop: "another-shop.myshopify.com" }),
  ])("rejects malformed, unauthenticated or wrong-flow input before claim or exchange", async query => {
    const f = fixture();
    await safeRejection(f.service.callback({ ...f.callbackInput, rawQuery: query() }));
    expect(f.repository.claim).not.toHaveBeenCalled();
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it.each([{ actorId: "" }, { sessionId: "" }])("requires the authenticated actor/session before repository or provider calls", async override => {
    const f = fixture();
    await safeRejection(f.service.callback({ ...f.callbackInput, ...override }));
    expect(f.repository.claim).not.toHaveBeenCalled();
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it("uses the repository claim as the exact operation/connection binding and exchanges just once", async () => {
    const f = fixture();
    const result = await f.service.callback(f.callbackInput);
    expect(f.repository.claim).toHaveBeenCalledExactlyOnceWith({
      actorId: ACTOR_ID, sessionHash: hash(SESSION_ID), stateHash: hash(STATE), configFingerprint: CONFIG.fingerprint,
      shopDomain: CONFIG.shopDomain, attemptId: ATTEMPT_ID, now: NOW,
    });
    expect(f.exchange).toHaveBeenCalledExactlyOnceWith(CONFIG, CODE);
    expect(f.repository.complete).toHaveBeenCalledExactlyOnceWith(f.claim, TOKEN, NOW);
    expect(result).toEqual(f.connected);
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.telemetry).toHaveBeenCalledWith(expect.objectContaining({
      module: "channels", action: "shopify_oauth.callback", outcome: "connected", actorId: ACTOR_ID,
      operationId: OPERATION_ID, attemptId: ATTEMPT_ID, channelId: 36, connectionId: 91, retrySafe: false,
    }));
  });

  it.each(["connected", "in_progress", "exchange_unknown", "failed", "superseded"] as const)(
    "returns a durable %s replay without exchanging or overwriting it", async status => {
      const f = fixture(); const replay = { ...f.connected, status, replayed: true };
      f.repository.claim.mockResolvedValue({ kind: "result", result: replay });
      expect(await f.service.callback(f.callbackInput)).toEqual(replay);
      expect(f.exchange).not.toHaveBeenCalled();
      expect(f.repository.complete).not.toHaveBeenCalled();
      expect(f.repository.fail).not.toHaveBeenCalled();
    },
  );

  it("does not exchange again when the same callback is replayed after success", async () => {
    const f = fixture();
    f.repository.claim.mockResolvedValueOnce({ kind: "claimed", claim: f.claim })
      .mockResolvedValueOnce({ kind: "result", result: { ...f.connected, replayed: true } });
    await f.service.callback(f.callbackInput);
    expect(await f.service.callback(f.callbackInput)).toMatchObject({ status: "connected", replayed: true });
    expect(f.exchange).toHaveBeenCalledOnce();
    expect(f.repository.complete).toHaveBeenCalledOnce();
  });

  it("rechecks expiry after a slow claim and records failure without starting an exchange", async () => {
    const f = fixture();
    f.repository.claim.mockImplementation(async () => {
      f.setClock(new Date(f.claim.expiresAt));
      return { kind: "claimed", claim: f.claim };
    });
    await safeRejection(f.service.callback(f.callbackInput));
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.fail).toHaveBeenCalledExactlyOnceWith(f.claim, "failed", expect.stringMatching(/^SHOPIFY_OAUTH_/), f.claim.expiresAt);
  });

  it.each([
    new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXCHANGE_REJECTED", 400, "failed"),
    new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXCHANGE_UNKNOWN", 502, "exchange_unknown"),
  ])("records the provider's known/uncertain classification before surfacing its safe error", async providerError => {
    const f = fixture(); f.exchange.mockRejectedValue(providerError);
    const error = await safeRejection(f.service.callback(f.callbackInput));
    expect(error.outcome).toBe(providerError.outcome);
    expect(error.operationId).toBe(OPERATION_ID);
    expect(f.repository.fail).toHaveBeenCalledExactlyOnceWith(f.claim, providerError.outcome, providerError.code, NOW);
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.exchange).toHaveBeenCalledOnce();
    expect(f.telemetry).toHaveBeenCalledWith(expect.objectContaining({
      outcome: providerError.outcome, code: providerError.code, operationId: OPERATION_ID, attemptId: ATTEMPT_ID, retrySafe: false,
    }));
  });

  it("treats an unclassified provider error as unknown without exposing provider diagnostics", async () => {
    const f = fixture(); f.exchange.mockRejectedValue(new Error(`provider body ${TOKEN.accessToken} ${CODE}`));
    const error = await safeRejection(f.service.callback(f.callbackInput));
    expect(error.outcome).toBe("exchange_unknown");
    expect(f.repository.fail).toHaveBeenCalledWith(f.claim, "exchange_unknown", expect.stringMatching(/^SHOPIFY_OAUTH_/), NOW);
    expect(f.repository.complete).not.toHaveBeenCalled();
  });

  it("blocks saving when configuration changes during the provider exchange", async () => {
    const f = fixture();
    f.exchange.mockImplementation(async () => {
      f.readConfig.mockReturnValue(parseShopifyStaffOAuthConfig({ SHOPIFY_API_KEY: "new-client", SHOPIFY_API_SECRET: "new-private-secret" }));
      return TOKEN;
    });
    const error = await safeRejection(f.service.callback(f.callbackInput));
    expect(error.outcome).toBe("exchange_unknown");
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.fail).toHaveBeenCalledWith(f.claim, "exchange_unknown", expect.stringMatching(/^SHOPIFY_OAUTH_/), NOW);
    expect(f.exchange).toHaveBeenCalledOnce();
  });

  it("recovers a committed result after a lost completion acknowledgement without exchanging or failing it again", async () => {
    const f = fixture();
    f.repository.complete.mockRejectedValue(new Error("private-database-error: COMMIT acknowledgement lost"));
    const persisted = { ...f.connected, replayed: true };
    f.repository.outcome.mockResolvedValue(persisted);
    expect(await f.service.callback(f.callbackInput)).toEqual(persisted);
    expect(f.repository.outcome).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ACTOR_ID, sessionHash: hash(SESSION_ID), stateHash: hash(STATE), attemptId: ATTEMPT_ID, configFingerprint: CONFIG.fingerprint,
    }));
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.exchange).toHaveBeenCalledOnce();
    expect(f.repository.complete).toHaveBeenCalledOnce();
  });

  it.each(["failed", "superseded"] as const)("preserves a durable %s result found after completion uncertainty", async status => {
    const f = fixture(); f.repository.complete.mockRejectedValue(new Error("private-database-error"));
    const persisted = { ...f.connected, status, replayed: true };
    f.repository.outcome.mockResolvedValue(persisted);
    expect(await f.service.callback(f.callbackInput)).toEqual(persisted);
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.exchange).toHaveBeenCalledOnce();
  });

  it("records an unknown outcome when completion and recovery lookup cannot establish commitment", async () => {
    const f = fixture();
    f.repository.complete.mockRejectedValue(new Error(`private-database-error ${TOKEN.accessToken}`));
    f.repository.outcome.mockRejectedValue(new Error("private-database-error: connection unavailable"));
    const error = await safeRejection(f.service.callback(f.callbackInput));
    expect(error.outcome).toBe("exchange_unknown");
    expect(f.repository.fail).toHaveBeenCalledExactlyOnceWith(f.claim, "exchange_unknown", expect.stringMatching(/^SHOPIFY_OAUTH_/), NOW);
    expect(f.exchange).toHaveBeenCalledOnce();
  });

  it("returns a safe unknown result if recording a provider failure also fails, keeping the claim fence", async () => {
    const f = fixture();
    f.exchange.mockRejectedValue(new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXCHANGE_UNKNOWN", 502, "exchange_unknown"));
    f.repository.fail.mockRejectedValue(new Error(`private-database-error ${SECRET}`));
    const error = await safeRejection(f.service.callback(f.callbackInput));
    expect(error.outcome).toBe("exchange_unknown");
    expect(error.httpStatus).toBe(503);
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.exchange).toHaveBeenCalledOnce();
  });

  it("sanitizes a claim storage failure before provider dispatch", async () => {
    const f = fixture(); f.repository.claim.mockRejectedValue(new Error(`private-database-error ${SECRET}`));
    await safeRejection(f.service.callback(f.callbackInput));
    expect(f.exchange).not.toHaveBeenCalled();
    expect(f.repository.complete).not.toHaveBeenCalled();
    expect(f.repository.fail).not.toHaveBeenCalled();
  });

  it("sanitizes a configuration-read failure without claiming or dispatching", async () => {
    const f = fixture(); f.readConfig.mockImplementation(() => { throw new Error(`config ${SECRET}`); });
    await safeRejection(f.service.callback(f.callbackInput));
    expect(f.repository.claim).not.toHaveBeenCalled();
    expect(f.exchange).not.toHaveBeenCalled();
  });

  it("does not let telemetry failure undo a successful connection or trigger failure/re-exchange", async () => {
    const f = fixture(); f.telemetry.mockImplementation(() => { throw new Error("telemetry unavailable"); });
    expect(await f.service.callback(f.callbackInput)).toEqual(f.connected);
    expect(f.repository.complete).toHaveBeenCalledOnce();
    expect(f.repository.fail).not.toHaveBeenCalled();
    expect(f.exchange).toHaveBeenCalledOnce();
  });

  it("emits correlated lifecycle evidence without raw nonce, session, authorization code, token or client secret", async () => {
    const f = fixture();
    await f.service.callback(f.callbackInput);
    const output = JSON.stringify(f.telemetry.mock.calls);
    for (const secret of [STATE, SESSION_ID, CODE, SECRET, TOKEN.accessToken]) expect(output).not.toContain(secret);
    expect(f.telemetry).toHaveBeenCalledWith(expect.objectContaining({
      timestamp: NOW.toISOString(), module: "channels", operationId: OPERATION_ID, attemptId: ATTEMPT_ID,
      durationMs: 0, outcome: "connected", retrySafe: false,
    }));
  });
});
