import { z } from "zod";
import type { ShopifyIdentityConnection } from "../../channels/adapters/shopify-identity.reader";
import { customerReturnShopSchema } from "../domain/customer-return-shopify-proof";
import { CUSTOMER_RETURN_SHOPIFY_API_VERSION, customerReturnShopifyGidSchema } from "../application/customer-return-shopify-snapshot.ports";
import { CustomerReturnCustomerProfileError, customerReturnCustomerProfileEvidenceSchema,
  customerReturnCustomerProfileScopeSchema, type CustomerReturnCustomerProfileEvidence,
  type CustomerReturnCustomerProfileReader, type CustomerReturnCustomerProfileScope } from "../application/customer-return-customer-profile.service";

// This independent, small account read must not hold up session/order loading.
const PROFILE_TIMEOUT_MS = 5_000;
const MAX_PROFILE_RESPONSE_BYTES = 32_768;
const PROFILE_QUERY = `query ReturnCustomerProfile($id: ID!) {
  shop { id myshopifyDomain }
  customer(id: $id) { id firstName lastName defaultEmailAddress { emailAddress } }
}`;
const connectionSchema = z.object({
  id: z.number().int().positive().safe(), channelId: z.number().int().positive().safe(),
  shopDomain: customerReturnShopSchema, accessToken: z.string().trim().min(1).max(4096),
  apiVersion: z.string().regex(/^\d{4}-(01|04|07|10)$/), shopifyLocationId: z.string().nullable(),
}).strict();
const profileDataSchema = z.object({
  shop: z.object({ id: customerReturnShopifyGidSchema("Shop"), myshopifyDomain: customerReturnShopSchema }).strict(),
  customer: z.object({
    id: customerReturnShopifyGidSchema("Customer"), firstName: z.string().max(255).nullable(), lastName: z.string().max(255).nullable(),
    defaultEmailAddress: z.object({ emailAddress: z.string().max(320) }).strict().nullable(),
  }).strict(),
}).strict();
export interface ShopifyCustomerReturnCustomerProfileReaderDependencies {
  resolveConnection: (channelId: number) => Promise<ShopifyIdentityConnection>;
  request: typeof fetch;
}

/** No global Shopify credentials or order-derived account names are allowed. */
export class ShopifyCustomerReturnCustomerProfileReader implements CustomerReturnCustomerProfileReader {
  constructor(private readonly dependencies: ShopifyCustomerReturnCustomerProfileReaderDependencies) {}

  async read(raw: CustomerReturnCustomerProfileScope): Promise<CustomerReturnCustomerProfileEvidence> {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(PROFILE_TIMEOUT_MS)]);
    try {
      const scope = customerReturnCustomerProfileScopeSchema.parse(raw);
      const before = await this.connection(scope, signal);
      const customerId = `gid://shopify/Customer/${scope.externalCustomerId}`;
      const response = await abortable(this.dependencies.request(
        `https://${before.shopDomain}/admin/api/${CUSTOMER_RETURN_SHOPIFY_API_VERSION}/graphql.json`, {
          method: "POST", redirect: "error", cache: "no-store", signal,
          headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": before.accessToken },
          body: JSON.stringify({ query: PROFILE_QUERY, variables: { id: customerId } }),
        }), signal);
      if (!response.ok || response.headers.get("X-Shopify-API-Version") !== CUSTOMER_RETURN_SHOPIFY_API_VERSION) {
        void response.body?.cancel().catch(() => undefined);
        throw new CustomerReturnCustomerProfileError();
      }
      const envelope = z.record(z.unknown()).parse(await readJson(response, signal));
      if (envelope.errors !== undefined && (!Array.isArray(envelope.errors) || envelope.errors.length > 0)) {
        throw new CustomerReturnCustomerProfileError();
      }
      const data = profileDataSchema.parse(envelope.data);
      if (data.shop.myshopifyDomain !== scope.shopDomain || data.customer.id !== customerId) {
        throw new CustomerReturnCustomerProfileError();
      }
      // Do not return an account read if its channel connection changed in flight.
      const after = await this.connection(scope, signal);
      if (before.id !== after.id || before.accessToken !== after.accessToken || before.apiVersion !== after.apiVersion) {
        throw new CustomerReturnCustomerProfileError();
      }
      return customerReturnCustomerProfileEvidenceSchema.parse({ shopDomain: scope.shopDomain,
        externalCustomerId: scope.externalCustomerId, firstName: data.customer.firstName,
        lastName: data.customer.lastName, email: data.customer.defaultEmailAddress?.emailAddress ?? null });
    } catch {
      throw new CustomerReturnCustomerProfileError();
    } finally {
      controller.abort();
    }
  }

  private async connection(scope: CustomerReturnCustomerProfileScope, signal: AbortSignal) {
    const connection = connectionSchema.parse(await abortable(this.dependencies.resolveConnection(scope.channelId), signal));
    if (connection.channelId !== scope.channelId || connection.shopDomain !== scope.shopDomain) {
      throw new CustomerReturnCustomerProfileError();
    }
    return connection;
  }
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new CustomerReturnCustomerProfileError());
    operation.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function readJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new CustomerReturnCustomerProfileError();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_PROFILE_RESPONSE_BYTES) throw new CustomerReturnCustomerProfileError();
      chunks.push(chunk.value);
    }
    const body = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
