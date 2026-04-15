import https from "https";
import { DropshipError } from "../domain/errors";

export class EbayClient {
  
  /**
   * Deterministic REST requester for eBay APIs
   */
  static request(method: string, path: string, accessToken: string, body?: unknown): Promise<any> {
    const environment = process.env.EBAY_ENVIRONMENT || "production";
    const hostname = environment === "sandbox" ? "api.sandbox.ebay.com" : "api.ebay.com";

    return new Promise((resolve, reject) => {
      const payload = body ? JSON.stringify(body) : undefined;
      const options: https.RequestOptions = {
        hostname,
        path,
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Language": "en-US",
          "Accept-Language": "en-US",
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(payload ? { "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 204) return resolve(undefined);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try { return resolve(data ? JSON.parse(data) : undefined); } catch { return resolve(data); }
          }
          reject(new DropshipError("EBAY_API_ERROR", `eBay API ${method} ${path} failed (${res.statusCode})`, { data }));
        });
      });

      req.on("error", (e) => reject(new DropshipError("EBAY_NETWORK_ERROR", e.message)));
      if (payload) req.write(payload);
      req.end();
    });
  }

  /**
   * Automated Injection of Dropship Standard Policies
   * Idempotent: eBay handles identical name creation by referencing existing or overwriting.
   */
  static async injectStandardPolicies(accessToken: string, marketplaceId: string = "EBAY_US"): Promise<void> {
    try {
      // 1. Fulfillment Policy: 1 Business Day Handling, Flat Rate tracking
      await this.request("POST", "/sell/account/v1/fulfillment_policy", accessToken, {
        name: "Card Shellz Dropship 1-Day",
        marketplaceId,
        handlingTime: { value: 1, unit: "DAY" },
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
        shippingOptions: [{
          costType: "FLAT_RATE",
          optionType: "DOMESTIC",
          shippingServices: [{
            shippingCarrierCode: "USPS",
            shippingServiceCode: "USPSFirstClass",
            shippingCost: { value: "0.0", currency: "USD" } // Overridden on item level 
          }]
        }]
      }).catch(e => { if(!e.message.includes("already exists")) throw e; });

      // 2. Return Policy: 30 Day Returns (Buyer pays return shipping default)
      await this.request("POST", "/sell/account/v1/return_policy", accessToken, {
        name: "Card Shellz Standard Return",
        marketplaceId,
        returnsAccepted: true,
        returnPeriod: { value: 30, unit: "DAY" },
        returnShippingCostPayer: "BUYER",
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }]
      }).catch(e => { if(!e.message.includes("already exists")) throw e; });

      // 3. Payment Policy: Opt-in to Managed Payments
      await this.request("POST", "/sell/account/v1/payment_policy", accessToken, {
        name: "Card Shellz Managed Payments",
        marketplaceId,
        categoryTypes: [{ name: "ALL_EXCLUDING_MOTORS_VEHICLES" }],
        paymentMethods: [{ paymentMethodType: "CREDIT_CARD" }]
      }).catch(e => { if(!e.message.includes("already exists")) throw e; });

      // 4. Merchant Location: Card Shellz fulfillment HQ
      await this.request("POST", "/sell/inventory/v1/location/card-shellz-hq", accessToken, {
        location: {
          address: {
            addressLine1: "123 Card Shellz Way",
            city: "Orlando",
            stateOrProvince: "FL",
            postalCode: "32801",
            country: "US"
          }
        },
        name: "Card Shellz Dropship HQ",
        merchantLocationStatus: "ENABLED",
        locationTypes: ["STORE"]
      });

    } catch (error) {
      console.error("[EbayClient] Policy injection partially failed. Note: This does not abort OAuth natively.", error);
    }
  }
}
