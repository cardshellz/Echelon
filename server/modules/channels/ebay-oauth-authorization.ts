import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { IChannelStorage } from "./channels.storage";

const AUTHORIZATION_WINDOW_MS = 10 * 60 * 1000;
const stateSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/), actorId: z.string().min(1),
  channelId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), environment: z.enum(["sandbox", "production"]),
  expiresAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type EbayOAuthAuthorization = z.infer<typeof stateSchema>;

export class EbayOAuthAuthorizationError extends Error {
  readonly code = "EBAY_OAUTH_STATE_INVALID";
}

export function createEbayOAuthAuthorization(input: {
  nonce: string; actorId: string; channelId: number; environment: "sandbox" | "production"; now: number;
}): { state: string; authorization: EbayOAuthAuthorization } {
  if (!/^[a-f0-9]{64}$/.test(input.nonce) || !Number.isSafeInteger(input.now) || input.now < 0) throw new EbayOAuthAuthorizationError("Invalid authorization challenge input.");
  const state = `echelon-${input.nonce}`;
  return { state, authorization: stateSchema.parse({
    digest: createHash("sha256").update(state).digest("hex"), actorId: input.actorId,
    channelId: input.channelId, environment: input.environment, expiresAt: input.now + AUTHORIZATION_WINDOW_MS,
  }) };
}

export function verifyEbayOAuthAuthorization(input: {
  state: unknown; authorization: unknown; actorId: string; environment: "sandbox" | "production"; now: number;
}): EbayOAuthAuthorization {
  const parsed = stateSchema.safeParse(input.authorization);
  if (!parsed.success || typeof input.state !== "string" || !/^echelon-[a-f0-9]{64}$/.test(input.state)
    || !Number.isSafeInteger(input.now) || input.now < 0 || input.now >= parsed.data.expiresAt
    || parsed.data.actorId !== input.actorId || parsed.data.environment !== input.environment) {
    throw new EbayOAuthAuthorizationError("This authorization link is missing, expired or belongs to another session. Return to eBay Connection settings and reconnect.");
  }
  const actual = createHash("sha256").update(input.state).digest();
  if (!timingSafeEqual(actual, Buffer.from(parsed.data.digest, "hex"))) throw new EbayOAuthAuthorizationError("This authorization response does not match the connection request. Return to eBay Connection settings and reconnect.");
  return parsed.data;
}

/** Resolve the internal owner before redirect; callback input never chooses a channel. */
export async function resolveEbayOAuthChannel(storage: Pick<IChannelStorage, "getAllChannels" | "getChannelById">, requestedId?: number): Promise<number> {
  if (requestedId !== undefined) {
    if (!Number.isSafeInteger(requestedId) || requestedId < 1) throw new EbayOAuthAuthorizationError("Select a valid eBay channel before connecting.");
    const channel = await storage.getChannelById(requestedId);
    if (!channel || channel.provider !== "ebay") throw new EbayOAuthAuthorizationError("The selected channel is not an eBay channel. Open the intended channel's Connection settings.");
    return channel.id;
  }
  const channels = (await storage.getAllChannels()).filter((channel) => channel.provider === "ebay");
  if (channels.length !== 1) throw new EbayOAuthAuthorizationError("Open the intended eBay channel's Connection settings before connecting an account.");
  return channels[0].id;
}
