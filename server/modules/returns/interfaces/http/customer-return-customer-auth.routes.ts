import { randomBytes } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { CUSTOMER_RETURNS_API, CUSTOMER_RETURNS_PAGE, RETURN_CUSTOMER_SESSION_HEADER, customerReturnSessionStateSchema } from "@shared/returns/customer-return-access.contract";
import { CustomerReturnCustomerAccessError, RETURN_CUSTOMER_ENCODED_PROOF_MAX_LENGTH, type CustomerReturnCustomerSession } from "../../application/customer-return-customer-auth.service";
import { requireCustomerReturnPreviewAccess } from "../../application/customer-return-preview-access";
import { readCurrentPreviewIdentity } from "../../infrastructure/customer-return-preview-identity";
import { createCustomerReturnCustomerAuth } from "../../infrastructure/customer-return-customer-auth.composition";

declare module "express-session" {
  interface SessionData {
    customerReturnSession?: CustomerReturnCustomerSession;
    returnLoginBrowserKey?: string;
  }
}
export interface CustomerReturnCustomerAuthRouteDependencies {
  context?: typeof createCustomerReturnCustomerAuth;
  privateTesting?: () => boolean;
  authorizeStaff?: (req: Request) => Promise<void>;
}
export const returnCustomerPrivateTesting = () => process.env.CUSTOMER_RETURN_CUSTOMER_ACCESS !== "enabled";
export function returnCustomerPrivateResponse(res: Response) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Robots-Tag", "noindex, nofollow");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.vary("Cookie");
}
export function returnCustomerError(res: Response, error: unknown) {
  const known = error instanceof Error && "code" in error && "status" in error
    && typeof error.code === "string" && typeof error.status === "number";
  const code = known ? String(error.code) : error instanceof z.ZodError ? "RETURN_CUSTOMER_INPUT_INVALID" : "RETURN_CUSTOMER_UNAVAILABLE";
  const status = known ? Number(error.status) : error instanceof z.ZodError ? 400 : 503;
  // No token, signed proxy query, customer details, provider URL or raw exception.
  console.error(JSON.stringify({ event: "customer_return_request_failed", code }));
  res.status(status).json({ error: { code, message: known ? error.message : status === 400
    ? "The return request is invalid." : "Returns are temporarily unavailable. Please try again." } });
}
export function requireReturnCustomerCommand(req: Request, publicOrigin: string) {
  if (req.get("Origin") !== publicOrigin || req.get("X-Return-Command") !== "1" || !req.is("application/json")) {
    throw new CustomerReturnCustomerAccessError("RETURN_CUSTOMER_COMMAND_FORBIDDEN", "Open returns in your store account and try again.", 403);
  }
}
export function requireReturnCustomerSession(req: Request, principal: CustomerReturnCustomerSession) {
  // Cookies can change when another tab signs in. Never execute an old tab's
  // saved intent against the newly authenticated customer's ambient session.
  if (req.get(RETURN_CUSTOMER_SESSION_HEADER) !== principal.sessionKey) {
    throw new CustomerReturnCustomerAccessError("RETURN_CUSTOMER_SESSION_CHANGED", "Your signed-in account changed. Check your sign-in before continuing.", 401);
  }
}
const save = (req: Request) => new Promise<void>((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));

/** Separate customer surface; existing administrator routes retain their gates. */
export function registerCustomerReturnCustomerAuthRoutes(app: Express, dependencies: CustomerReturnCustomerAuthRouteDependencies = {}) {
  const context = dependencies.context ?? createCustomerReturnCustomerAuth;
  const isPrivate = dependencies.privateTesting ?? returnCustomerPrivateTesting;
  const authorizeStaff = dependencies.authorizeStaff ?? (req => requireCustomerReturnPreviewAccess(req.session?.user?.id, readCurrentPreviewIdentity));

  // A cross-site form cannot carry a SameSite=Lax cookie. This response ONLY
  // relays bounded Shopify proof into a same-origin request; it grants no identity.
  app.post(`${CUSTOMER_RETURNS_PAGE}/callback`, (req, res) => {
    returnCustomerPrivateResponse(res);
    const parsed = z.object({ proof: z.string().min(1).max(RETURN_CUSTOMER_ENCODED_PROOF_MAX_LENGTH).regex(/^[A-Za-z0-9_-]+$/) }).strict().safeParse(req.body);
    if (!parsed.success) { returnCustomerError(res, new z.ZodError([])); return; }
    const nonce = randomBytes(24).toString("base64");
    res.setHeader("Content-Security-Policy", `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`);
    const proof = JSON.stringify(parsed.data.proof);
    res.type("html").send(`<!doctype html><html lang="en"><meta charset="utf-8"><title>Signing in to returns</title><body><p id="status" role="status">Signing in to returns…</p><script nonce="${nonce}">fetch(${JSON.stringify(`${CUSTOMER_RETURNS_API}/session`)},{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json","X-Return-Command":"1"},body:JSON.stringify({proof:${proof}})}).then(async response=>{if(!response.ok)throw new Error();location.replace(${JSON.stringify(CUSTOMER_RETURNS_PAGE)})}).catch(()=>{document.getElementById("status").textContent="Sign-in could not be completed. Close this page and start again from your store account."});</script></body></html>`);
  });
  app.use([CUSTOMER_RETURNS_API, CUSTOMER_RETURNS_PAGE], async (req, res, next) => {
    returnCustomerPrivateResponse(res);
    try { if (isPrivate()) await authorizeStaff(req); next(); } catch (error) { returnCustomerError(res, error); }
  });
  app.use([CUSTOMER_RETURNS_API, CUSTOMER_RETURNS_PAGE], (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    returnCustomerPrivateResponse(res); returnCustomerError(res, error);
  });
  app.get(`${CUSTOMER_RETURNS_PAGE}/start`, async (req, res) => {
    try {
      const input = z.object({ shop: z.string().max(255).optional() }).strict().parse(req.query);
      const { auth } = await context();
      req.session.returnLoginBrowserKey = randomBytes(32).toString("base64url");
      req.session.cookie.secure = true;
      // Starting a new customer login ends previous customer scope immediately.
      delete req.session.customerReturnSession;
      await save(req);
      const destination = await auth.start(req.session.returnLoginBrowserKey, input.shop);
      res.redirect(303, destination);
    } catch (error) { returnCustomerError(res, error); }
  });
  app.get(`${CUSTOMER_RETURNS_API}/session`, async (req, res) => {
    try {
      z.object({}).strict().parse(req.query);
      const { auth } = await context();
      let session: CustomerReturnCustomerSession | null = null;
      try { session = await auth.principal(req.session.customerReturnSession); }
      catch (error) { if (!(error instanceof CustomerReturnCustomerAccessError) || error.status !== 401) throw error; }
      res.json(customerReturnSessionStateSchema.parse({ authenticated: session !== null, privateTesting: isPrivate(), sessionKey: session?.sessionKey ?? null }));
    } catch (error) { returnCustomerError(res, error); }
  });
  app.post(`${CUSTOMER_RETURNS_API}/session`, async (req, res) => {
    try {
      const { config, auth } = await context();
      requireReturnCustomerCommand(req, config.publicOrigin);
      z.object({}).strict().parse(req.query);
      const { proof } = z.object({ proof: z.string().min(1).max(RETURN_CUSTOMER_ENCODED_PROOF_MAX_LENGTH).regex(/^[A-Za-z0-9_-]+$/) }).strict().parse(req.body);
      const session = await auth.authenticate(req.session.returnLoginBrowserKey ?? "", proof);
      const user = req.session.user;
      await new Promise<void>((resolve, reject) => req.session.regenerate(error => error ? reject(error) : resolve()));
      if (user) req.session.user = user;
      req.session.customerReturnSession = session;
      req.session.cookie.secure = true;
      await save(req);
      console.info(JSON.stringify({ event: "customer_return_sign_in", channelId: session.channelId, actor: `shopify:${session.channelId}:${session.externalCustomerId}` }));
      res.json(customerReturnSessionStateSchema.parse({ authenticated: true, privateTesting: isPrivate(), sessionKey: session.sessionKey }));
    } catch (error) { returnCustomerError(res, error); }
  });
  app.post(`${CUSTOMER_RETURNS_API}/logout`, async (req, res) => {
    try {
      const { config, auth } = await context(); requireReturnCustomerCommand(req, config.publicOrigin);
      requireReturnCustomerSession(req, await auth.principal(req.session.customerReturnSession));
      z.object({}).strict().parse(req.body); z.object({}).strict().parse(req.query);
      delete req.session.customerReturnSession; delete req.session.returnLoginBrowserKey;
      await save(req); res.json({ ok: true });
    } catch (error) { returnCustomerError(res, error); }
  });
}
