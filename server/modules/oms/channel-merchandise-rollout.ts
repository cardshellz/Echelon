import { z } from "zod";

const channelId = z.coerce.number().int().positive().max(2_147_483_647);

/** Explicitly scoped activation. Merely deploying additive schema cannot resume orders. */
export function channelMerchandiseAuthorityChannels(
  environment: Record<string, string | undefined> = process.env,
): readonly number[] {
  const enabled = environment.OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED;
  if (enabled === undefined || enabled === "false") return [];
  if (enabled !== "true")
    throw new Error(
      "OMS_CHANNEL_MERCHANDISE_AUTHORITY_ENABLED must be true or false.",
    );
  const raw = environment.OMS_CHANNEL_MERCHANDISE_CHANNEL_IDS;
  if (!raw?.trim())
    throw new Error(
      "Channel merchandise authority requires an explicit channel allowlist.",
    );
  return [
    ...new Set(raw.split(",").map((value) => channelId.parse(value.trim()))),
  ];
}

export function channelMerchandiseAuthorityEnabled(channel: number): boolean {
  const allowed = channelMerchandiseAuthorityChannels();
  return allowed.length > 0 && allowed.includes(channelId.parse(channel));
}
