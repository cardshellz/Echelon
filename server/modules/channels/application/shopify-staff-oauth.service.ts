import { randomBytes, randomUUID } from "node:crypto";
import {
  AUTHORIZATION_WINDOW_MS, hashShopifyOAuthValue, parseAndVerifyShopifyStaffOAuthCallback,
} from "../domain/shopify-staff-oauth";
import {
  ShopifyStaffOAuthError, type ShopifyStaffOAuthClaim, type ShopifyStaffOAuthClaimInput,
  type ShopifyStaffOAuthConfig, type ShopifyStaffOAuthRepository, type ShopifyStaffOAuthResult,
  type ShopifyStaffOAuthToken,
} from "../shopify-staff-oauth.types";

export interface ShopifyStaffOAuthTelemetry {
  timestamp: string;
  module: "channels";
  action: "shopify_oauth.begin" | "shopify_oauth.callback";
  outcome: string;
  durationMs: number;
  actorId: string;
  operationId?: string;
  attemptId?: string;
  channelId?: number;
  connectionId?: number;
  code?: string;
  retrySafe: boolean;
}
interface ActorInput { actorId: string; sessionId: string }
export interface ShopifyStaffOAuthDependencies {
  repository: ShopifyStaffOAuthRepository;
  readConfig: () => ShopifyStaffOAuthConfig;
  exchange: (config: ShopifyStaffOAuthConfig, code: string) => Promise<ShopifyStaffOAuthToken>;
  now?: () => Date;
  nonce?: () => string;
  uuid?: () => string;
  telemetry?: (event: ShopifyStaffOAuthTelemetry) => void;
}

function actor(input: ActorInput) {
  if (typeof input.actorId !== "string" || !input.actorId.trim() || input.actorId.length > 255
    || typeof input.sessionId !== "string" || !input.sessionId || input.sessionId.length > 4096) {
    throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_AUTHENTICATION_REQUIRED", 401);
  }
  return { actorId: input.actorId, sessionHash: hashShopifyOAuthValue(input.sessionId) };
}

/** One application owner. No request retry repeats a claimed provider exchange. */
export function createShopifyStaffOAuthService(deps: ShopifyStaffOAuthDependencies) {
  const now = deps.now ?? (() => new Date());
  const uuid = deps.uuid ?? randomUUID;
  const nonce = deps.nonce ?? (() => randomBytes(32).toString("hex"));

  function emit(start: Date, event: Omit<ShopifyStaffOAuthTelemetry, "timestamp" | "module" | "durationMs">) {
    // Telemetry is diagnostic. Durable audit is committed with each mutation by
    // the repository; a logging sink failure cannot undo that committed action.
    try {
      const end = now();
      deps.telemetry?.({ ...event, timestamp: end.toISOString(), module: "channels",
        durationMs: Math.max(0, end.getTime() - start.getTime()) });
    } catch { /* The durable command/audit outcome remains authoritative. */ }
  }

  async function recordFailure(claim: ShopifyStaffOAuthClaim, status: "failed" | "exchange_unknown", code: string) {
    try { await deps.repository.fail(claim, status, code, now()); }
    catch {
      // The claimed row is still the durable fence: do not retry the exchange.
      throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_OUTCOME_UNRECORDED", 503, "exchange_unknown", claim.operationId);
    }
  }

  const commands = {
    async begin(input: ActorInput & { channelId?: number }) {
      const start = now();
      const identity = actor(input);
      const config = deps.readConfig();
      if (input.channelId !== undefined && (!Number.isSafeInteger(input.channelId) || input.channelId <= 0)) {
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CHANNEL_INVALID");
      }
      const secret = nonce();
      if (!/^[a-f0-9]{64}$/.test(secret)) throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_NONCE_INVALID", 503);
      const state = `echelon-shopify-${secret}`;
      const binding = await deps.repository.create({
        ...identity, operationId: uuid(), stateHash: hashShopifyOAuthValue(state),
        configFingerprint: config.fingerprint, shopDomain: config.shopDomain,
        requestedChannelId: input.channelId, now: start, expiresAt: new Date(start.getTime() + AUTHORIZATION_WINDOW_MS),
      });
      const url = new URL(`https://${config.shopDomain}/admin/oauth/authorize`);
      url.search = new URLSearchParams({ client_id: config.clientId, scope: config.scopes.join(","),
        redirect_uri: config.redirectUri, state }).toString();
      emit(start, { action: "shopify_oauth.begin", outcome: "issued", actorId: identity.actorId,
        operationId: binding.operationId, channelId: binding.channelId, connectionId: binding.connectionId,
        retrySafe: false });
      return { authorizationUrl: url.toString(), operationId: binding.operationId, channelId: binding.channelId,
        connectionId: binding.connectionId, expiresAt: binding.expiresAt };
    },

    async callback(input: ActorInput & { rawQuery: string }): Promise<ShopifyStaffOAuthResult> {
      const start = now();
      const identity = actor(input);
      const config = deps.readConfig();
      // Validate signature, shop and state format before a database claim, and
      // certainly before any credential-bearing provider request.
      const verified = parseAndVerifyShopifyStaffOAuthCallback(input.rawQuery, config, start);
      const claimInput: ShopifyStaffOAuthClaimInput = { ...identity, stateHash: verified.stateHash,
        configFingerprint: config.fingerprint, shopDomain: verified.shopDomain, attemptId: uuid(), now: start };
      const claimed = await deps.repository.claim(claimInput);
      if (claimed.kind === "result") {
        emit(start, { action: "shopify_oauth.callback", outcome: claimed.result.status, actorId: identity.actorId,
          operationId: claimed.result.operationId, channelId: claimed.result.channelId,
          connectionId: claimed.result.connectionId, code: claimed.result.code, retrySafe: false });
        return claimed.result;
      }
      const claim = claimed.claim;
      const context = { action: "shopify_oauth.callback" as const, actorId: identity.actorId,
        operationId: claim.operationId, attemptId: claim.attemptId, channelId: claim.channelId,
        connectionId: claim.connectionId, retrySafe: false };
      // A transaction may have waited for a lock. Recheck the live clock before
      // dispatch rather than treating the pre-lock timestamp as fresh authority.
      if (now().getTime() >= claim.expiresAt.getTime()) {
        await recordFailure(claim, "failed", "SHOPIFY_OAUTH_AUTHORIZATION_EXPIRED");
        emit(start, { ...context, outcome: "failed", code: "SHOPIFY_OAUTH_AUTHORIZATION_EXPIRED" });
        throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_AUTHORIZATION_EXPIRED", 403, "failed", claim.operationId);
      }
      let token: ShopifyStaffOAuthToken;
      try {
        token = await deps.exchange(config, verified.code);
      } catch (error) {
        const safe = error instanceof ShopifyStaffOAuthError ? error
          : new ShopifyStaffOAuthError("SHOPIFY_OAUTH_EXCHANGE_UNKNOWN", 502, "exchange_unknown");
        await recordFailure(claim, safe.outcome, safe.code);
        emit(start, { ...context, outcome: safe.outcome, code: safe.code });
        throw new ShopifyStaffOAuthError(safe.code, safe.httpStatus, safe.outcome, claim.operationId);
      }
      try {
        // A changed app identity cannot complete a challenge issued under its
        // previous credentials. Identity and connection are rechecked in the TX.
        if (deps.readConfig().fingerprint !== config.fingerprint) {
          throw new ShopifyStaffOAuthError("SHOPIFY_OAUTH_CONFIG_CHANGED", 409, "exchange_unknown");
        }
        const completed = await deps.repository.complete(claim, token, now());
        emit(start, { ...context, outcome: completed.status, code: completed.code });
        return completed;
      } catch (error) {
        // A lost COMMIT acknowledgement is not proof of rollback. Read the
        // durable outcome before recording failure; never exchange the code again.
        try {
          const persisted = await deps.repository.outcome({ ...claimInput, now: now() });
          if (persisted && persisted.status !== "in_progress") {
            emit(start, { ...context, outcome: persisted.status, code: persisted.code });
            return persisted;
          }
        } catch { /* Continue to a fenced unknown outcome, never to a retry. */ }
        const code = error instanceof ShopifyStaffOAuthError ? error.code : "SHOPIFY_OAUTH_PERSISTENCE_UNKNOWN";
        await recordFailure(claim, "exchange_unknown", code);
        emit(start, { ...context, outcome: "exchange_unknown", code });
        throw new ShopifyStaffOAuthError(code, 503, "exchange_unknown", claim.operationId);
      }
    },
  };
  async function guarded<T>(action: ShopifyStaffOAuthTelemetry["action"], input: ActorInput, work: () => Promise<T>): Promise<T> {
    const start = now();
    try { return await work(); }
    catch (error) {
      const safe = error instanceof ShopifyStaffOAuthError ? error
        : new ShopifyStaffOAuthError("SHOPIFY_OAUTH_UNAVAILABLE", 503, "exchange_unknown");
      emit(start, { action, actorId: typeof input.actorId === "string" ? input.actorId.slice(0, 255) : "unknown",
        operationId: safe.operationId, outcome: safe.outcome, code: safe.code, retrySafe: false });
      throw safe;
    }
  }
  return {
    begin: (input: ActorInput & { channelId?: number }) => guarded("shopify_oauth.begin", input, () => commands.begin(input)),
    callback: (input: ActorInput & { rawQuery: string }) => guarded("shopify_oauth.callback", input, () => commands.callback(input)),
  };
}
export type ShopifyStaffOAuthService = ReturnType<typeof createShopifyStaffOAuthService>;
