import type { Express } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { RETURN_GUEST_PROXY_API, returnGuestProofSchema } from "@shared/returns/customer-return-guest.contract";
import { CUSTOMER_ACCOUNT_COMMAND_HEADER } from "@shared/customer-account/customer-account.contract";
import { createCustomerReturnCustomerAuth } from "../../infrastructure/customer-return-customer-auth.composition";
import { createCustomerReturnGuestService, createGuestReturnServices } from "../../infrastructure/customer-return-guest.composition";
import { readCustomerAccountStagingConfig, requireCustomerAccountStorefront } from "../../../customer-account/domain/customer-account-staging";
import { CustomerReturnCustomerAccessError } from "../../application/customer-return-customer-auth.service";
import { dispatchCustomerReturn } from "./customer-return-dispatch";
import { returnCustomerPrivateResponse, returnCustomerError } from "./customer-return-customer-auth.routes";

const envelopeSchema = z.object({ themeId: z.string().regex(/^[1-9][0-9]{0,29}$/),
  action: z.enum(["lookup", "verify", "account", "returns", "logout"]), input: z.unknown(), proof: returnGuestProofSchema.optional() }).strict();
const requestSchema = z.object({ method: z.enum(["GET", "POST"]), path: z.string().max(300).startsWith("/returns/"),
  query: z.record(z.string().max(100), z.string().max(500)).default({}), body: z.unknown().optional() }).strict();
export interface GuestReturnRouteDependencies {
  context: typeof createCustomerReturnCustomerAuth;
  service: typeof createCustomerReturnGuestService;
  returns: typeof createGuestReturnServices;
  staging: typeof readCustomerAccountStagingConfig;
}
export function registerCustomerReturnGuestRoutes(app: Express, overrides: Partial<GuestReturnRouteDependencies> = {}) {
  const dependencies = { context: createCustomerReturnCustomerAuth, service: createCustomerReturnGuestService,
    returns: createGuestReturnServices, staging: readCustomerAccountStagingConfig, ...overrides };
  app.use(RETURN_GUEST_PROXY_API, (_req, res, next) => { returnCustomerPrivateResponse(res); next(); });
  // Transport-IP limit complements the durable destination/browser counters.
  // It is not used as proof of identity: Shopify can share transport IPs.
  app.post(RETURN_GUEST_PROXY_API, rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-7", legacyHeaders: false,
    message: { error: { code: "RETURN_GUEST_RATE_LIMITED", message: "Please wait before trying again." } } }), async (req, res) => {
    let action = "invalid";
    try {
      if (!req.is("application/json")) throw new CustomerReturnCustomerAccessError("RETURN_GUEST_INPUT_INVALID", "Check your return details.", 400);
      const input = envelopeSchema.parse(req.body); action = input.action;
      const { auth, config } = await dependencies.context();
      const shop = await auth.storefrontShop(req.originalUrl.split("?")[1] ?? "");
      requireCustomerAccountStorefront({ config: dependencies.staging(process.env.CUSTOMER_ACCOUNT_STAGING_CONFIG), authConfig: config,
        shopDomain: shop.shopDomain, themeId: input.themeId, origin: req.get("origin"), commandHeader: req.get(CUSTOMER_ACCOUNT_COMMAND_HEADER) });
      const service = await dependencies.service(config);
      let result: unknown;
      if (input.action === "lookup") result = await service.lookup(shop.channelId, shop.shopDomain, input.input);
      else if (input.action === "verify") result = await service.verify(shop.channelId, input.input);
      else if (input.action === "account") result = await service.activate(shop.channelId, input.input);
      else if (input.action === "logout") result = await service.logout(shop.channelId, input.input);
      else {
        const { purchase } = await service.authorize(shop.channelId, input.proof);
        if (purchase.shopDomain !== shop.shopDomain) throw new CustomerReturnCustomerAccessError("RETURN_GUEST_SCOPE_INVALID", "Verify this order again.", 401);
        const request = requestSchema.parse(input.input);
        // The guest services expose one verified purchase and its return history.
        // Account, rewards and order-edit paths remain outside this dispatcher.
        result = await dispatchCustomerReturn(request, await dependencies.returns(purchase));
      }
      if (result instanceof Uint8Array) res.type("application/pdf").setHeader("Content-Disposition", 'attachment; filename="return-label.pdf"').send(Buffer.from(result));
      else res.json(result);
    } catch (error) {
      const code = error instanceof CustomerReturnCustomerAccessError ? error.code : error instanceof z.ZodError ? "RETURN_GUEST_INPUT_INVALID" : "RETURN_GUEST_REQUEST_FAILED";
      console.warn(JSON.stringify({ event: "guest_return_request_failed", action, code }));
      returnCustomerError(res, error);
    }
  });
}
