import type { ReturnPolicy } from "@shared/schema";
import {
  customerReturnLabelAddressSchema,
  customerReturnLabelSettingsInputSchema,
  customerReturnLabelSettingsStateSchema,
  type CustomerReturnLabelSettings,
  type CustomerReturnLabelSettingsInput,
  type CustomerReturnLabelSettingsState,
} from "@shared/returns/customer-return-label.contract";
import { DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS } from "../domain/customer-return-eligibility";
import { snapshotReturnPolicy } from "../domain/return-case";
import { CustomerReturnIntakeError } from "./customer-return-intake.ports";

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
  catalog(
    channelId: number,
  ): Promise<{ warehouses: ReturnLabelWarehouse[]; policies: ReturnPolicy[] }>;
  save(
    channelId: number,
    input: CustomerReturnLabelSettingsInput,
    actor: string,
    now: Date,
  ): Promise<CustomerReturnLabelSettings>;
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

/** Separate return policy: no outbound default warehouse or service is inferred. */
export class CustomerReturnLabelSettingsService {
  constructor(
    private readonly dependencies: CustomerReturnLabelSettingsDependencies,
  ) {}

  async get(channelId: number): Promise<CustomerReturnLabelSettingsState> {
    await this.dependencies.authorizeChannel(channelId);
    const [settings, catalog] = await Promise.all([
      this.dependencies.store.read(channelId),
      this.dependencies.store.catalog(channelId),
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
    return customerReturnLabelSettingsStateSchema.parse({
      channelId,
      providerConfigured: capability.configured,
      settings,
      warehouses: catalog.warehouses
        .filter((row) => row.isActive === 1)
        .map((row) => ({
          id: row.id,
          name: row.name,
          address: warehouseLabelAddress(row, row.name, null),
        })),
      policies: catalog.policies
        .filter((policy) => isPortalReturnPolicy(policy, channelId))
        .map((policy) => ({
          id: policy.id,
          name: policy.name,
          version: policy.version,
        })),
      carriers: capability.carriers,
      message,
    });
  }

  async save(
    channelId: number,
    raw: unknown,
    actor: string,
  ): Promise<CustomerReturnLabelSettingsState> {
    await this.dependencies.authorizeChannel(channelId);
    const result = customerReturnLabelSettingsInputSchema.safeParse(raw);
    if (!result.success)
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_SETTINGS_INVALID",
        "Choose valid return label settings.",
        400,
      );
    const input = result.data;
    if (input.enabled) {
      const capabilities = await this.dependencies.capabilities();
      if (
        !capabilities.configured ||
        !capabilities.carriers.some(
          (carrier) =>
            carrier.id === input.carrierId &&
            carrier.services.some(
              (service) => service.code === input.serviceCode,
            ),
        )
      ) {
        throw new CustomerReturnIntakeError(
          "RETURN_LABEL_SERVICE_UNAVAILABLE",
          "Choose a connected carrier service that supports domestic returns.",
        );
      }
    }
    await this.dependencies.store.save(
      channelId,
      input,
      actor,
      this.dependencies.now(),
    );
    return this.get(channelId);
  }

  async requireEnabled(channelId: number, version: number) {
    await this.dependencies.authorizeChannel(channelId);
    const settings = await this.dependencies.store.read(channelId);
    if (!settings?.enabled || settings.version !== version)
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_SETTINGS_CHANGED",
        "Return label settings changed. Review the current settings before continuing.",
      );
    const catalog = await this.dependencies.store.catalog(channelId);
    const policy = catalog.policies.find(
      (candidate) =>
        candidate.id === settings.policyId &&
        isPortalReturnPolicy(candidate, channelId),
    );
    if (
      !policy ||
      !catalog.warehouses.some(
        (row) =>
          row.id === settings.warehouseId &&
          row.isActive === 1 &&
          row.country === "US",
      )
    )
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_CONFIGURATION_UNAVAILABLE",
        "The return policy or warehouse needs administrator attention.",
      );
    const capabilities = await this.dependencies.capabilities();
    if (
      !capabilities.configured ||
      !capabilities.carriers.some(
        (carrier) =>
          carrier.id === settings.carrierId &&
          carrier.services.some(
            (service) => service.code === settings.serviceCode,
          ),
      )
    )
      throw new CustomerReturnIntakeError(
        "RETURN_LABEL_SERVICE_UNAVAILABLE",
        "The configured return service is unavailable.",
      );
    return {
      settings,
      operationalPolicy: {
        id: policy.id,
        version: policy.version,
        snapshot: snapshotReturnPolicy(policy),
      },
    };
  }
}

export function isPortalReturnPolicy(
  policy: ReturnPolicy,
  channelId: number,
): boolean {
  return (
    policy.status === "active" &&
    (policy.businessContext === null || policy.businessContext === "retail") &&
    (policy.channelId === null || policy.channelId === channelId) &&
    policy.vendorId === null &&
    policy.storeConnectionId === null &&
    policy.returnWindowDays === DEFAULT_CUSTOMER_RETURN_WINDOW_DAYS &&
    policy.returnDestination === "card_shellz" &&
    policy.approvalAuthority === "card_shellz" &&
    policy.labelProvider === "shipstation" &&
    policy.returnShippingPayer === "card_shellz" &&
    policy.customerRefundAuthority === "card_shellz" &&
    policy.inspectionOwner === "card_shellz" &&
    policy.vendorSettlementTrigger === "none"
  );
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
