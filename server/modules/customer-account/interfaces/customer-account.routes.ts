import type { Express, Response } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import {
  CUSTOMER_ACCOUNT_COMMAND_HEADER,
  CUSTOMER_ACCOUNT_PROXY_API,
  customerAccountBootstrapSchema,
  customerAccountRequestSchema,
  type CustomerAccountRequest,
} from "@shared/customer-account/customer-account.contract";
import {
  orderEditOrderSchema,
  orderEditOperationSchema,
} from "@shared/order-edits/order-edit.contract";
import {
  orderEditPreviewSchema,
  orderEditPreviewWarmSchema,
} from "@shared/order-edits/order-edit-preview";
import {
  orderEditCatalogCategoriesSchema,
  orderEditCatalogProductsSchema,
  orderEditCatalogVariantsSchema,
} from "@shared/order-edits/order-edit-catalog";
import {
  CustomerReturnCustomerAccessError,
  type CustomerReturnCustomerSession,
} from "../../returns/application/customer-return-customer-auth.service";
import { createCustomerReturnCustomerAuth } from "../../returns/infrastructure/customer-return-customer-auth.composition";
import {
  returnCustomerError,
  returnCustomerPrivateResponse,
} from "../../returns/interfaces/http/customer-return-customer-auth.routes";
import { OrderEditError } from "../../order-edits/domain/order-edit-error";
import { OrderEditProviderError } from "../../order-edits/application/order-edit-provider";
import {
  CustomerAccountOriginAccessError,
  readCustomerAccountStagingConfig,
  requireCustomerAccountStaging,
  type CustomerAccountOriginContext,
  type CustomerAccountStagingConfig,
} from "../domain/customer-account-staging";
import type { customerAccountServices } from "../infrastructure/customer-account.composition";
import { ORDER_EDIT_PRICING_DISPLAY_VERSION } from "@shared/order-edits/order-edit-financials";
import { orderEditResponsePresentation } from "../../order-edits/application/order-edit-response-presentation";

type Services = ReturnType<ReturnType<typeof customerAccountServices>>;
export interface CustomerAccountRouteDependencies {
  services: (principal: CustomerReturnCustomerSession) => Services;
  context?: typeof createCustomerReturnCustomerAuth;
  staging?: () => CustomerAccountStagingConfig | null;
  report: (event: {
    code: string;
    path: string;
    context?: CustomerAccountOriginContext;
  }) => void;
}
const id = z.coerce.number().int().positive().safe();
const empty = z.object({}).strict();
const connectionQuery = z.object({ connectionId: id }).strict();
type VerifiedAccountRequest = {
  input: CustomerAccountRequest;
  principal: CustomerReturnCustomerSession;
};
const ACCOUNT_REQUESTS_PER_MINUTE = 90;

/** A dedicated, gated storefront surface. It neither relaxes the existing staff
 * APIs nor enables the public returns portal. All URL parameters stay in JSON:
 * the canonical Shopify signature verifier's strict query allowlist is unchanged. */
export function registerCustomerAccountRoutes(
  app: Express,
  dependencies: CustomerAccountRouteDependencies,
): void {
  const context = dependencies.context ?? createCustomerReturnCustomerAuth;
  app.use(CUSTOMER_ACCOUNT_PROXY_API, (_req, res, next) => {
    returnCustomerPrivateResponse(res);
    next();
  });
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: ACCOUNT_REQUESTS_PER_MINUTE,
    standardHeaders: "draft-7",
    legacyHeaders: false,
    // Shopify's transport IP is shared by shoppers. This key is used only
    // after independently authenticating and approving the signed customer.
    keyGenerator: (_req, res) => {
      const { principal } = res.locals
        .customerAccount as VerifiedAccountRequest;
      return `${principal.channelId}:${principal.externalCustomerId}`;
    },
    message: {
      error: {
        code: "CUSTOMER_ACCOUNT_RATE_LIMITED",
        message: "Please wait a moment before trying again.",
      },
    },
  });
  const failed = (res: Response, error: unknown, path: string) => {
    const known =
      error instanceof OrderEditError ||
      error instanceof OrderEditProviderError;
    const code =
      error instanceof z.ZodError
        ? "CUSTOMER_ACCOUNT_INVALID_REQUEST"
        : known || error instanceof CustomerReturnCustomerAccessError
          ? error.code
          : "CUSTOMER_ACCOUNT_REQUEST_FAILED";
    dependencies.report({
      code,
      path,
      ...(error instanceof CustomerAccountOriginAccessError
        ? { context: error.context }
        : {}),
    });
    if (known)
      res
        .status(error instanceof OrderEditError ? error.status : 409)
        .json({ error: { code: error.code, message: error.message } });
    else returnCustomerError(res, error);
  };
  app.post(
    CUSTOMER_ACCOUNT_PROXY_API,
    async (req, res, next) => {
      let path = "/account";
      try {
        if (!req.is("application/json"))
          throw new CustomerReturnCustomerAccessError(
            "CUSTOMER_ACCOUNT_INVALID_REQUEST",
            "The account request is invalid.",
            400,
          );
        const input = customerAccountRequestSchema.parse(req.body);
        path = input.path;
        const { auth, config } = await context();
        const principal = await auth.storefrontPrincipal(
          req.originalUrl.split("?")[1] ?? "",
        );
        requireCustomerAccountStaging({
          config: (
            dependencies.staging ??
            (() =>
              readCustomerAccountStagingConfig(
                process.env.CUSTOMER_ACCOUNT_STAGING_CONFIG,
              ))
          )(),
          authConfig: config,
          principal,
          themeId: input.themeId,
          expectedCustomerId: input.expectedCustomerId,
          origin: req.get("Origin"),
          commandHeader: req.get(CUSTOMER_ACCOUNT_COMMAND_HEADER),
          sessionKey: input.sessionKey,
        });
        if (
          input.path !== "/account/bootstrap" &&
          input.sessionKey !== principal.sessionKey
        ) {
          throw new CustomerReturnCustomerAccessError(
            "CUSTOMER_ACCOUNT_IDENTITY_CHANGED",
            "Reload your account page before continuing.",
            401,
          );
        }
        res.locals.customerAccount = {
          input,
          principal,
        } satisfies VerifiedAccountRequest;
        next();
      } catch (error) {
        failed(res, error, path);
      }
    },
    limiter,
    async (_req, res) => {
      const { input, principal } = res.locals
        .customerAccount as VerifiedAccountRequest;
      try {
        const result = await dispatch(
          input,
          principal,
          dependencies.services(principal),
        );
        if (result instanceof Uint8Array) {
          res
            .type("application/pdf")
            .setHeader(
              "Content-Disposition",
              'attachment; filename="return-label.pdf"',
            );
          res.send(Buffer.from(result));
        } else res.json(result);
      } catch (error) {
        failed(res, error, input.path);
      }
    },
  );
  app.use(CUSTOMER_ACCOUNT_PROXY_API, (_req, res) => unavailable(res));
}

async function dispatch(
  input: CustomerAccountRequest,
  principal: CustomerReturnCustomerSession,
  services: Services,
): Promise<unknown> {
  const { path, method, body } = input;
  const { pricingDisplayVersion, ...orderQuery } = input.query;
  const query = path.startsWith("/order-edits/") ? orderQuery : input.query;
  const pricingDisplay =
    path.startsWith("/order-edits/") &&
    z
      .literal(ORDER_EDIT_PRICING_DISPLAY_VERSION)
      .optional()
      .parse(pricingDisplayVersion) === ORDER_EDIT_PRICING_DISPLAY_VERSION;
  const read = method === "GET";
  if (read && body !== undefined) empty.parse(body);
  if (path === "/account/bootstrap" && read) {
    empty.parse(query);
    return customerAccountBootstrapSchema.parse({
      session: {
        authenticated: true,
        privateTesting: true,
        sessionKey: principal.sessionKey,
      },
      connection: await services.edits.connection(),
    });
  }
  if (path === "/account/resolve" && !read) {
    empty.parse(query);
    return services.edits.resolve(body);
  }
  const order = /^\/order-edits\/orders\/([1-9][0-9]*)$/.exec(path);
  if (order && read) {
    const params = connectionQuery
      .extend({ codeEntryVersion: z.literal("v1").optional() })
      .parse(query);
    return orderEditResponsePresentation(
      orderEditOrderSchema.parse(
        await services.edits.order(
          params.connectionId,
          id.parse(order[1]),
          params.codeEntryVersion,
        ),
      ),
      pricingDisplay,
    );
  }
  const catalog =
    /^\/order-edits\/catalog\/(categories|products|variants)$/.exec(path);
  if (catalog && read) {
    const { connectionId, ...fields } = query;
    const connection = id.parse(connectionId);
    if (catalog[1] === "categories")
      return orderEditCatalogCategoriesSchema.parse(
        await services.edits.catalogCategories(connection, fields),
      );
    if (catalog[1] === "products")
      return orderEditCatalogProductsSchema.parse(
        await services.edits.catalogProducts(connection, fields),
      );
    return orderEditCatalogVariantsSchema.parse(
      await services.edits.catalogVariants(connection, fields),
    );
  }
  if (path === "/order-edits/previews/warm" && !read) {
    empty.parse(query);
    return orderEditPreviewWarmSchema.parse(
      await services.edits.warmPreview(body),
    );
  }
  if (path === "/order-edits/previews" && !read) {
    empty.parse(query);
    return orderEditResponsePresentation(
      orderEditPreviewSchema.parse(await services.edits.preview(body)),
      pricingDisplay,
    );
  }
  if (path === "/order-edits/quotes" && !read) {
    empty.parse(query);
    return orderEditResponsePresentation(
      orderEditOperationSchema.parse(
        await services.edits.quote(body, commandKey(input)),
      ),
      pricingDisplay,
    );
  }
  const operation =
    /^\/order-edits\/operations\/([a-f0-9-]+)(?:\/(commit|reconcile|abandon))?$/.exec(
      path,
    );
  if (operation) {
    const operationId = z.string().uuid().parse(operation[1]);
    if (!operation[2] && read) {
      const params = z
        .object({ codeEntryVersion: z.literal("v1").optional() })
        .strict()
        .parse(query);
      return orderEditResponsePresentation(
        orderEditOperationSchema.parse(
          await services.edits.operation(operationId, params.codeEntryVersion),
        ),
        pricingDisplay,
      );
    }
    empty.parse(query);
    if (operation[2] && !read) {
      empty.parse(body);
      return orderEditResponsePresentation(
        orderEditOperationSchema.parse(
          await services.edits.progress(
            operationId,
            z.enum(["commit", "reconcile", "abandon"]).parse(operation[2]),
            commandKey(input),
          ),
        ),
        pricingDisplay,
      );
    }
  }
  if (!path.startsWith("/returns/")) throw notFound();
  const returns = await services.returns();
  const returnOrder =
    /^\/returns\/orders\/([1-9][0-9]*)(?:\/(review|returns))?$/.exec(path);
  if (returnOrder) {
    empty.parse(query);
    const omsOrderId = id.parse(returnOrder[1]);
    if (!returnOrder[2] && read) return returns.orders.order(omsOrderId);
    if (!read && returnOrder[2] === "review")
      return returns.orders.review(omsOrderId, body);
    if (!read && returnOrder[2] === "returns")
      return returns.operations.submit(omsOrderId, body);
  }
  if (path === "/returns/returns" && read) {
    const parsed = z.object({ before: id.optional() }).strict().parse(query);
    return returns.operations.listReturns(
      parsed.before ? { beforeAuthorizationId: parsed.before } : {},
    );
  }
  const command = /^\/returns\/commands\/([a-f0-9-]+)(?:\/(resume))?$/.exec(
    path,
  );
  if (command) {
    empty.parse(query);
    const key = z.string().uuid().parse(command[1]);
    if (!command[2] && read) return returns.operations.submissionStatus(key);
    if (command[2] && !read) {
      empty.parse(body);
      return returns.operations.resumeSubmission(key);
    }
  }
  const label =
    /^\/returns\/returns\/([1-9][0-9]*)(?:\/(progress)|\/parcels\/([1-9][0-9]*)\/download)?$/.exec(
      path,
    );
  if (label) {
    empty.parse(query);
    const authorizationId = id.parse(label[1]);
    if (label[3] && read) {
      const artifact = await returns.operations.artifact(
        authorizationId,
        id.parse(label[3]),
      );
      return returns.download(artifact.downloadUrl);
    }
    if (label[2] && !read) {
      empty.parse(body);
      return returns.operations.progressLabels(authorizationId);
    }
    if (!label[2] && !label[3] && read)
      return returns.operations.labelStatus(authorizationId);
  }
  throw notFound();
}
function commandKey(input: CustomerAccountRequest): string {
  return z.string().uuid().parse(input.commandKey);
}
function notFound() {
  return new CustomerReturnCustomerAccessError(
    "CUSTOMER_ACCOUNT_NOT_FOUND",
    "This account action is unavailable.",
    404,
  );
}
function unavailable(res: Response) {
  res.status(404).json({
    error: {
      code: "CUSTOMER_ACCOUNT_NOT_FOUND",
      message: "This account action is unavailable.",
    },
  });
}
