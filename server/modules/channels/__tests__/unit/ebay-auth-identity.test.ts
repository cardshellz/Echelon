import { auditEvents } from "@shared/schema";
import { describe, expect, it, vi } from "vitest";

import {
  EbayAuthService,
  EbayProviderAccountIdentityConflictError,
  type EbayObservedProviderAccount,
} from "../../adapters/ebay/ebay-auth.service";

const fixedNow = new Date("2026-08-04T16:00:00.000Z");
const claimAuditContext = {
  idempotencyKey: "registration-claim-1",
  observationHash: "a".repeat(64),
  requestedBy: { type: "user" as const, id: "user-1" },
  correlationId: "correlation-1",
};

const config = {
  clientId: "client",
  clientSecret: "secret",
  ruName: "redirect-name",
  environment: "production" as const,
};

interface TokenRow {
  channelId: number;
  environment: "sandbox" | "production";
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date | null;
  externalAccountId: string | null;
  externalAccountDisplayName: string | null;
  externalAccountIdentityScheme: string | null;
  externalAccountVerifiedAt: Date | null;
  [key: string]: unknown;
}

function tokenRow(overrides: Partial<TokenRow> = {}): TokenRow {
  return {
    channelId: 67,
    environment: "production",
    accessToken: "old-access",
    accessTokenExpiresAt: new Date("2026-08-04T15:00:00.000Z"),
    refreshToken: "old-refresh",
    refreshTokenExpiresAt: null,
    externalAccountId: null,
    externalAccountDisplayName: null,
    externalAccountIdentityScheme: null,
    externalAccountVerifiedAt: null,
    ...overrides,
  };
}

function mockDb(
  initial: TokenRow | null,
  options: { failAudit?: boolean } = {},
) {
  let row = initial;
  const inserted: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const auditRows: Record<string, unknown>[] = [];
  const selection = () => {
    const rows = row ? [row] : [];
    return Object.assign(Promise.resolve(rows), {
      for: async () => rows,
    });
  };
  const db: Record<string, any> = {};
  db.select = vi.fn(() => ({
    from: () => ({
      where: () => ({ limit: selection }),
    }),
  }));
  db.insert = vi.fn((table: unknown) => ({
    values: async (values: Record<string, unknown>) => {
      if (table === auditEvents) {
        if (options.failAudit) throw new Error("audit insert failed");
        auditRows.push(values);
        return;
      }
      inserted.push(values);
      row = values as TokenRow;
    },
  }));
  db.update = vi.fn(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        updates.push(values);
        row = row ? ({ ...row, ...values } as TokenRow) : row;
        return {
          returning: async () => row
            ? [{
                externalAccountId: row.externalAccountId,
                externalAccountDisplayName: row.externalAccountDisplayName,
                externalAccountVerifiedAt: row.externalAccountVerifiedAt,
              }]
            : [],
        };
      },
    }),
  }));
  db.delete = vi.fn();
  db.transaction = vi.fn(async (callback: (tx: typeof db) => Promise<unknown>) => {
    const rowBefore = row ? { ...row } : null;
    const updateCountBefore = updates.length;
    const auditCountBefore = auditRows.length;
    try {
      return await callback(db);
    } catch (error) {
      row = rowBefore;
      updates.length = updateCountBefore;
      auditRows.length = auditCountBefore;
      throw error;
    }
  });
  return { db, inserted, updates, auditRows, getRow: () => row };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function observedAccount(
  externalAccountId: string,
  displayName: string | null,
  verifiedAt: Date = fixedNow,
): EbayObservedProviderAccount {
  return {
    externalAccountId,
    externalAccountDisplayName: displayName,
    externalAccountIdentityScheme: "provider_user_id",
    externalAccountVerifiedAt: verifiedAt,
  };
}

describe("EbayAuthService provider account identity", () => {
  it("requires immutable Identity API userId before persisting exchanged tokens", async () => {
    const state = mockDb(null);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "new-access",
        expires_in: 7_200,
        refresh_token: "new-refresh",
        refresh_token_expires_in: 31_536_000,
      }))
      .mockResolvedValueOnce(jsonResponse({
        userId: "immutable-user-1",
        username: "display-name",
      }));
    const service = new EbayAuthService(state.db as any, config, {
      fetch: fetchFn,
      now: () => fixedNow,
    });

    await service.exchangeAuthorizationCode(67, "authorization-code");

    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "https://apiz.ebay.com/commerce/identity/v1/user/",
      expect.objectContaining({ method: "GET" }),
    );
    expect(state.inserted).toHaveLength(1);
    expect(state.inserted[0]).toMatchObject({
      externalAccountId: "immutable-user-1",
      externalAccountDisplayName: "display-name",
      externalAccountIdentityScheme: "provider_user_id",
      externalAccountVerifiedAt: fixedNow,
    });
  });

  it("does not persist authorization tokens when Identity API omits userId", async () => {
    const state = mockDb(null);
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "new-access",
        expires_in: 7_200,
        refresh_token: "new-refresh",
      }))
      .mockResolvedValueOnce(jsonResponse({ username: "mutable-only" }));
    const service = new EbayAuthService(state.db as any, config, {
      fetch: fetchFn,
      now: () => fixedNow,
    });

    await expect(
      service.exchangeAuthorizationCode(67, "authorization-code"),
    ).rejects.toThrow("valid immutable userId");
    expect(state.inserted).toHaveLength(0);
    expect(state.updates).toHaveLength(0);
  });

  it("rejects reauthorization when the newly observed immutable account differs", async () => {
    const state = mockDb(tokenRow({
      externalAccountId: "immutable-user-1",
      externalAccountDisplayName: "old-name",
      externalAccountIdentityScheme: "provider_user_id",
    }));
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({
        access_token: "new-access",
        expires_in: 7_200,
        refresh_token: "new-refresh",
      }))
      .mockResolvedValueOnce(jsonResponse({
        userId: "immutable-user-2",
        username: "other-account",
      }));
    const service = new EbayAuthService(state.db as any, config, {
      fetch: fetchFn,
      now: () => fixedNow,
    });

    await expect(
      service.exchangeAuthorizationCode(67, "authorization-code"),
    ).rejects.toBeInstanceOf(EbayProviderAccountIdentityConflictError);
    expect(state.updates).toHaveLength(0);
    expect(state.getRow()?.accessToken).toBe("old-access");
  });

  it("refreshes tokens without clearing or rewriting stable account identity", async () => {
    const state = mockDb(tokenRow({
      externalAccountId: "immutable-user-1",
      externalAccountDisplayName: "display-name",
      externalAccountIdentityScheme: "provider_user_id",
      externalAccountVerifiedAt: new Date("2026-08-03T00:00:00.000Z"),
    }));
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(jsonResponse({
      access_token: "refreshed-access",
      expires_in: 7_200,
      refresh_token: "rotated-refresh",
    }));
    const service = new EbayAuthService(state.db as any, config, {
      fetch: fetchFn,
      now: () => fixedNow,
    });

    await expect(service.getAccessToken(67)).resolves.toBe("refreshed-access");
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]).not.toHaveProperty("externalAccountId");
    expect(state.getRow()).toMatchObject({
      externalAccountId: "immutable-user-1",
      externalAccountDisplayName: "display-name",
      externalAccountIdentityScheme: "provider_user_id",
    });
  });

  it("claims a legacy null identity and replays the same account after username change", async () => {
    const state = mockDb(tokenRow());
    const service = new EbayAuthService(state.db as any, config, {
      fetch: vi.fn(),
      now: () => fixedNow,
    });

    await expect(
      service.claimObservedProviderAccount(
        67,
        observedAccount("immutable-user-1", "old-name"),
        claimAuditContext,
      ),
    ).resolves.toMatchObject({
      kind: "claimed",
      account: {
        externalAccountId: "immutable-user-1",
        externalAccountDisplayName: "old-name",
      },
    });
    await expect(
      service.claimObservedProviderAccount(
        67,
        observedAccount("immutable-user-1", "renamed-account"),
        claimAuditContext,
      ),
    ).resolves.toMatchObject({
      kind: "replay",
      account: {
        externalAccountId: "immutable-user-1",
        externalAccountDisplayName: "renamed-account",
      },
    });
    expect(state.auditRows).toHaveLength(2);
    expect(state.auditRows[1]).toMatchObject({
      actor: "user:user-1",
      action: "channels.ebay.provider_account_identity_claimed",
      target: "channel:67",
      context: expect.objectContaining({
        idempotencyKey: "registration-claim-1",
        observationHash: "a".repeat(64),
        correlationId: "correlation-1",
      }),
    });
  });

  it("refreshes matching durable identity evidence to the observation time", async () => {
    const oldVerifiedAt = new Date("2026-08-03T00:00:00.000Z");
    const confirmationObservedAt = new Date("2026-08-05T00:00:00.000Z");
    const state = mockDb(tokenRow({
      externalAccountId: "immutable-user-1",
      externalAccountDisplayName: "old-name",
      externalAccountIdentityScheme: "provider_user_id",
      externalAccountVerifiedAt: oldVerifiedAt,
    }));
    const service = new EbayAuthService(state.db as any, config, {
      fetch: vi.fn(),
      now: () => fixedNow,
    });

    await expect(service.claimObservedProviderAccount(
      67,
      observedAccount(
        "immutable-user-1",
        "renamed-account",
        confirmationObservedAt,
      ),
      claimAuditContext,
    )).resolves.toMatchObject({
      kind: "replay",
      account: {
        externalAccountId: "immutable-user-1",
        externalAccountVerifiedAt: confirmationObservedAt,
      },
    });
    expect(state.getRow()?.externalAccountVerifiedAt).toEqual(
      confirmationObservedAt,
    );
  });

  it("rolls back the identity refresh when its durable audit insert fails", async () => {
    const state = mockDb(tokenRow(), { failAudit: true });
    const service = new EbayAuthService(state.db as any, config, {
      fetch: vi.fn(),
      now: () => fixedNow,
    });

    await expect(service.claimObservedProviderAccount(
      67,
      observedAccount("immutable-user-1", "display-name"),
      claimAuditContext,
    )).rejects.toThrow("audit insert failed");
    expect(state.getRow()?.externalAccountId).toBeNull();
    expect(state.auditRows).toHaveLength(0);
  });

  it("rejects a different account during durable claim", async () => {
    const state = mockDb(tokenRow({
      externalAccountId: "immutable-user-1",
      externalAccountIdentityScheme: "provider_user_id",
    }));
    const service = new EbayAuthService(state.db as any, config, {
      fetch: vi.fn(),
      now: () => fixedNow,
    });

    await expect(
      service.claimObservedProviderAccount(
        67,
        observedAccount("immutable-user-2", "other-account"),
        claimAuditContext,
      ),
    ).rejects.toBeInstanceOf(EbayProviderAccountIdentityConflictError);
    expect(state.updates).toHaveLength(0);
  });
});
