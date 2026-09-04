import { z } from "zod";

const ebayOAuthBrandingConfigurationSchema = z.object({
  platform: z.literal("ebay"),
  useCase: z.literal("dropship_vendor_store_oauth"),
  environment: z.enum(["sandbox", "production"]),
  status: z.enum(["ready", "attention_required", "blocked"]),
  suggestedDisplayTitle: z.string().min(1),
  message: z.string().min(1),
  clientId: z.object({
    source: z.string().min(1).nullable(),
    fingerprint: z.string().min(1).nullable(),
    dedicated: z.boolean(),
  }),
  clientSecret: z.object({
    source: z.string().min(1).nullable(),
    configured: z.boolean(),
    dedicated: z.boolean(),
  }),
  ruName: z.object({
    source: z.string().min(1).nullable(),
    value: z.string().min(1).nullable(),
    dedicated: z.boolean(),
  }),
  management: z.object({
    mode: z.literal("external_provider_portal"),
    displayTitleReadableByApi: z.literal(false),
    displayTitleWritableByApi: z.literal(false),
    portalUrl: z.string().url(),
    documentationUrl: z.string().url(),
  }),
});

export type DropshipEbayOAuthBrandingConfiguration = z.infer<
  typeof ebayOAuthBrandingConfigurationSchema
>;

const EBAY_APPLICATION_KEYS_URL = "https://developer.ebay.com/my/keys";
const EBAY_RUNAME_DOCUMENTATION_URL =
  "https://developer.ebay.com/develop/guides/sell/authorization#configuring-the-runame-value";
const SUGGESTED_DROPSHIP_DISPLAY_TITLE = "Card Shellz .ops";

export class DropshipEbayOAuthBrandingService {
  constructor(private readonly env: NodeJS.ProcessEnv) {}

  getConfiguration(): DropshipEbayOAuthBrandingConfiguration {
    return buildDropshipEbayOAuthBrandingConfiguration(this.env);
  }
}

export function buildDropshipEbayOAuthBrandingConfiguration(
  env: NodeJS.ProcessEnv,
): DropshipEbayOAuthBrandingConfiguration {
  const clientIdSource = firstConfiguredEnv(env, [
    "DROPSHIP_EBAY_CLIENT_ID",
    "EBAY_CLIENT_ID",
  ]);
  const clientSecretSource = firstConfiguredEnv(env, [
    "DROPSHIP_EBAY_CLIENT_SECRET",
    "EBAY_CLIENT_SECRET",
  ]);
  const ruNameSource = firstConfiguredEnv(env, [
    "EBAY_VENDOR_RUNAME",
    "EBAY_RUNAME",
  ]);
  const clientId = valueForSource(env, clientIdSource);
  const ruName = valueForSource(env, ruNameSource);
  const requiredConfigurationPresent = Boolean(
    clientIdSource && clientSecretSource && ruNameSource,
  );
  const dedicatedRuName = ruNameSource === "EBAY_VENDOR_RUNAME";

  const status = !requiredConfigurationPresent
    ? "blocked"
    : dedicatedRuName
      ? "ready"
      : "attention_required";

  const message = !requiredConfigurationPresent
    ? "The .ops eBay OAuth configuration is incomplete. Configure the missing deployment values before vendors connect stores."
    : dedicatedRuName
      ? "The .ops connection flow uses a dedicated RuName. Manage that RuName's consent-screen Display Title in eBay."
      : "The .ops connection flow is using the shared Echelon RuName. Do not rename it; create a dedicated RuName and configure EBAY_VENDOR_RUNAME first.";

  return ebayOAuthBrandingConfigurationSchema.parse({
    platform: "ebay",
    useCase: "dropship_vendor_store_oauth",
    environment: env.EBAY_ENVIRONMENT === "sandbox" ? "sandbox" : "production",
    status,
    suggestedDisplayTitle: SUGGESTED_DROPSHIP_DISPLAY_TITLE,
    message,
    clientId: {
      source: clientIdSource,
      fingerprint: fingerprintClientId(clientId),
      dedicated: clientIdSource === "DROPSHIP_EBAY_CLIENT_ID",
    },
    clientSecret: {
      source: clientSecretSource,
      configured: Boolean(clientSecretSource),
      dedicated: clientSecretSource === "DROPSHIP_EBAY_CLIENT_SECRET",
    },
    ruName: {
      source: ruNameSource,
      value: ruName,
      dedicated: dedicatedRuName,
    },
    management: {
      mode: "external_provider_portal",
      displayTitleReadableByApi: false,
      displayTitleWritableByApi: false,
      portalUrl: EBAY_APPLICATION_KEYS_URL,
      documentationUrl: EBAY_RUNAME_DOCUMENTATION_URL,
    },
  });
}

function firstConfiguredEnv(
  env: NodeJS.ProcessEnv,
  keys: readonly string[],
): string | null {
  return keys.find((key) => Boolean(env[key]?.trim())) ?? null;
}

function valueForSource(
  env: NodeJS.ProcessEnv,
  source: string | null,
): string | null {
  if (!source) return null;
  return env[source]?.trim() || null;
}

function fingerprintClientId(clientId: string | null): string | null {
  if (!clientId) return null;
  if (clientId.length <= 12) return "Configured";
  return `${clientId.slice(0, 6)}...${clientId.slice(-6)}`;
}
