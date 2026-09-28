import { z } from "zod";
import {
  customerReturnPolicyShippingInputSchema,
  returnPolicyShippingCatalogSchema,
} from "@shared/returns/return-policy-shipping.contract";
import { customerReturnLabelSettingsSchema } from "@shared/returns/customer-return-label.contract";
import { normalizeCustomerReturnCarrierRules } from "@shared/returns/customer-return-carrier-policy";
import {
  parseReturnLabelSettingsDraft,
  type ReturnLabelSettingsDraft,
} from "./customer-return-label-settings";

export const RETURN_POLICIES_PATH = "/return-policies";
const id = z.number().int().positive().safe();
export interface ReturnPolicyScopeContext {
  dropshipOmsChannelId: number;
}

/** Store policies persist the canonical Dropship channel; public commands scope them by vendor/store only. */
export function returnPolicyDraftChannelId(
  appliesTo: "all_orders" | "channel" | "vendor" | "store",
  channelId: number | null,
): number | null {
  return appliesTo === "channel" ? id.parse(channelId) : null;
}

export function returnPolicyEditorPath(policyId: number): string {
  return `${RETURN_POLICIES_PATH}?policyId=${id.parse(policyId)}&section=shipping`;
}

export function legacyReturnPolicyPath(search: string): string {
  const parameters = new URLSearchParams(search);
  const values = parameters.getAll("channelId");
  if (values.length === 0) return RETURN_POLICIES_PATH;
  if (
    values.length !== 1 ||
    !/^[1-9]\d*$/.test(values[0]) ||
    !id.safeParse(Number(values[0])).success
  ) {
    return `${RETURN_POLICIES_PATH}?invalidLegacyLink=1`;
  }
  return `${RETURN_POLICIES_PATH}?channelId=${values[0]}&section=shipping`;
}

export function requestedReturnPolicyChannel(search: string): number | null {
  const parameters = new URLSearchParams(search);
  const values = parameters.getAll("channelId");
  if (parameters.has("invalidLegacyLink"))
    throw new Error(
      "The saved shipping link is invalid. Choose an active policy below.",
    );
  if (values.length === 0) return null;
  if (
    values.length !== 1 ||
    parameters.has("policyId") ||
    !/^[1-9]\d*$/.test(values[0]) ||
    !id.safeParse(Number(values[0])).success
  ) {
    throw new Error(
      "The saved shipping link is invalid. Choose an active policy below.",
    );
  }
  return Number(values[0]);
}

/** Links identify an exact policy; they never choose authority or create a version. */
export function requestedReturnPolicy(
  search: string,
): { policyId: number; shipping: boolean } | null {
  const parameters = new URLSearchParams(search);
  const values = parameters.getAll("policyId");
  if (values.length === 0) return null;
  const sections = parameters.getAll("section");
  if (
    values.length !== 1 ||
    parameters.has("channelId") ||
    !/^[1-9]\d*$/.test(values[0]) ||
    !id.safeParse(Number(values[0])).success ||
    sections.length > 1 ||
    (sections.length === 1 && sections[0] !== "shipping")
  ) {
    throw new Error(
      "This link does not identify a return policy. Choose an active policy below.",
    );
  }
  return { policyId: Number(values[0]), shipping: sections[0] === "shipping" };
}

export function parsePolicyShippingDraft(draft: ReturnLabelSettingsDraft) {
  const parsed = parseReturnLabelSettingsDraft(draft, 0);
  if (!parsed.success) return parsed;
  const { expectedVersion: _version, ...shipping } = parsed.data;
  return customerReturnPolicyShippingInputSchema.safeParse(shipping);
}

export async function loadReturnPolicyShippingCatalog(
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const response = await request(
    "/api/returns/admin/policies/shipping-catalog",
    {
      credentials: "include",
      cache: "no-store",
      signal,
    },
  );
  if (!response.ok)
    throw new Error(
      response.status === 401 || response.status === 403
        ? "Administrator access is required to configure return shipping."
        : "Return shipping choices could not be loaded. Refresh before saving.",
    );
  const value = returnPolicyShippingCatalogSchema.parse(await response.json());
  if (
    new Set(value.warehouses.map((warehouse) => warehouse.id)).size !==
      value.warehouses.length ||
    new Set(value.carriers.map((carrier) => carrier.id)).size !==
      value.carriers.length ||
    value.carriers.some(
      (carrier) =>
        new Set(carrier.services.map((service) => service.code)).size !==
        carrier.services.length,
    )
  ) {
    throw new Error(
      "Return shipping choices could not be verified. Refresh before saving.",
    );
  }
  return value;
}

export const returnPolicySaveResponseSchema = z
  .object({
    policy: z
      .object({
        id,
        version: id,
        status: z.literal("active"),
        shipping: customerReturnLabelSettingsSchema.nullable(),
      })
      .passthrough(),
    replayed: z.boolean(),
  })
  .passthrough()
  .superRefine((result, context) => {
    if (
      result.policy.shipping &&
      (result.policy.shipping.policyId !== result.policy.id ||
        result.policy.shipping.version !== result.policy.id)
    ) {
      context.addIssue({
        code: "custom",
        path: ["policy", "shipping"],
        message: "Shipping must belong to the returned policy version.",
      });
    }
  });

export const returnPolicyVersionCommandSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    appliesTo: z.enum(["all_orders", "channel", "vendor", "store"]),
    channelId: id.nullable(),
    vendorId: id.nullable(),
    storeConnectionId: id.nullable(),
    expectedPolicyId: id.nullable(),
    returnWindowDays: z.number().int().min(0).max(3650),
    returnDestination: z.enum(["card_shellz", "vendor", "marketplace"]),
    approvalAuthority: z.enum(["card_shellz", "marketplace", "vendor"]),
    labelProvider: z.enum(["shipstation", "marketplace", "vendor", "none"]),
    returnShippingPayer: z.enum([
      "card_shellz",
      "vendor",
      "customer",
      "marketplace",
      "carrier",
    ]),
    inspectionRequirement: z.enum(["required", "conditional", "none"]),
    inspectionOwner: z.enum(["card_shellz", "vendor", "marketplace"]),
    customerRefundAuthority: z.enum(["card_shellz", "marketplace", "vendor"]),
    vendorSettlementTrigger: z.enum([
      "inspection_approved",
      "customer_refunded",
      "carrier_claim_paid",
      "none",
    ]),
    returnlessRefundAllowed: z.boolean(),
    notes: z
      .string()
      .trim()
      .max(4000)
      .nullable()
      .transform((value) => value || null),
    shipping: customerReturnPolicyShippingInputSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const scopeValid =
      value.appliesTo === "all_orders"
        ? value.channelId === null &&
          value.vendorId === null &&
          value.storeConnectionId === null
        : value.appliesTo === "channel"
          ? value.channelId !== null &&
            value.vendorId === null &&
            value.storeConnectionId === null
          : value.appliesTo === "vendor"
            ? value.channelId === null &&
              value.vendorId !== null &&
              value.storeConnectionId === null
            : value.channelId === null &&
              value.vendorId !== null &&
              value.storeConnectionId !== null;
    if (!scopeValid)
      context.addIssue({
        code: "custom",
        path: ["appliesTo"],
        message: "Choose one complete policy scope.",
      });
    if (
      value.shipping !== null &&
      (value.returnDestination !== "card_shellz" ||
        value.labelProvider !== "shipstation")
    ) {
      context.addIssue({
        code: "custom",
        path: ["shipping"],
        message: "Return shipping requires Card Shellz and ShipStation.",
      });
    }
  });

function matchesSubmittedPolicy(
  policy: z.output<typeof returnPolicySaveResponseSchema>["policy"],
  raw: unknown,
  scopeContext?: ReturnPolicyScopeContext,
): boolean {
  const submitted = returnPolicyVersionCommandSchema.parse(raw);
  const dropshipChannel = id.safeParse(scopeContext?.dropshipOmsChannelId);
  if (!dropshipChannel.success) return false;
  const scopeKinds = {
    all_orders: "global",
    channel: "channel_context",
    vendor: "vendor_context",
    store: "store",
  } as const;
  if (
    policy.scopeKind !== scopeKinds[submitted.appliesTo] ||
    policy.supersedesPolicyId !== submitted.expectedPolicyId
  )
    return false;
  const expectedChannel =
    submitted.appliesTo === "store"
      ? dropshipChannel.data
      : submitted.channelId;
  const expectedContext =
    submitted.appliesTo === "all_orders"
      ? null
      : submitted.appliesTo === "channel"
        ? submitted.channelId === dropshipChannel.data
          ? "dropship"
          : "retail"
        : "dropship";
  if (
    policy.channelId !== expectedChannel ||
    policy.businessContext !== expectedContext
  )
    return false;
  for (const key of [
    "name",
    "vendorId",
    "storeConnectionId",
    "returnWindowDays",
    "returnDestination",
    "approvalAuthority",
    "labelProvider",
    "returnShippingPayer",
    "inspectionRequirement",
    "inspectionOwner",
    "customerRefundAuthority",
    "vendorSettlementTrigger",
    "returnlessRefundAllowed",
    "notes",
  ] as const) {
    if (policy[key] !== submitted[key]) return false;
  }
  if (submitted.shipping === null) return policy.shipping === null;
  if (policy.shipping === null) return false;
  const {
    version: _version,
    policyId: _policyId,
    destinationAddress: _address,
    ...shipping
  } = policy.shipping;
  return (
    JSON.stringify({
      ...shipping,
      carrierRules: normalizeCustomerReturnCarrierRules(shipping.carrierRules),
    }) ===
    JSON.stringify({
      ...submitted.shipping,
      carrierRules: normalizeCustomerReturnCarrierRules(
        submitted.shipping.carrierRules,
      ),
    })
  );
}

export class ReturnPolicySaveError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly definitive: boolean,
  ) {
    super(message);
    this.name = "ReturnPolicySaveError";
  }
}

export async function readReturnPolicySaveResponse(
  response: Response,
  submitted?: unknown,
  scopeContext?: ReturnPolicyScopeContext,
) {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z
      .object({
        error: z.object({
          code: z.string().min(1).max(100),
          message: z.string().min(1).max(1000),
        }),
      })
      .safeParse(body);
    throw new ReturnPolicySaveError(
      error.success ? error.data.error.code : "RETURN_POLICY_SAVE_UNCONFIRMED",
      error.success
        ? error.data.error.message
        : "The save outcome was not confirmed. Retry the same policy command.",
      error.success && [400, 401, 403, 409, 422].includes(response.status),
    );
  }
  const parsed = returnPolicySaveResponseSchema.safeParse(body);
  if (!parsed.success)
    throw new ReturnPolicySaveError(
      "RETURN_POLICY_SAVE_UNCONFIRMED",
      "The save response could not be verified. Retry the same policy command.",
      false,
    );
  if (
    submitted !== undefined &&
    !matchesSubmittedPolicy(parsed.data.policy, submitted, scopeContext)
  )
    throw new ReturnPolicySaveError(
      "RETURN_POLICY_SAVE_UNCONFIRMED",
      "The saved policy could not be matched to your changes. Retry the same policy command.",
      false,
    );
  return parsed.data;
}
