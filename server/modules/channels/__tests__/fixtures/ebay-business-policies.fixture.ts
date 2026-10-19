import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Named-schema fixture for the real policy repository. Audit persistence uses
 * its production migration; provider access is supplied at the HTTP boundary. */
export const ebayBusinessPolicyFixtureSql = `
  CREATE SCHEMA catalog; CREATE SCHEMA channels; CREATE SCHEMA ebay;
  CREATE TABLE channels.channels(id integer PRIMARY KEY,provider text NOT NULL);
  CREATE TABLE channels.channel_connections(id integer PRIMARY KEY,channel_id integer NOT NULL REFERENCES channels.channels,
    metadata jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE ebay.ebay_oauth_tokens(channel_id integer NOT NULL REFERENCES channels.channels,environment text NOT NULL,
    external_account_id text,external_account_identity_scheme text,external_account_verified_at timestamptz,
    PRIMARY KEY(channel_id,environment));
  CREATE TABLE catalog.products(id integer PRIMARY KEY,product_type text,name text,sku text,
    ebay_fulfillment_policy_override text,ebay_return_policy_override text,ebay_payment_policy_override text,
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE catalog.product_variants(id integer PRIMARY KEY,product_id integer NOT NULL REFERENCES catalog.products,sku text,
    ebay_fulfillment_policy_override text,ebay_return_policy_override text,ebay_payment_policy_override text,
    updated_at timestamptz NOT NULL DEFAULT now());
  CREATE TABLE ebay.ebay_category_mappings(id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    channel_id integer NOT NULL REFERENCES channels.channels,product_type_slug text NOT NULL,
    ebay_browse_category_id text,ebay_browse_category_name text,ebay_store_category_id text,ebay_store_category_name text,
    fulfillment_policy_override varchar(20),return_policy_override varchar(20),payment_policy_override varchar(20),
    listing_enabled boolean NOT NULL DEFAULT true,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE(channel_id,product_type_slug));
` + readFileSync(resolve(process.cwd(), "migrations/0107_audit_events.sql"), "utf8");

export const ebayBusinessPolicySeedSql = `
  INSERT INTO channels.channels VALUES(67,'ebay');
  INSERT INTO channels.channel_connections(id,channel_id,metadata) VALUES(9,67,
    '{"marketplaceId":"EBAY_US","fulfillmentPolicyId":"store-shipping","returnPolicyId":"store-returns","paymentPolicyId":"store-payment","merchantLocationKey":"main","unrelated":{"preserve":true}}');
  INSERT INTO ebay.ebay_oauth_tokens VALUES(67,'production','seller-36','provider_user_id','2026-10-18T12:00:00Z');
  INSERT INTO catalog.products(id,product_type,name,sku) VALUES(20,'packs','Current pack','PACK'),(21,'other','Other product','OTHER');
  INSERT INTO catalog.product_variants(id,product_id,sku) VALUES(101,20,'PACK-P5'),(102,20,'PACK-P6'),(103,21,'OTHER-P5');
  INSERT INTO ebay.ebay_category_mappings(channel_id,product_type_slug,ebay_browse_category_id,ebay_browse_category_name,
    ebay_store_category_id,ebay_store_category_name) VALUES(67,'packs','183454','Trading card supplies','store-category','Packs');
`;

export const ebayPolicyScope = {
  channelId: 67, connectionId: 9, accountId: "seller-36", environment: "production" as const, marketplaceId: "EBAY_US",
};
export const ebayPolicyTime = new Date("2026-10-18T12:00:00Z");
export const policyKinds = ["fulfillment", "return", "payment"] as const;
export const policyLayers = ["store", "type", "product", "variant", "replacement"] as const;

export function providerPolicyCatalog(kind: typeof policyKinds[number], marketplaceId = "EBAY_US") {
  return { [`${kind}Policies`]: policyLayers.map(layer => ({
    [`${kind}PolicyId`]: `${layer}-${kind === "fulfillment" ? "shipping" : kind === "return" ? "returns" : "payment"}`,
    name: `${layer} ${kind}`, marketplaceId,
  })) };
}

/** Provider double at the HTTP boundary; no policy service or repository mocks. */
export class EbayPolicyCatalogHttp {
  readonly requests: string[] = [];
  failure: "http" | "malformed" | "partial" | "wrong_marketplace" | "empty" | null = null;
  hold: { entered(): void; released: Promise<void> } | null = null;
  catalog = new Map<string, unknown>(policyKinds.map(kind => [kind, providerPolicyCatalog(kind)]));

  readonly fetch: typeof fetch = async (input, options) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if ((options?.method ?? "GET") !== "GET") throw new Error(`Unexpected provider mutation ${options?.method} ${url.pathname}`);
    const kind = policyKinds.find(candidate => url.pathname === `/sell/account/v1/${candidate}_policy`);
    if (!kind || url.searchParams.get("marketplace_id") !== "EBAY_US") throw new Error(`Unexpected policy catalog read ${url.pathname}${url.search}`);
    this.requests.push(`${url.pathname}${url.search}`);
    if (this.hold) {
      const held = this.hold;
      held.entered();
      await held.released;
    }
    if (this.failure === "http") return Response.json({ errors: [{ errorId: 25001, message: "Catalog temporarily unavailable" }] }, { status: 503 });
    if (this.failure === "malformed") return Response.json({ unexpected: true });
    if (this.failure === "partial") return Response.json({ ...providerPolicyCatalog(kind), total: 99 });
    if (this.failure === "wrong_marketplace") return Response.json(providerPolicyCatalog(kind, "EBAY_GB"));
    if (this.failure === "empty") return Response.json({ [`${kind}Policies`]: [] });
    return Response.json(this.catalog.get(kind));
  };
}
