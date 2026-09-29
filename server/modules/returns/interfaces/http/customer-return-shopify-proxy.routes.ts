import { createHash } from "node:crypto";
import { Router, type Express } from "express";
import { z } from "zod";
import { CUSTOMER_RETURNS_SHOPIFY_PROXY } from "@shared/returns/customer-return-access.contract";
import { RETURN_CUSTOMER_ENCODED_PROOF_MAX_LENGTH } from "../../application/customer-return-customer-auth.service";
import { createCustomerReturnCustomerAuth } from "../../infrastructure/customer-return-customer-auth.composition";
import { returnCustomerError, returnCustomerPrivateResponse } from "./customer-return-customer-auth.routes";

const SUBMIT_SCRIPT = "document.getElementById('returns-shopify-proof').submit();";
const SUBMIT_SCRIPT_HASH = createHash("sha256").update(SUBMIT_SCRIPT).digest("base64");
const encodedProofSchema = z.string().min(1).max(RETURN_CUSTOMER_ENCODED_PROOF_MAX_LENGTH).regex(/^[A-Za-z0-9_-]+$/);

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

/** Shopify strips cookies from proxy requests. This endpoint verifies and
 * relays Shopify proof only; the same-origin redemption retains both the
 * private staff gate and the browser-bound, single-use challenge. */
export function registerCustomerReturnShopifyProxyRoutes(app: Express, dependencies: {
  context?: typeof createCustomerReturnCustomerAuth;
} = {}): void {
  const context = dependencies.context ?? createCustomerReturnCustomerAuth;
  const router = Router();
  router.use((_req, res, next) => {
    returnCustomerPrivateResponse(res);
    res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    next();
  });
  router.all("/", async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      res.status(405).json({ error: { code: "RETURN_SHOPIFY_PROXY_METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    try {
      const { auth, config } = await context();
      const queryStart = req.originalUrl.indexOf("?");
      const result = await auth.proxy(queryStart < 0 ? "" : req.originalUrl.slice(queryStart + 1));
      if (result.kind === "redirect") {
        res.redirect(303, result.location);
        return;
      }
      const proof = encodedProofSchema.parse(result.proof);
      if (result.callbackUrl !== `${config.publicOrigin}/customer-returns/callback`) {
        throw new Error("Unexpected returns callback destination");
      }
      res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'sha256-${SUBMIT_SCRIPT_HASH}'; form-action ${config.publicOrigin}; frame-ancestors 'none'; base-uri 'none'`);
      res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Continue to returns</title></head><body><main><h1>Continue to returns</h1><p>Confirming your Shopify account…</p><form id="returns-shopify-proof" method="post" action="${escapeHtml(result.callbackUrl)}" target="_top"><input type="hidden" name="proof" value="${proof}"><button type="submit">Continue to returns</button></form></main><script>${SUBMIT_SCRIPT}</script></body></html>`);
    } catch (error) { returnCustomerError(res, error); }
  });
  router.use((_req, res) => res.status(404).json({ error: { code: "RETURN_SHOPIFY_PROXY_NOT_FOUND", message: "Not found." } }));
  app.use(CUSTOMER_RETURNS_SHOPIFY_PROXY, router);
}
