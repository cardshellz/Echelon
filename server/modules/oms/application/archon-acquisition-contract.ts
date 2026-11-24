// Archon-owned inbound contract snapshot: cardshellz/archon f819c6a.
// Copied from shared/source-attribution.ts and shared/storefront-acquisition.ts.
// Keep validation compatible with Archon; channel attribution remains owned by Archon.
import { z } from "zod";

export const sourceKeySchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_-]{0,79}$/);

// A timestamp is mandatory: merely finding a UTM on an order is not evidence
// that the interaction preceded that order or fell inside the reporting window.
export const touchInputSchema = z
  .object({
    occurredAt: z.string().datetime({ offset: true }),
    source: z.string().trim().min(1).max(160).optional(),
    medium: z.string().trim().max(100).optional(),
    campaignId: z.string().trim().max(160).optional(),
    campaignName: z.string().trim().max(160).optional(),
    landingUrl: z.string().url().max(2048).optional(),
    referrer: z.string().url().max(2048).optional(),
    partnerKey: sourceKeySchema.optional(),
    linkId: sourceKeySchema.optional(),
  })
  .strict()
  .refine(
    (v) => v.source || v.landingUrl,
    "A source or landing URL is required.",
  )
  .superRefine((value, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    const parseUrl = (raw: string | undefined) => {
      if (!raw) return null;
      try {
        const url = new URL(raw);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password
        ) {
          issue("Use an HTTP or HTTPS tracking URL without credentials.");
          return null;
        }
        return url;
      } catch {
        issue("Invalid tracking URL.");
        return null;
      }
    };
    const url = parseUrl(value.landingUrl),
      referrer = parseUrl(value.referrer);
    const google = ["gclid", "gbraid", "wbraid"].some(
        (p) => !!url?.searchParams.get(p),
      ),
      applovin = !!url?.searchParams.get("aleid");
    if (google && applovin)
      issue("The interaction contains conflicting provider click identifiers.");
    const source =
      value.source ??
      url?.searchParams.get("utm_source") ??
      referrer?.hostname ??
      "";
    if ((!source.trim() && !google && !applovin) || source.trim().length > 160)
      issue("The interaction needs a valid source.");
    for (const [explicit, param, max] of [
      [value.medium, "utm_medium", 100],
      [value.campaignId, "utm_id", 160],
      [value.campaignName, "utm_campaign", 160],
    ] as const) {
      if ((explicit ?? url?.searchParams.get(param) ?? "").trim().length > max)
        issue("A tracking field is too long.");
    }
    for (const [explicit, param] of [
      [value.partnerKey, "archon_partner"],
      [value.linkId, "archon_link"],
    ] as const) {
      const field = explicit ?? url?.searchParams.get(param);
      if (field && !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(field))
        issue("Invalid stable tracking identifier.");
    }
  });

/** Upstream analytics must not prevent delivery of an otherwise valid financial order.
 * The sender must log the structured failure; never forward invalid customer-controlled attributes. */
export function readStorefrontAcquisition(
  rawPayload: unknown,
):
  | { status: "valid"; touches: z.infer<typeof touchInputSchema>[] }
  | { status: "invalid"; code: "INVALID_MARKETING_ATTRIBUTION"; touches: [] } {
  try {
    return {
      status: "valid",
      touches: extractStorefrontAcquisition(rawPayload),
    };
  } catch {
    return {
      status: "invalid",
      code: "INVALID_MARKETING_ATTRIBUTION",
      touches: [],
    };
  }
}
/** Echelon adapter contract: accepts only the dedicated cart/order attribute, not arbitrary raw URLs. */
export function extractStorefrontAcquisition(
  rawPayload: unknown,
): z.infer<typeof touchInputSchema>[] {
  const payload = z
    .object({
      note_attributes: z
        .array(z.object({ name: z.string(), value: z.unknown() }))
        .optional(),
      marketing_attribution: z.unknown().optional(),
    })
    .passthrough()
    .parse(rawPayload);
  if (payload.marketing_attribution !== undefined)
    return z
      .array(touchInputSchema)
      .max(20)
      .parse(payload.marketing_attribution);
  const attrs = (payload.note_attributes ?? []).filter((a) =>
    ["archon_acquisition_v1", "__archon_acquisition_v1"].includes(a.name),
  );
  if (!attrs.length) return [];
  if (
    attrs.length !== 1 ||
    typeof attrs[0].value !== "string" ||
    attrs[0].value.length > 20000
  )
    throw new RangeError("Invalid acquisition order attribute.");
  if (attrs[0].value.trim() === "") return [];
  return z.array(touchInputSchema).max(20).parse(JSON.parse(attrs[0].value));
}
