import { abortable, readCustomerReturnShopifyJson } from "./customer-return-shopify-snapshot.reader";
import { CUSTOMER_RETURN_SHOPIFY_API_VERSION } from "../application/customer-return-shopify-snapshot.ports";
import type { Pool } from "pg";
import { z } from "zod";
import type { ShopifyIdentityConnection } from "../../channels/shopify-identity.api";
import { buildCustomerReturnOrderNumberAliases } from "../domain/customer-return-order-reference";
import { CustomerReturnCustomerAccessError } from "../application/customer-return-customer-auth.service";
import { guestAccessError } from "../application/customer-return-guest.service";
import { guestPurchaseSchema, type GuestPurchase, type GuestPurchaseGateway } from "../application/customer-return-guest.ports";

const gid = (resource: string) => z.string().regex(new RegExp(`^gid://shopify/${resource}/[1-9][0-9]*$`));
const customer = z.object({ id: gid("Customer"), email: z.string().email().nullable(), state: z.enum(["DISABLED", "INVITED", "ENABLED", "DECLINED"]) });
const purchaseResponse = z.object({ shop: z.object({ myshopifyDomain: z.string() }),
  order: z.object({ id: gid("Order"), name: z.string(), email: z.string().email().nullable(), customer: customer.nullable() }).nullable() });
const orderId = (value: string) => value.startsWith("gid://") ? gid("Order").parse(value) : gid("Order").parse(`gid://shopify/Order/${value}`);
const PURCHASE_QUERY = `query GuestReturnPurchase($id: ID!) { shop { myshopifyDomain } order(id:$id) { id name email customer { id email state } } }`;
const ACTIVATION_QUERY = `mutation GuestReturnAccount($id:ID!) { customerGenerateAccountActivationUrl(customerId:$id) { accountActivationUrl userErrors { field message } } }`;

/** Purchase linkage is checked at Shopify, never manufactured by matching an
 * email to an unrelated customer or by changing an order's customer. */
export class ShopifyGuestReturnPurchaseGateway implements GuestPurchaseGateway {
  constructor(private readonly dependencies: { database: Pick<Pool, "query">; connection: (channelId: number) => Promise<ShopifyIdentityConnection>;
    request: typeof fetch; storefrontOrigin: (shop: string) => string }) {}
  async find(channelId: number, shopDomain: string, reference: string, email: string) {
    const aliases = buildCustomerReturnOrderNumberAliases(reference);
    const rows = (await this.dependencies.database.query(`SELECT id,external_order_id,external_customer_id,external_order_number
      FROM oms.oms_orders WHERE channel_id=$1 AND external_order_number=ANY($2::text[]) ORDER BY id LIMIT 2`, [channelId, aliases])).rows;
    if (rows.length !== 1) return null;
    const local = localRow.parse(rows[0]);
    const remote = await this.purchase(channelId, shopDomain, local.external_order_id);
    if (!remote?.email || !aliases.includes(remote.name) || remote.email.toLowerCase() !== email.toLowerCase()) return null;
    // The sales channel owns purchase identity. Retain the local customer as a
    // source-revision fence, not as guest authority or an activation target.
    return guestPurchaseSchema.parse({ channelId, shopDomain, omsOrderId: local.id, externalOrderId: local.external_order_id,
      externalCustomerId: local.external_customer_id, email: remote.email,
      verifiedPurchase: { email: remote.email, customerId: remote.customer?.id ?? null } });
  }
  async current(raw: GuestPurchase) {
    const purchase = guestPurchaseSchema.parse(raw);
    const rows = (await this.dependencies.database.query(`SELECT id,external_order_id,external_customer_id,external_order_number
      FROM oms.oms_orders WHERE channel_id=$1 AND id=$2`, [purchase.channelId, purchase.omsOrderId])).rows;
    if (rows.length !== 1) return false;
    const local = localRow.parse(rows[0]);
    if (local.external_order_id !== purchase.externalOrderId || local.external_customer_id !== purchase.externalCustomerId) return false;
    const remote = await this.purchase(purchase.channelId, purchase.shopDomain, purchase.externalOrderId);
    return remote !== null && remote.email?.toLowerCase() === purchase.email.toLowerCase()
      && (remote.customer?.id ?? null) === purchase.verifiedPurchase.customerId;
  }
  async account(purchase: GuestPurchase, previous?: { kind: "activate" | "sign_in" | "register"; url: string } | null) {
    const remote = await this.purchase(purchase.channelId, purchase.shopDomain, purchase.externalOrderId);
    if (!remote || remote.email?.toLowerCase() !== purchase.email.toLowerCase()
      || (remote.customer?.id ?? null) !== purchase.verifiedPurchase.customerId) throw guestAccessError();
    const origin = this.origin(purchase.shopDomain);
    if (remote.customer === null) {
      // No attached customer exists. Registration is optional and must not
      // silently reassign this order or promise that Shopify will attach it.
      return { kind: "register" as const, url: `${origin}/account/register` };
    }
    if (remote.customer.state === "ENABLED") return { kind: "sign_in" as const, url: `${origin}/account/login?return_url=%2Fpages%2Fstart-a-return` };
    if (remote.customer.email?.toLowerCase() !== purchase.email.toLowerCase()) throw new CustomerReturnCustomerAccessError(
      "RETURN_GUEST_ACCOUNT_EMAIL_CHANGED", "You can continue your return as a guest. Contact us for help activating your account.", 409);
    // A completed activation changes this to sign-in above. While the account
    // remains disabled, retries reuse the original URL instead of invalidating it.
    if (previous?.kind === "activate") return previous;
    const result = z.object({ customerGenerateAccountActivationUrl: z.object({ accountActivationUrl: z.string().url().nullable(),
      userErrors: z.array(z.object({ field: z.array(z.string()).nullable(), message: z.string() })) }) })
      .parse(await this.query(purchase.channelId, purchase.shopDomain, ACTIVATION_QUERY, { id: remote.customer.id }));
    const activation = result.customerGenerateAccountActivationUrl;
    if (activation.userErrors.length || !activation.accountActivationUrl) throw unavailable();
    const url = new URL(activation.accountActivationUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.hash
      || ![origin, `https://${purchase.shopDomain}`].includes(url.origin) || !/^\/account\/activate\//.test(url.pathname)) throw unavailable();
    // Shopify has no compare-and-set activation mutation. Recheck its purchase
    // and customer after URL generation before exposing that capability.
    const confirmed = await this.purchase(purchase.channelId, purchase.shopDomain, purchase.externalOrderId);
    if (!confirmed || confirmed.email?.toLowerCase() !== purchase.email.toLowerCase()
      || confirmed.customer?.id !== remote.customer.id || confirmed.customer.email?.toLowerCase() !== purchase.email.toLowerCase()) throw unavailable();
    if (confirmed.customer.state === "ENABLED") return { kind: "sign_in" as const, url: `${origin}/account/login?return_url=%2Fpages%2Fstart-a-return` };
    return { kind: "activate" as const, url: url.href };
  }
  private origin(shop: string) {
    const url = new URL(this.dependencies.storefrontOrigin(shop));
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw unavailable();
    return url.origin;
  }
  private async purchase(channelId: number, shop: string, id: string) {
    const result = purchaseResponse.parse(await this.query(channelId, shop, PURCHASE_QUERY, { id: orderId(id) }));
    if (result.shop.myshopifyDomain !== shop || (result.order && result.order.id !== orderId(id))) throw unavailable();
    return result.order;
  }
  private async query(channelId: number, shop: string, query: string, variables: { id: string }): Promise<unknown> {
    const connection = await this.dependencies.connection(channelId);
    if (connection.channelId !== channelId || connection.shopDomain !== shop
      || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shop) || !/^\d{4}-(01|04|07|10)$/.test(connection.apiVersion)) throw unavailable();
    try {
      const signal = AbortSignal.timeout(15_000);
      const response = await abortable(this.dependencies.request(`https://${shop}/admin/api/${CUSTOMER_RETURN_SHOPIFY_API_VERSION}/graphql.json`, {
        method: "POST", redirect: "error", cache: "no-store", signal,
        headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": connection.accessToken }, body: JSON.stringify({ query, variables }) }), signal);
      if (!response.ok || response.headers.get("X-Shopify-API-Version") !== CUSTOMER_RETURN_SHOPIFY_API_VERSION) throw unavailable();
      const envelope = z.object({ data: z.unknown(), errors: z.array(z.unknown()).optional() })
        .parse(await readCustomerReturnShopifyJson(response, signal, 64_000));
      if (envelope.errors?.length || !envelope.data) throw unavailable();
      return envelope.data;
    } catch { throw unavailable(); }
  }
}
const localRow = z.object({ id: z.coerce.number().int().positive().safe(), external_order_id: z.string().min(1),
  external_customer_id: z.string().nullable(), external_order_number: z.string() });
function unavailable() { return new CustomerReturnCustomerAccessError("RETURN_GUEST_PURCHASE_UNAVAILABLE", "We couldn't verify the purchase right now. Please try again.", 503); }
