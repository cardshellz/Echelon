import { describe, expect, it, vi } from "vitest";
import { DropshipError } from "../../domain/errors";
import { DropshipEbayTokenOwner } from "../../infrastructure/dropship-ebay-token-owner";
import type {
  DropshipMarketplaceCredentialRepository,
  DropshipMarketplaceStoreCredentials,
} from "../../infrastructure/dropship-marketplace-credentials";

const NOW = new Date("2026-09-06T12:00:00Z");
const REQUEST = { vendorId: 1, storeConnectionId: 2, operation: "unit-test" };

function credential(overrides: Partial<DropshipMarketplaceStoreCredentials> = {}): DropshipMarketplaceStoreCredentials {
  return {
    vendorId: 1, storeConnectionId: 2, platform: "ebay", status: "connected",
    shopDomain: null, externalAccountId: "seller", providerEnvironment: "production",
    externalAccountIdentityScheme: null, externalAccountVerifiedAt: null,
    externalDisplayName: "Store", config: {}, accessToken: "old-access-secret",
    accessTokenRef: "access-generation-1", refreshToken: "refresh-secret",
    refreshTokenRef: "refresh-generation-1", accessTokenExpiresAt: new Date(NOW),
    refreshTokenExpiresAt: null, ...overrides,
  };
}

function response(body: unknown = { access_token: "new-access-secret", expires_in: 7200 }, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function harness(initial: DropshipMarketplaceStoreCredentials = credential()) {
  let current = initial;
  const loadForStoreConnection = vi.fn(async () => current);
  const replaceTokens = vi.fn<DropshipMarketplaceCredentialRepository["replaceTokens"]>(async (input) => {
    current = { ...current, accessToken: input.accessToken, accessTokenRef: "access-generation-2",
      accessTokenExpiresAt: input.accessTokenExpiresAt, refreshToken: input.refreshToken ?? current.refreshToken };
    return current;
  });
  const recordAuthFailure = vi.fn<NonNullable<DropshipMarketplaceCredentialRepository["recordAuthFailure"]>>(async (input) => ({
    vendorId: input.vendorId, storeConnectionId: input.storeConnectionId, platform: input.platform,
    previousStatus: current.status, status: input.status, transitioned: true,
  }));
  const repository: DropshipMarketplaceCredentialRepository = {
    loadForStoreConnection, replaceTokens, recordAuthFailure,
    withEbayTokenRefreshLock: async (_input, operation) => operation(repository),
  };
  const fetchFn = vi.fn<typeof fetch>(async () => response());
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const owner = new DropshipEbayTokenOwner({ credentials: repository, fetchFn,
    clock: { now: () => new Date(NOW) }, logger,
    oauthClient: { clientId: "client-id", clientSecret: "client-secret" },
  });
  return { owner, repository, fetchFn, logger, replaceTokens, recordAuthFailure, loadForStoreConnection,
    setCurrent(value: DropshipMarketplaceStoreCredentials) { current = value; } };
}

describe("shared eBay token owner", () => {
  it("preserves the original grant, fences the write, and keeps an unrotated refresh token", async () => {
    const h = harness();
    const result = await h.owner.loadFreshForStoreConnection(REQUEST);
    expect(result.accessToken).toBe("new-access-secret");
    expect(result.refreshToken).toBe("refresh-secret");
    const [url, init] = h.fetchFn.mock.calls[0];
    expect(url).toBe("https://api.ebay.com/identity/v1/oauth2/token");
    expect(init).toMatchObject({ method: "POST", redirect: "error", signal: expect.any(AbortSignal) });
    expect(new URLSearchParams(String(init?.body)).get("scope")).toBeNull();
    expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("refresh-secret");
    expect(h.replaceTokens).toHaveBeenCalledWith(expect.objectContaining({
      expectedCredential: { accessTokenRef: "access-generation-1", refreshTokenRef: "refresh-generation-1" },
      accessTokenExpiresAt: new Date("2026-09-06T14:00:00Z"), refreshToken: null,
    }));
    expect(JSON.stringify(h.logger.info.mock.calls)).not.toContain("secret");
  });

  it("reuses a fresh token without requiring refresh coordination", async () => {
    const fresh = credential({ accessTokenExpiresAt: new Date("2026-09-06T14:00:00Z") });
    const h = harness(fresh);
    h.repository.withEbayTokenRefreshLock = undefined;
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).resolves.toEqual(fresh);
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("fails closed before HTTP if cross-worker coordination is unavailable", async () => {
    const h = harness();
    h.repository.withEbayTokenRefreshLock = undefined;
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_REFRESH_COORDINATION_REQUIRED" });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("repairs a rejected token even when its recorded expiry is still fresh", async () => {
    const h = harness(credential({ accessTokenExpiresAt: new Date("2026-09-06T14:00:00Z") }));
    await h.owner.loadFreshForStoreConnection({ ...REQUEST, rejectedAccessTokenRef: "access-generation-1" });
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("uses a newer token already installed by another worker after resource rejection", async () => {
    const h = harness(credential({ accessTokenRef: "newer-generation", accessTokenExpiresAt: new Date("2026-09-06T14:00:00Z") }));
    await h.owner.loadFreshForStoreConnection({ ...REQUEST, rejectedAccessTokenRef: "access-generation-1" });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it("rereads inside the lock instead of refreshing a stale pre-lock snapshot", async () => {
    const h = harness();
    h.repository.withEbayTokenRefreshLock = async (_input, operation) => {
      h.setCurrent(credential({ accessTokenRef: "winner", accessTokenExpiresAt: new Date("2026-09-06T14:00:00Z") }));
      return operation(h.repository);
    };
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).resolves.toMatchObject({ accessTokenRef: "winner" });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it.each(["success", "invalid_grant"])("discards stale %s after a newer consent grant", async (outcome) => {
    const h = harness();
    const changed = new DropshipError("DROPSHIP_CREDENTIAL_CHANGED", "Credential changed.", { retryable: true });
    h.fetchFn.mockImplementation(async () => {
      h.setCurrent(credential({ accessTokenRef: "new-consent", refreshTokenRef: "new-grant", accessTokenExpiresAt: new Date("2026-09-06T14:00:00Z") }));
      return outcome === "success" ? response() : response({ error: "invalid_grant" }, 400);
    });
    if (outcome === "success") h.replaceTokens.mockRejectedValue(changed);
    else h.recordAuthFailure.mockRejectedValue(changed);
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).resolves.toMatchObject({ accessTokenRef: "new-consent" });
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not loop or reuse an expired winner following a credential conflict", async () => {
    const h = harness();
    h.replaceTokens.mockImplementation(async () => {
      h.setCurrent(credential({ accessTokenRef: "expired-winner" }));
      throw new DropshipError("DROPSHIP_CREDENTIAL_CHANGED", "Credential changed.", { retryable: true });
    });
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).rejects.toMatchObject({ code: "DROPSHIP_CREDENTIAL_CHANGED" });
    expect(h.fetchFn).toHaveBeenCalledTimes(1);
  });

  it("does not resurrect a disconnected store after an in-flight refresh", async () => {
    const h = harness();
    h.replaceTokens.mockImplementation(async () => {
      h.setCurrent(credential({ status: "disconnected" }));
      throw new DropshipError("DROPSHIP_CREDENTIAL_CHANGED", "Credential changed.");
    });
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED" });
  });

  it.each(["paused", "needs_reauth", "disconnected", "grace"])("does not refresh a %s connection", async (status) => {
    const h = harness(credential({ status }));
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).rejects.toMatchObject({ code: "DROPSHIP_STORE_CONNECTION_NOT_CONNECTED" });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    { refreshToken: null },
    { refreshTokenExpiresAt: new Date("2026-09-06T11:59:59Z") },
  ])("requires consent only for a missing or expired refresh grant", async (overrides) => {
    const h = harness(credential(overrides));
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_REFRESH_TOKEN_REQUIRED" });
    expect(h.recordAuthFailure).toHaveBeenCalledWith(expect.objectContaining({ status: "needs_reauth",
      expectedCredential: { accessTokenRef: "access-generation-1", refreshTokenRef: "refresh-generation-1" } }));
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it.each([
    [400, "invalid_grant", "needs_reauth", false],
    [400, "invalid_scope", "refresh_failed", false],
    [401, "invalid_client", "refresh_failed", false],
    [429, "temporarily_unavailable", "refresh_failed", true],
    [503, "invalid_grant", "refresh_failed", true],
  ] as const)("classifies HTTP %i %s without erasing a recoverable grant", async (status, error, expectedStatus, retryable) => {
    const h = harness();
    h.fetchFn.mockResolvedValue(response({ error, error_description: "echoed-refresh-secret" }, status));
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).rejects.toMatchObject({
      code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", context: { authFailureStatus: expectedStatus, retryable },
    });
    expect(h.recordAuthFailure).toHaveBeenCalledWith(expect.objectContaining({ status: expectedStatus,
      providerErrorDescription: null,
      expectedCredential: { accessTokenRef: "access-generation-1", refreshTokenRef: "refresh-generation-1" } }));
    expect(h.replaceTokens).not.toHaveBeenCalled();
    expect(JSON.stringify(h.recordAuthFailure.mock.calls)).not.toContain("echoed-refresh-secret");
  });

  it("preserves the grant and sanitizes a failed transport", async () => {
    const h = harness();
    h.fetchFn.mockRejectedValue(new Error("secret-client-id secret-refresh-token"));
    let failure: unknown;
    try { await h.owner.loadFreshForStoreConnection(REQUEST); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "DROPSHIP_EBAY_TOKEN_REFRESH_FAILED", context: { retryable: true } });
    expect(JSON.stringify(failure)).not.toContain("secret-");
    expect(h.recordAuthFailure).not.toHaveBeenCalled();
    expect(h.replaceTokens).not.toHaveBeenCalled();
  });

  it.each([null, [], {}, { access_token: "token", expires_in: 0 }, { access_token: "token", expires_in: 1.5 },
    { access_token: "token", expires_in: Number.MAX_SAFE_INTEGER }, { access_token: "token", expires_in: 7200, refresh_token: 42 },
  ])("rejects malformed token responses without writing credentials: %j", async (body) => {
    const h = harness();
    h.fetchFn.mockResolvedValue(response(body));
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE" });
    expect(h.replaceTokens).not.toHaveBeenCalled();
    expect(h.recordAuthFailure).not.toHaveBeenCalled();
  });

  it("bounds response memory and rejects invalid JSON without exposing body text", async () => {
    for (const body of ["secret-invalid-json", "x".repeat(65 * 1024)]) {
      const h = harness();
      h.fetchFn.mockResolvedValue(new Response(body));
      await expect(h.owner.loadFreshForStoreConnection(REQUEST)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_TOKEN_REFRESH_INVALID_RESPONSE" });
      expect(h.replaceTokens).not.toHaveBeenCalled();
    }
  });

  it("checks the returned credential owner before sending any secret", async () => {
    const h = harness(credential({ vendorId: 99 }));
    await expect(h.owner.loadFreshForStoreConnection(REQUEST)).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CREDENTIAL_OWNER_MISMATCH" });
    expect(h.fetchFn).not.toHaveBeenCalled();
  });

  it.each([{ vendorId: 0 }, { storeConnectionId: -1 }, { operation: "raw message with spaces" }, { rejectedAccessTokenRef: "" }])(
    "rejects invalid caller input before any repository access: %j", async (overrides) => {
      const h = harness();
      await expect(h.owner.loadFreshForStoreConnection({ ...REQUEST, ...overrides })).rejects.toMatchObject({ code: "DROPSHIP_EBAY_CREDENTIAL_REQUEST_INVALID" });
      expect(h.loadForStoreConnection).not.toHaveBeenCalled();
    });
});
