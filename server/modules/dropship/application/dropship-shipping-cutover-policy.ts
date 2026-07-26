import { z } from "zod";

const cutoverModeSchema = z.enum(["legacy", "test", "live"]);

export interface DropshipShippingCutoverPolicy {
  mode: z.infer<typeof cutoverModeSchema>;
  storeConnectionIds: ReadonlySet<number>;
}

export interface DropshipShippingCutoverConfig {
  policy: DropshipShippingCutoverPolicy;
  configurationError: string | null;
}

export type DropshipShippingCutoverDecision =
  | {
      source: "legacy";
      mode: "legacy" | "test";
      reasonCode:
        | "LEGACY_MODE"
        | "TEST_STORE_NOT_ALLOWED";
    }
  | {
      source: "shared";
      mode: "test" | "live";
      reasonCode:
        | "TEST_STORE_ALLOWED"
        | "LIVE_ENABLED";
    };

export function readDropshipShippingCutoverConfig(
  env: NodeJS.ProcessEnv = process.env,
): DropshipShippingCutoverConfig {
  const parsedMode = cutoverModeSchema.safeParse(
    env.DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE?.trim().toLowerCase()
      || "legacy",
  );
  if (!parsedMode.success) {
    return legacyWithError(
      "DROPSHIP_SHARED_SHIPPING_CUTOVER_MODE must be legacy, test, or live.",
    );
  }

  const parsedIds = parsePositiveIdList(
    env.DROPSHIP_SHARED_SHIPPING_CUTOVER_STORE_CONNECTION_IDS,
  );
  if (!parsedIds.ok) {
    return legacyWithError(parsedIds.message);
  }
  if (parsedMode.data === "test" && parsedIds.ids.size === 0) {
    return legacyWithError(
      "Test cutover mode requires at least one store connection ID.",
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

export function resolveDropshipShippingCutover(
  policy: DropshipShippingCutoverPolicy,
  storeConnectionId: number,
): DropshipShippingCutoverDecision {
  if (policy.mode === "legacy") {
    return {
      source: "legacy",
      mode: policy.mode,
      reasonCode: "LEGACY_MODE",
    };
  }
  if (policy.mode === "live") {
    return {
      source: "shared",
      mode: policy.mode,
      reasonCode: "LIVE_ENABLED",
    };
  }
  if (policy.storeConnectionIds.has(storeConnectionId)) {
    return {
      source: "shared",
      mode: policy.mode,
      reasonCode: "TEST_STORE_ALLOWED",
    };
  }
  return {
    source: "legacy",
    mode: policy.mode,
    reasonCode: "TEST_STORE_NOT_ALLOWED",
  };
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
          "DROPSHIP_SHARED_SHIPPING_CUTOVER_STORE_CONNECTION_IDS must contain only positive integer IDs.",
      };
    }
    ids.add(id);
  }
  return { ok: true, ids };
}

function legacyWithError(
  configurationError: string,
): DropshipShippingCutoverConfig {
  return {
    policy: {
      mode: "legacy",
      storeConnectionIds: new Set(),
    },
    configurationError,
  };
}
