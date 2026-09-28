import type { ReturnPolicy } from "@shared/schema";
import { z } from "zod";
import {
  customerReturnLabelAddressSchema,
  customerReturnLabelSettingsStateSchema,
  customerReturnLabelControlSchema,
  customerReturnLabelControlInputSchema,
  type CustomerReturnLabelSettings,
  type CustomerReturnLabelSettingsState,
} from "@shared/returns/customer-return-label.contract";
import { matchesCustomerReturnPortalPolicy } from "@shared/returns/customer-return-portal-policy";
import { snapshotReturnPolicy } from "../domain/return-case";
import { CustomerReturnIntakeError } from "./customer-return-intake.ports";
import { resolveCustomerReturnPortalPolicy } from "./customer-return-policy";

export interface ReturnLabelWarehouse {
  id: number;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
  isActive: number;
}
export interface CustomerReturnSettingsStore {
  read(channelId: number): Promise<CustomerReturnLabelSettings | null>;
  readAccepted(channelId: number, authorizationId: number): Promise<CustomerReturnLabelSettings | null>;
  readControl(channelId: number): Promise<z.infer<typeof customerReturnLabelControlSchema>>;
  saveControl(channelId: number, input: z.infer<typeof customerReturnLabelControlInputSchema>, actor: string, now: Date): Promise<void>;
  catalog(
    channelId: number,
    includePolicies?: boolean,
  ): Promise<{ warehouses: ReturnLabelWarehouse[]; policies: ReturnPolicy[] }>;

}
export interface ReturnLabelCapabilities {
  configured: boolean;
  carriers: CustomerReturnLabelSettingsState["carriers"];
}
export interface CustomerReturnLabelSettingsDependencies {
  store: CustomerReturnSettingsStore;
  authorizeChannel: (channelId: number) => Promise<void>;
  capabilities: () => Promise<ReturnLabelCapabilities>;
  now: () => Date;
}

/** Policy-owned shipping and independent purchase controls. Outbound defaults
 * never authorize a return warehouse or carrier. */
export class CustomerReturnLabelSettingsService {
  constructor(
    private readonly dependencies: CustomerReturnLabelSettingsDependencies,
  ) {}

  async get(channelId: number): Promise<CustomerReturnLabelSettingsState> {
    await this.dependencies.authorizeChannel(channelId);
    const [settings, catalog, control] = await Promise.all([
      this.dependencies.store.read(channelId),
      this.dependencies.store.catalog(channelId),
      this.dependencies.store.readControl(channelId),
    ]);
    let capability: ReturnLabelCapabilities = {
      configured: false,
      carriers: [],
    };
    let message: string | null = null;
    try {
      capability = await this.dependencies.capabilities();
    } catch {
      message =
        "Return carrier services could not be verified. Try again before enabling labels.";
    }
    if (!capability.configured && !message)
      message =
        "Configure the ShipStation V2 API key before enabling return labels.";
    const resolved = resolveCustomerReturnPortalPolicy(
      catalog.policies,
      channelId,
    );
    return customerReturnLabelSettingsStateSchema.parse({
      channelId,
      providerConfigured: capability.configured,
      settings: settings?.policyId === resolved.policy?.id ? settings : null,
      control,
      warehouses: catalog.warehouses
        .filter((row) => row.isActive === 1)
        .map((row) => ({
          id: row.id,
          name: row.name,
          address: warehouseLabelAddress(row, row.name, null),
        })),
      resolvedPolicy: resolved.resolvedPolicy,
      policyIssue: resolved.policyIssue,
      carriers: capability.carriers,
      message,
    });
  }

  async save(
    channelId: number,
    _raw: unknown,
    _actor: string,
  ): Promise<CustomerReturnLabelSettingsState> {
    await this.dependencies.authorizeChannel(channelId);
    throw new CustomerReturnIntakeError("RETURN_LABEL_EDIT_POLICY", "Return shipping is configured in Policies. Open the applied policy and save a new version to change its return shipping.", 409);
  }

  async control(channelId: number, raw: unknown, actor: string): Promise<CustomerReturnLabelSettingsState> {
    await this.dependencies.authorizeChannel(channelId);
    const parsed = customerReturnLabelControlInputSchema.safeParse(raw);
    if (!parsed.success) throw new CustomerReturnIntakeError("RETURN_LABEL_CONTROL_INVALID", "Reload the current label controls before trying again.", 400);
    await this.dependencies.store.saveControl(channelId, parsed.data, actor, this.dependencies.now());
    return this.get(channelId);
  }

  async requireEnabled(channelId: number, version: number) {
    const { settings, catalog } = await this.requireShippingConfiguration(
      channelId,
      version,
    );
    const resolved = resolveCustomerReturnPortalPolicy(
      catalog.policies,
      channelId,
    );
    if (resolved.policyIssue || !resolved.policy) {
      throw new CustomerReturnIntakeError(
        resolved.policyIssue?.code ?? "RETURN_PORTAL_POLICY_MISSING",
        resolved.policyIssue?.message ??
          "No active return policy applies to this shop.",
      );
    }
    if (settings.policyId !== resolved.policy.id) throw new CustomerReturnIntakeError("RETURN_LABEL_SETTINGS_CHANGED", "The applied return policy changed. Refresh it before creating a return.");
    return {
      settings,
      operationalPolicy: {
        id: resolved.policy.id,
        version: resolved.policy.version,
        snapshot: snapshotReturnPolicy(resolved.policy),
      },
    };
  }

  /** An accepted return is bound to its original policy's immutable shipping
   * configuration. Replacing or archiving that policy never reroutes its boxes. */
  async requireAcceptedShippingEnabled(channelId: number, authorizationId: number) {
    await this.dependencies.authorizeChannel(channelId);
    const settings = await this.dependencies.store.readAccepted(channelId, authorizationId);
    return (await this.requireShippingConfiguration(channelId, settings?.version ?? 0, settings)).settings;
  }

  private async requireShippingConfiguration(
    channelId: number,
    version: number,
    acceptedSettings?: CustomerReturnLabelSettings | null,
  ) {
    await this.dependencies.authorizeChannel(channelId);
    const settings = acceptedSettings === undefined ? await this.dependencies.store.read(channelId) : acceptedSettings;
    const control = await this.dependencies.store.readControl(channelId);
    if (control.paused || !settings?.enabled || settings.version !== version)
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_SETTINGS_CHANGED",
        "Return label settings changed. Review the current settings before continuing.",
      );
    const catalog = await this.dependencies.store.catalog(channelId, acceptedSettings === undefined);
    if (
      !catalog.warehouses.some(
        (row) =>
          row.id === settings.warehouseId &&
          row.isActive === 1 &&
          row.country === "US",
      )
    )
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_CONFIGURATION_UNAVAILABLE",
        "The return warehouse needs administrator attention.",
      );
    const capabilities = await this.dependencies.capabilities();
    if (
      !capabilities.configured ||
      !supportsConfiguredServices(capabilities, settings)
    )
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_SERVICE_UNAVAILABLE",
        "The configured return service is unavailable.",
      );
    return { settings, catalog };
  }
}

export function supportsConfiguredServices(
  capabilities: ReturnLabelCapabilities,
  settings: Pick<
    CustomerReturnLabelSettings,
    "selectionMode" | "carrierId" | "serviceCode" | "carrierRules"
  >,
): boolean {
  const rules =
    settings.selectionMode === "fixed_service"
      ? [
          {
            carrierId: settings.carrierId,
            serviceCodes: [settings.serviceCode],
          },
        ]
      : settings.carrierRules;
  return (
    rules.length > 0 &&
    rules.every((rule) =>
      capabilities.carriers.some(
        (carrier) =>
          carrier.id === rule.carrierId &&
          rule.serviceCodes.every((code) =>
            carrier.services.some((service) => service.code === code),
          ),
      ),
    )
  );
}

export function isPortalReturnPolicy(
  policy: ReturnPolicy,
  channelId: number,
): boolean {
  return matchesCustomerReturnPortalPolicy(policy, channelId);
}

export function warehouseLabelAddress(
  row: ReturnLabelWarehouse,
  name: string,
  phone: string | null,
) {
  const parsed = customerReturnLabelAddressSchema.safeParse({
    name,
    ...(phone ? { phone } : {}),
    addressLine1: row.address,
    city: row.city,
    state: row.state,
    postalCode: row.postalCode,
    countryCode: row.country,
  });
  return parsed.success ? parsed.data : null;
}
