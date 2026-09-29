import type { Express, Request, Response } from "express";
import { z } from "zod";
import { rateLimit } from "express-rate-limit";
import { CUSTOMER_RETURNS_API, CUSTOMER_RETURNS_PAGE } from "@shared/returns/customer-return-access.contract";
import { createCustomerReturnCustomerAuth } from "../../infrastructure/customer-return-customer-auth.composition";
import { createCustomerReturnCustomerServices } from "../../infrastructure/customer-return-customer.composition";
import { registerCustomerReturnCustomerAuthRoutes, requireReturnCustomerCommand, requireReturnCustomerSession, returnCustomerError, returnCustomerPrivateResponse,
  type CustomerReturnCustomerAuthRouteDependencies } from "./customer-return-customer-auth.routes";

export interface CustomerReturnCustomerRouteDependencies extends CustomerReturnCustomerAuthRouteDependencies {
  services?: typeof createCustomerReturnCustomerServices;
}
const id = (raw: unknown) => z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(z.number().int().positive().safe()).parse(raw);
const cursor = (raw: unknown) => z.object({ before: z.string().optional() }).strict().parse(raw).before;
export function registerCustomerReturnCustomerRoutes(app: Express, dependencies: CustomerReturnCustomerRouteDependencies = {}) {
  const context = dependencies.context ?? createCustomerReturnCustomerAuth;
  const services = dependencies.services ?? createCustomerReturnCustomerServices;
  app.use([CUSTOMER_RETURNS_API, CUSTOMER_RETURNS_PAGE], (_req, res, next) => { returnCustomerPrivateResponse(res); next(); });
  app.use([CUSTOMER_RETURNS_API, CUSTOMER_RETURNS_PAGE], rateLimit({ windowMs: 60_000, limit: 60,
    standardHeaders: "draft-7", legacyHeaders: false,
    message: { error: { code: "RETURN_CUSTOMER_RATE_LIMITED", message: "Please wait a moment before trying again." } } }));
  registerCustomerReturnCustomerAuthRoutes(app, dependencies);
  type Services = Awaited<ReturnType<typeof createCustomerReturnCustomerServices>>;
  const handle = (mutate: boolean, run: (req: Request, value: Services) => Promise<unknown>) => async (req: Request, res: Response) => {
    try {
      const { auth, config } = await context();
      const principal = await auth.principal(req.session.customerReturnSession);
      requireReturnCustomerSession(req, principal);
      if (mutate) requireReturnCustomerCommand(req, config.publicOrigin);
      const value = await run(req, await services(principal));
      if (value instanceof Uint8Array) {
        res.type("application/pdf").setHeader("Content-Disposition", `attachment; filename="return-${id(req.params.authorizationId)}-box-${id(req.params.parcelId)}.pdf"`);
        res.send(Buffer.from(value));
      } else res.json(value);
    } catch (error) { returnCustomerError(res, error); }
  };
  const noQuery = (req: Request) => z.object({}).strict().parse(req.query);
  const emptyCommand = (req: Request) => { noQuery(req); z.object({}).strict().parse(req.body); };
  app.get(`${CUSTOMER_RETURNS_API}/orders`, handle(false, (req, value) => {
    const before = cursor(req.query);
    return value.orders.list(before === undefined ? {} : { beforeOmsOrderId: id(before) });
  }));
  app.get(`${CUSTOMER_RETURNS_API}/orders/:omsOrderId`, handle(false, (req, value) => { noQuery(req); return value.orders.order(id(req.params.omsOrderId)); }));
  app.post(`${CUSTOMER_RETURNS_API}/orders/:omsOrderId/review`, handle(true, (req, value) => {
    noQuery(req); return value.orders.review(id(req.params.omsOrderId), req.body);
  }));
  app.post(`${CUSTOMER_RETURNS_API}/orders/:omsOrderId/returns`, handle(true, (req, value) => {
    noQuery(req); return value.operations.submit(id(req.params.omsOrderId), req.body);
  }));
  app.get(`${CUSTOMER_RETURNS_API}/returns`, handle(false, (req, value) => {
    const before = cursor(req.query);
    return value.operations.listReturns(before === undefined ? {} : { beforeAuthorizationId: id(before) });
  }));
  const commandPath = `${CUSTOMER_RETURNS_API}/commands/:key`;
  app.get(commandPath, handle(false, (req, value) => { noQuery(req); return value.operations.submissionStatus(req.params.key); }));
  app.post(`${commandPath}/resume`, handle(true, (req, value) => { emptyCommand(req); return value.operations.resumeSubmission(req.params.key); }));
  const returnPath = `${CUSTOMER_RETURNS_API}/returns/:authorizationId`;
  app.get(returnPath, handle(false, (req, value) => { noQuery(req); return value.operations.labelStatus(id(req.params.authorizationId)); }));
  app.post(`${returnPath}/progress`, handle(true, (req, value) => { emptyCommand(req); return value.operations.progressLabels(id(req.params.authorizationId)); }));
  app.get(`${returnPath}/parcels/:parcelId/download`, handle(false, async (req, value) => {
    noQuery(req);
    const artifact = await value.operations.artifact(id(req.params.authorizationId), id(req.params.parcelId));
    return value.download(artifact.downloadUrl);
  }));
  app.use(CUSTOMER_RETURNS_API, (_req, res) => res.status(404).json({ error: { code: "RETURN_CUSTOMER_NOT_FOUND", message: "This return page is unavailable." } }));
  app.use(CUSTOMER_RETURNS_PAGE, (req, res, next) => {
    if ((req.method === "GET" || req.method === "HEAD") && (req.path === "/" || req.path === "")) { next(); return; }
    res.status(404).json({ error: { code: "RETURN_CUSTOMER_NOT_FOUND", message: "This return page is unavailable." } });
  });
}
