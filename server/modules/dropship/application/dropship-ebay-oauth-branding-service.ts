import { createHash } from "crypto";
import { z } from "zod";
import { DropshipError } from "../domain/errors";
import type {
  DropshipClock,
  DropshipLogEvent,
  DropshipLogger,
} from "./dropship-ports";

export const DROPSHIP_EBAY_BRANDING_USE_CASE =
  "dropship_vendor_store_oauth" as const;
const EBAY_APPLICATION_KEYS_URL = "https://developer.ebay.com/my/keys";
const EBAY_RUNAME_DOCUMENTATION_URL =
  "https://developer.ebay.com/develop/guides/sell/authorization#configuring-the-runame-value";
const DEFAULT_DROPSHIP_CUSTOMER_FACING_APP_NAME = "Card Shellz .ops";
const MAX_CUSTOMER_FACING_APP_NAME_LENGTH = 200;

const brandingProviderStatusSchema = z.enum([
  "not_saved",
  "pending_external_update",
  "manually_verified",
  "provider_applied",
  "provider_failed",
]);

const ebayOAuthBrandingConfigurationSchema = z.object({
  platform: z.literal("ebay"),
  useCase: z.literal(DROPSHIP_EBAY_BRANDING_USE_CASE),
  environment: z.enum(["sandbox", "production"]),
  status: z.enum(["ready", "attention_required", "blocked"]),
  suggestedDisplayTitle: z.string().min(1),
  message: z.string().min(1),
  customerFacingAppName: z.object({
    value: z.string().min(1),
    source: z.enum(["default", "saved"]),
    revision: z.number().int().nonnegative(),
    providerStatus: brandingProviderStatusSchema,
    providerResourceChanged: z.boolean(),
    updatedAt: z.date().nullable(),
    updatedBy: z.string().nullable(),
  }),
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

const customerFacingAppNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_CUSTOMER_FACING_APP_NAME_LENGTH)
  .refine((value) => !containsControlCharacter(value), {
    message: "Customer-facing app name cannot contain control characters.",
  });

const commandActorSchema = z
  .object({
    actorType: z.enum(["admin", "system"]),
    actorId: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

const requestCustomerFacingAppNameSchema = z
  .object({
    customerFacingAppName: customerFacingAppNameSchema,
    expectedRevision: z.number().int().nonnegative(),
    idempotencyKey: z.string().trim().min(8).max(200),
    actor: commandActorSchema,
  })
  .strict();

const confirmCustomerFacingAppNameSchema = z
  .object({
    expectedRevision: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(8).max(200),
    actor: commandActorSchema,
  })
  .strict();

export type DropshipEbayOAuthBrandingConfiguration = z.infer<
  typeof ebayOAuthBrandingConfigurationSchema
>;

export type DropshipEbayBrandingProviderStatus = z.infer<
  typeof brandingProviderStatusSchema
>;

export interface DropshipEbayOAuthBrandingRevision {
  id: number;
  platform: "ebay";
  useCase: typeof DROPSHIP_EBAY_BRANDING_USE_CASE;
  environment: "sandbox" | "production";
  revision: number;
  customerFacingAppName: string;
  providerResourceFingerprint: string | null;
  providerStatus: Exclude<DropshipEbayBrandingProviderStatus, "not_saved">;
  action:
    | "name_requested"
    | "external_update_verified"
    | "provider_update_applied"
    | "provider_update_failed";
  actorType: "admin" | "system";
  actorId: string | null;
  createdAt: Date;
}

export interface DropshipEbayOAuthBrandingCommandContext {
  environment: "sandbox" | "production";
  providerResourceFingerprint: string | null;
  expectedRevision: number;
  idempotencyKey: string;
  requestHash: string;
  actor: {
    actorType: "admin" | "system";
    actorId?: string;
  };
  now: Date;
}

export interface DropshipEbayOAuthBrandingRepository {
  loadCurrent(input: {
    environment: "sandbox" | "production";
  }): Promise<DropshipEbayOAuthBrandingRevision | null>;
  requestCustomerFacingAppName(
    input: DropshipEbayOAuthBrandingCommandContext & {
      customerFacingAppName: string;
    },
  ): Promise<{
    revision: DropshipEbayOAuthBrandingRevision;
    idempotentReplay: boolean;
  }>;
  confirmExternalUpdate(
    input: DropshipEbayOAuthBrandingCommandContext,
  ): Promise<{
    revision: DropshipEbayOAuthBrandingRevision;
    idempotentReplay: boolean;
  }>;
}

export interface DropshipEbayOAuthBrandingMutationResult {
  configuration: DropshipEbayOAuthBrandingConfiguration;
  idempotentReplay: boolean;
}

export class DropshipEbayOAuthBrandingService {
  constructor(
    private readonly deps: {
      env: NodeJS.ProcessEnv;
      repository: DropshipEbayOAuthBrandingRepository;
      clock: DropshipClock;
      logger: DropshipLogger;
    },
  ) {}

  async getConfiguration(): Promise<DropshipEbayOAuthBrandingConfiguration> {
    const environment = resolveEbayEnvironment(this.deps.env);
    const revision = await this.deps.repository.loadCurrent({ environment });
    return buildDropshipEbayOAuthBrandingConfiguration(
      this.deps.env,
      revision,
    );
  }

  async requestCustomerFacingAppName(
    input: unknown,
  ): Promise<DropshipEbayOAuthBrandingMutationResult> {
    const parsed = requestCustomerFacingAppNameSchema.parse(input);
    const environment = resolveEbayEnvironment(this.deps.env);
    const providerResourceFingerprint =
      fingerprintEbayProviderResource(this.deps.env);
    const normalized = {
      customerFacingAppName: parsed.customerFacingAppName.trim(),
      expectedRevision: parsed.expectedRevision,
      environment,
      providerResourceFingerprint,
    };
    const result = await this.deps.repository.requestCustomerFacingAppName({
      ...normalized,
      idempotencyKey: parsed.idempotencyKey.trim(),
      requestHash: hashEbayOAuthBrandingCommand(
        "dropship_ebay_customer_facing_app_name_requested",
        normalized,
      ),
      actor: parsed.actor,
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_EBAY_BRANDING_REQUEST_REPLAYED"
        : "DROPSHIP_EBAY_BRANDING_REQUESTED",
      message: result.idempotentReplay
        ? "eBay customer-facing app name request was replayed by idempotency key."
        : "eBay customer-facing app name request was saved; provider action remains required.",
      context: {
        revision: result.revision.revision,
        providerStatus: result.revision.providerStatus,
        idempotentReplay: result.idempotentReplay,
      },
    });
    return {
      configuration: buildDropshipEbayOAuthBrandingConfiguration(
        this.deps.env,
        result.revision,
      ),
      idempotentReplay: result.idempotentReplay,
    };
  }

  async confirmExternalUpdate(
    input: unknown,
  ): Promise<DropshipEbayOAuthBrandingMutationResult> {
    const parsed = confirmCustomerFacingAppNameSchema.parse(input);
    if (
      firstConfiguredEnv(this.deps.env, ["EBAY_VENDOR_RUNAME", "EBAY_RUNAME"]) !==
      "EBAY_VENDOR_RUNAME"
    ) {
      throw new DropshipError(
        "DROPSHIP_EBAY_OAUTH_BRANDING_DEDICATED_RUNAME_REQUIRED",
        "A dedicated eBay RuName is required before this customer-facing app name can be marked verified.",
      );
    }
    const environment = resolveEbayEnvironment(this.deps.env);
    const providerResourceFingerprint =
      fingerprintEbayProviderResource(this.deps.env);
    if (!providerResourceFingerprint) {
      throw new DropshipError(
        "DROPSHIP_EBAY_OAUTH_BRANDING_CONFIGURATION_REQUIRED",
        "The dedicated eBay OAuth client and RuName must be configured before this customer-facing app name can be marked verified.",
      );
    }
    const normalized = {
      expectedRevision: parsed.expectedRevision,
      environment,
      providerResourceFingerprint,
    };
    const result = await this.deps.repository.confirmExternalUpdate({
      ...normalized,
      idempotencyKey: parsed.idempotencyKey.trim(),
      requestHash: hashEbayOAuthBrandingCommand(
        "dropship_ebay_customer_facing_app_name_verified",
        normalized,
      ),
      actor: parsed.actor,
      now: this.deps.clock.now(),
    });
    this.deps.logger.info({
      code: result.idempotentReplay
        ? "DROPSHIP_EBAY_BRANDING_VERIFICATION_REPLAYED"
        : "DROPSHIP_EBAY_BRANDING_MANUALLY_VERIFIED",
      message: result.idempotentReplay
        ? "eBay customer-facing app name verification was replayed by idempotency key."
        : "An administrator confirmed the eBay customer-facing app name after external provider update.",
      context: {
        revision: result.revision.revision,
        providerStatus: result.revision.providerStatus,
        idempotentReplay: result.idempotentReplay,
      },
    });
    return {
      configuration: buildDropshipEbayOAuthBrandingConfiguration(
        this.deps.env,
        result.revision,
      ),
      idempotentReplay: result.idempotentReplay,
    };
  }
}

export function buildDropshipEbayOAuthBrandingConfiguration(
  env: NodeJS.ProcessEnv,
  revision: DropshipEbayOAuthBrandingRevision | null = null,
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
  const providerResourceFingerprint =
    clientId && ruName ? fingerprintProviderResource(clientId, ruName) : null;
  const providerResourceChanged = Boolean(
    revision &&
      revision.providerResourceFingerprint !== providerResourceFingerprint,
  );
  const effectiveProviderStatus =
    revision &&
    providerResourceChanged &&
    revision.providerStatus !== "pending_external_update"
      ? "pending_external_update"
      : (revision?.providerStatus ?? "not_saved");

  const status = !requiredConfigurationPresent
    ? "blocked"
    : dedicatedRuName
      ? "ready"
      : "attention_required";

  const message = !requiredConfigurationPresent
    ? "The .ops eBay OAuth configuration is incomplete. Configure the missing deployment values before vendors connect stores."
    : dedicatedRuName
      ? "The .ops connection flow uses a dedicated RuName."
      : "The .ops connection flow is using the shared Echelon RuName. Create a dedicated RuName and configure EBAY_VENDOR_RUNAME before changing its provider-managed title.";

  return ebayOAuthBrandingConfigurationSchema.parse({
    platform: "ebay",
    useCase: DROPSHIP_EBAY_BRANDING_USE_CASE,
    environment: resolveEbayEnvironment(env),
    status,
    suggestedDisplayTitle:
      revision?.customerFacingAppName ??
      DEFAULT_DROPSHIP_CUSTOMER_FACING_APP_NAME,
    message,
    customerFacingAppName: {
      value:
        revision?.customerFacingAppName ??
        DEFAULT_DROPSHIP_CUSTOMER_FACING_APP_NAME,
      source: revision ? "saved" : "default",
      revision: revision?.revision ?? 0,
      providerStatus: effectiveProviderStatus,
      providerResourceChanged,
      updatedAt: revision?.createdAt ?? null,
      updatedBy: revision?.actorId ?? null,
    },
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

export function ebayOAuthBrandingValidationError(
  error: unknown,
): DropshipError | null {
  if (error instanceof z.ZodError) {
    return new DropshipError(
      "DROPSHIP_EBAY_OAUTH_BRANDING_INVALID_INPUT",
      "eBay connection-branding input failed validation.",
      { issues: error.issues },
    );
  }
  return null;
}

export function hashEbayOAuthBrandingCommand(
  commandType: string,
  payload: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ commandType, payload: sortJsonValue(payload) }))
    .digest("hex");
}

export const systemDropshipEbayOAuthBrandingClock: DropshipClock = {
  now: () => new Date(),
};

export function makeDropshipEbayOAuthBrandingLogger(): DropshipLogger {
  return {
    info: (event) => logBrandingEvent("info", event),
    warn: (event) => logBrandingEvent("warn", event),
    error: (event) => logBrandingEvent("error", event),
  };
}

function resolveEbayEnvironment(
  env: NodeJS.ProcessEnv,
): "sandbox" | "production" {
  return env.EBAY_ENVIRONMENT === "sandbox" ? "sandbox" : "production";
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

function fingerprintEbayProviderResource(
  env: NodeJS.ProcessEnv,
): string | null {
  const clientIdSource = firstConfiguredEnv(env, [
    "DROPSHIP_EBAY_CLIENT_ID",
    "EBAY_CLIENT_ID",
  ]);
  const ruNameSource = firstConfiguredEnv(env, [
    "EBAY_VENDOR_RUNAME",
    "EBAY_RUNAME",
  ]);
  const clientId = valueForSource(env, clientIdSource);
  const ruName = valueForSource(env, ruNameSource);
  return clientId && ruName ? fingerprintProviderResource(clientId, ruName) : null;
}

function fingerprintProviderResource(clientId: string, ruName: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ clientId, ruName }))
    .digest("hex");
}

function sortJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((sorted, key) => {
        sorted[key] = sortJsonValue((value as Record<string, unknown>)[key]);
        return sorted;
      }, {});
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.charCodeAt(0);
    return codePoint <= 31 || codePoint === 127;
  });
}

function logBrandingEvent(
  level: "info" | "warn" | "error",
  event: DropshipLogEvent,
): void {
  const payload = JSON.stringify({
    code: event.code,
    message: event.message,
    context: event.context ?? {},
  });
  if (level === "error") {
    console.error(payload);
    return;
  }
  if (level === "warn") {
    console.warn(payload);
    return;
  }
  console.info(payload);
}
