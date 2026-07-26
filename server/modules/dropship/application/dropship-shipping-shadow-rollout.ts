import { z } from "zod";

const shadowModeSchema = z.enum(["off", "test", "all"]);

export interface DropshipShippingShadowRolloutPolicy {
  mode: z.infer<typeof shadowModeSchema>;
  storeConnectionIds: ReadonlySet<number>;
}

export interface DropshipShippingShadowRolloutConfig {
  policy: DropshipShippingShadowRolloutPolicy;
  configurationError: string | null;
}

export function readDropshipShippingShadowRolloutConfig(
  env: NodeJS.ProcessEnv = process.env,
): DropshipShippingShadowRolloutConfig {
  const parsedMode = shadowModeSchema.safeParse(
    env.DROPSHIP_SHARED_SHIPPING_SHADOW_MODE?.trim().toLowerCase() || "off",
  );
  if (!parsedMode.success) {
    return disabledWithError(
      "DROPSHIP_SHARED_SHIPPING_SHADOW_MODE must be off, test, or all.",
    );
  }

  const parsedIds = parsePositiveIdList(
    env.DROPSHIP_SHARED_SHIPPING_SHADOW_STORE_CONNECTION_IDS,
  );
  if (!parsedIds.ok) {
    return disabledWithError(parsedIds.message);
  }
  if (parsedMode.data === "test" && parsedIds.ids.size === 0) {
    return disabledWithError(
      "Test shadow mode requires at least one store connection ID.",
    );
  }

  return {
    policy: {
      mode: parsedMode.data,
      storeConnectionIds: parsedIds.ids,
    },
    configurationError: null,
  };
}

export function shouldShadowDropshipShippingQuote(
  policy: DropshipShippingShadowRolloutPolicy,
  storeConnectionId: number | null,
): boolean {
  if (policy.mode === "off") return false;
  if (policy.mode === "all") return true;
  return storeConnectionId !== null
    && policy.storeConnectionIds.has(storeConnectionId);
}

function parsePositiveIdList(
  raw: string | undefined,
): { ok: true; ids: Set<number> } | { ok: false; message: string } {
  const ids = new Set<number>();
  if (!raw?.trim()) return { ok: true, ids };

  for (const token of raw.split(",")) {
    const normalized = token.trim();
    const id = Number(normalized);
    if (!/^[1-9]\d*$/.test(normalized) || !Number.isSafeInteger(id)) {
      return {
        ok: false,
        message:
          "DROPSHIP_SHARED_SHIPPING_SHADOW_STORE_CONNECTION_IDS must contain only positive integer IDs.",
      };
    }
    ids.add(id);
  }
  return { ok: true, ids };
}

function disabledWithError(
  configurationError: string,
): DropshipShippingShadowRolloutConfig {
  return {
    policy: {
      mode: "off",
      storeConnectionIds: new Set(),
    },
    configurationError,
  };
}
