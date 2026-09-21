import { z } from "zod";
import { walmartConnectSchema, walmartControlSchema, walmartKeyInputSchema, walmartMappingSchema } from "@shared/types/walmart-channel";
import type { FulfillmentProviderCredentialCipher } from "../../../shipping-engine/application/connected-fulfillment-method-catalog.service";
import { WalmartApiError, WalmartClient, walmartCredentialsSchema } from "./walmart-client";
import { WalmartUsApi, type WalmartUsApiPort } from "./walmart-us-api";
import { WalmartConnectionRepository, type WalmartConnectionRecord } from "./walmart-connection.repository";

export class WalmartChannelService {
  private readonly clients = new Map<number, { revision: number; api: WalmartUsApiPort }>();
  constructor(
    readonly repository: WalmartConnectionRepository,
    private readonly cipher: FulfillmentProviderCredentialCipher | null,
    private readonly policy: { liveEnabled: boolean; productionServer: boolean },
    private readonly now: () => Date = () => new Date(),
    private readonly createApi: (credentials: z.infer<typeof walmartCredentialsSchema>) => WalmartUsApiPort
      = credentials => new WalmartUsApi(new WalmartClient(credentials)),
  ) {}
  async preview(input: unknown) {
    this.requireCipher();
    const keys = walmartKeyInputSchema.parse(input);
    const api = this.createApi({ ...keys, market: "us" });
    const account = await api.account();
    await api.orders(new URLSearchParams({ limit: "1", shipNodeType: "SellerFulfilled", replacementInfo: "true" }));
    return { ...account, nodes: account.nodes.filter(node => node.status === "ACTIVE" && node.nodeType === "PHYSICAL") };
  }
  async connect(channelId: number, input: unknown, actor: string) {
    const command = walmartConnectSchema.parse(input);
    const cipher = this.requireCipher();
    const now = this.now();
    const since = new Date(command.importSince);
    const MAX_IMPORT_AGE_MS = 180 * 24 * 60 * 60 * 1_000;
    if (since > now || now.getTime() - since.getTime() > MAX_IMPORT_AGE_MS) {
      throw new WalmartApiError("WALMART_IMPORT_BOUNDARY_INVALID", "Import start must be within the last 180 days", false);
    }
    return this.repository.withLock(channelId, async () => {
      const credentials = { clientId: command.clientId, clientSecret: command.clientSecret, environment: command.environment, market: "us" as const };
      const api = this.createApi(credentials);
      const account = await api.account();
      if (account.partnerId !== command.expectedPartnerId) throw new WalmartApiError("WALMART_ACCOUNT_CHANGED", "The verified Walmart account changed; verify the connection again", false);
      if (!account.nodes.some(node => node.shipNode === command.shipNodeId && node.nodeType === "PHYSICAL" && node.status === "ACTIVE")) {
        throw new WalmartApiError("WALMART_SHIP_NODE_INVALID", "Select an active seller-operated Walmart fulfillment center", false);
      }
      await api.orders(new URLSearchParams({ limit: "1", shipNodeType: "SellerFulfilled", replacementInfo: "true" }));
      await this.repository.save(command, channelId, account.partnerName, actor, now,
        connectionId => cipher.seal({ connectionId, provider: "walmart", credential: JSON.stringify(credentials) }));
      this.clients.delete(channelId);
      return this.repository.status(channelId);
    });
  }
  async control(channelId: number, input: unknown, actor: string) {
    const command = walmartControlSchema.parse(input);
    return this.repository.withLock(channelId, async () => {
      const row = await this.connection(channelId);
      if (command.ordersEnabled) {
        this.requireRuntime(row);
        const api = this.api(row);
        const account = await api.account();
        if (account.partnerId !== row.partner_id || !account.nodes.some(node => node.shipNode === row.ship_node_id && node.status === "ACTIVE" && node.nodeType === "PHYSICAL")) {
          throw new WalmartApiError("WALMART_ACCOUNT_CHANGED", "Account or fulfillment center verification failed", false);
        }
        await this.repository.assertWarehouse(row);
        const status = await this.repository.status(channelId);
        if (!status?.mappedSkus) throw new WalmartApiError("WALMART_MAPPINGS_REQUIRED", "Link your Walmart SKUs before enabling order intake", false);
      }
      await this.repository.control(channelId, command.ordersEnabled, command.expectedRevision, actor, this.now());
      return this.repository.status(channelId);
    });
  }
  async linkSku(channelId: number, input: unknown, actor: string) {
    const command = walmartMappingSchema.parse(input);
    return this.repository.withLock(channelId, async () => {
      const row = await this.connection(channelId);
      await this.api(row).inventory(command.sku, row.ship_node_id);
      await this.repository.linkSku(channelId, command.productVariantId, command.sku, actor, this.now());
      return this.repository.status(channelId);
    });
  }
  async connection(channelId: number, expectedConnectionId?: number): Promise<WalmartConnectionRecord> {
    const row = await this.repository.get(channelId);
    if (!row || (expectedConnectionId !== undefined && row.connection_id !== expectedConnectionId)) {
      throw new WalmartApiError("WALMART_CONNECTION_REQUIRED", "Configure the exact Walmart account connection first", false);
    }
    return row;
  }
  requireRuntime(row: WalmartConnectionRecord): void {
    if (row.environment === "production" && !this.policy.liveEnabled) throw new WalmartApiError("WALMART_LIVE_DISABLED", "Live Walmart operations have not been enabled on this server", false);
    if (row.environment === "sandbox" && this.policy.productionServer) throw new WalmartApiError("WALMART_SANDBOX_IMPORT_BLOCKED", "Sandbox orders cannot enter the production warehouse", false);
  }
  api(row: WalmartConnectionRecord): WalmartUsApiPort {
    const cached = this.clients.get(row.channel_id);
    if (cached?.revision === row.revision) return cached.api;
    const plaintext = this.requireCipher().open({
      connection: { id: row.connection_id, provider: "walmart", name: row.partner_name, status: "active",
        credentialSource: "vault", credentialRef: null, revision: row.revision },
      credential: row.encrypted_credentials,
    });
    const credentials = walmartCredentialsSchema.parse(JSON.parse(plaintext) as unknown);
    if (credentials.market !== "us" || credentials.environment !== row.environment) throw new WalmartApiError("WALMART_CREDENTIAL_SCOPE_MISMATCH", "Stored credentials do not match the selected Walmart environment", false);
    const api = this.createApi(credentials);
    if (this.clients.size >= 100) this.clients.clear();
    this.clients.set(row.channel_id, { revision: row.revision, api });
    return api;
  }
  private requireCipher(): FulfillmentProviderCredentialCipher {
    if (!this.cipher) throw new WalmartApiError("WALMART_VAULT_UNCONFIGURED", "Configure WALMART_CREDENTIAL_ENCRYPTION_KEY before connecting an account", false);
    return this.cipher;
  }
}
