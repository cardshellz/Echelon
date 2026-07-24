import type {
  ShippingChannelPolicyPurpose,
} from "@shared/types/shipping-channel-routing";
import {
  resolveLegacyChannelShippingFallback,
  resolveChannelShippingDecision,
  type ChannelShippingDecision,
  type ChannelShippingPolicyCandidate,
  type ChannelShippingPolicyResolutionInput,
  type LegacyChannelShippingFallback,
} from "../domain/channel-shipping-policy";

export interface RuntimeShippingChannel {
  id: number;
  provider: string;
  status: string;
  isDefault: number;
}

export interface ChannelShippingPolicyRuntimeStore {
  getChannel(channelId: number): Promise<RuntimeShippingChannel | null>;
  loadActivePolicies(
    channelId: number,
    purpose: ShippingChannelPolicyPurpose,
  ): Promise<ChannelShippingPolicyCandidate[]>;
}

export interface ResolveRuntimeChannelShippingInput
  extends Omit<ChannelShippingPolicyResolutionInput, "channelId"> {
  provider: string;
  configuredChannelId?: string | null;
  legacyFallback: LegacyChannelShippingFallback | null;
}

export type RuntimeChannelShippingResolution =
  | {
      ok: true;
      channel: RuntimeShippingChannel | null;
      decision: Extract<ChannelShippingDecision, { ok: true }>;
    }
  | {
      ok: false;
      code:
        | "INVALID_CHANNEL_CONFIGURATION"
        | "CHANNEL_NOT_FOUND"
        | "CHANNEL_PROVIDER_MISMATCH"
        | "CHANNEL_NOT_ACTIVE"
        | "CHANNEL_BINDING_NOT_CONFIGURED"
        | Extract<ChannelShippingDecision, { ok: false }>["code"];
      message: string;
      channel: RuntimeShippingChannel | null;
      decision: Extract<ChannelShippingDecision, { ok: false }> | null;
    };

/**
 * Resolve one channel's runtime shipping authority. Callback credentials
 * belong to a concrete channel, so canonical policies require an explicit
 * channel binding. An unbound callback may use the supplied legacy fallback
 * during compatibility rollout; invalid or stale explicit bindings fail closed.
 */
export async function resolveRuntimeChannelShipping(
  store: ChannelShippingPolicyRuntimeStore,
  input: ResolveRuntimeChannelShippingInput,
): Promise<RuntimeChannelShippingResolution> {
  const provider = input.provider.trim().toLowerCase();
  if (provider === "") {
    return failure(
      "INVALID_CHANNEL_CONFIGURATION",
      "shipping channel provider is required",
    );
  }

  const configuredChannelId = parseConfiguredChannelId(
    input.configuredChannelId,
  );
  if (!configuredChannelId.ok) {
    return failure(
      "INVALID_CHANNEL_CONFIGURATION",
      configuredChannelId.message,
    );
  }

  if (configuredChannelId.channelId === null) {
    if (input.legacyFallback === null) {
      return failure(
        "CHANNEL_BINDING_NOT_CONFIGURED",
        "shipping callback channel binding is not configured",
      );
    }
    const decision = resolveLegacyChannelShippingFallback(
      {
        purpose: input.purpose,
        originWarehouseId: input.originWarehouseId,
        destination: input.destination,
      },
      input.legacyFallback,
    );
    if (!decision.ok) {
      return {
        ok: false,
        code: decision.code,
        message: decision.message,
        channel: null,
        decision,
      };
    }
    return { ok: true, channel: null, decision };
  }

  const channelResult = await resolveConfiguredChannel(
    store,
    configuredChannelId.channelId,
    provider,
  );
  if (!channelResult.ok) return channelResult;

  const channel = channelResult.channel;
  const resolutionInput: ChannelShippingPolicyResolutionInput = {
    channelId: channel.id,
    purpose: input.purpose,
    originWarehouseId: input.originWarehouseId,
    destination: input.destination,
  };
  const policies = await store.loadActivePolicies(
    channel.id,
    input.purpose,
  );
  const decision = resolveChannelShippingDecision(
    policies,
    resolutionInput,
    input.legacyFallback,
  );
  if (!decision.ok) {
    return {
      ok: false,
      code: decision.code,
      message: decision.message,
      channel,
      decision,
    };
  }

  return { ok: true, channel, decision };
}

function parseConfiguredChannelId(
  raw: string | null | undefined,
):
  | { ok: true; channelId: number | null }
  | { ok: false; message: string } {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { ok: true, channelId: null };
  }
  const normalized = raw.trim();
  const channelId = Number(normalized);
  if (
    !/^[1-9]\d*$/.test(normalized)
    || !Number.isSafeInteger(channelId)
  ) {
    return {
      ok: false,
      message:
        "configured shipping callback channel ID must be a positive integer",
    };
  }
  return { ok: true, channelId };
}

async function resolveConfiguredChannel(
  store: ChannelShippingPolicyRuntimeStore,
  channelId: number,
  provider: string,
):
  Promise<
    | { ok: true; channel: RuntimeShippingChannel }
    | Extract<RuntimeChannelShippingResolution, { ok: false }>
  > {
  const channel = await store.getChannel(channelId);
  if (!channel) {
    return failure(
      "CHANNEL_NOT_FOUND",
      `configured shipping callback channel ${channelId} does not exist`,
    );
  }
  const actualProvider = channel.provider.trim().toLowerCase();
  if (actualProvider !== provider) {
    return failure(
      "CHANNEL_PROVIDER_MISMATCH",
      `configured channel ${channel.id} uses provider "${actualProvider}", expected "${provider}"`,
      channel,
    );
  }
  if (channel.status !== "active") {
    return failure(
      "CHANNEL_NOT_ACTIVE",
      `configured channel ${channel.id} is ${channel.status}, not active`,
      channel,
    );
  }
  return { ok: true, channel };
}

function failure(
  code: Extract<RuntimeChannelShippingResolution, { ok: false }>["code"],
  message: string,
  channel: RuntimeShippingChannel | null = null,
): Extract<RuntimeChannelShippingResolution, { ok: false }> {
  return { ok: false, code, message, channel, decision: null };
}
