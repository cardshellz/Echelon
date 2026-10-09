import type { Express, Request, Response } from "express";
import { z } from "zod";
import {
  ORDER_EDIT_API,
  orderEditConnectionSchema,
  orderEditOperationSchema,
  orderEditOrdersSchema,
  orderEditOrderSchema,
  orderEditStateSchema,
  orderEditVariantsSchema,
  orderEditQuoteInputSchema,
  orderEditSettingsInputSchema,
} from "@shared/order-edits/order-edit.contract";
import type { OrderEditService } from "../application/order-edit.service";
import {
  orderEditCatalogCategoriesInputSchema,
  orderEditCatalogCategoriesSchema,
  orderEditCatalogProductsInputSchema,
  orderEditCatalogProductsSchema,
  orderEditCatalogVariantsInputSchema,
  orderEditCatalogVariantsSchema,
} from "@shared/order-edits/order-edit-catalog";
import { OrderEditError } from "../domain/order-edit-error";
import { OrderEditProviderError } from "../application/order-edit-provider";
import {
  orderEditPreviewInputSchema,
  orderEditPreviewScopeSchema,
  orderEditPreviewSchema,
  orderEditPreviewWarmSchema,
} from "@shared/order-edits/order-edit-preview";

const positiveId = z.coerce.number().int().positive().safe();
const operationId = z.string().uuid();
const searchQuery = z
  .object({
    connectionId: positiveId,
    search: z.string().trim().min(1).max(100),
  })
  .strict();
const emptyBody = z.object({}).strict();

export interface OrderEditRouteDependencies {
  service: OrderEditService;
  hasPermission: (
    actorId: string,
    resource: string,
    action: string,
  ) => Promise<boolean>;
  report: (event: { code: string; method: string; route: string }) => void;
}

/** Staff session + current grants only. A storefront/customer session is never authority here. */
export function registerOrderEditRoutes(
  app: Express,
  dependencies: OrderEditRouteDependencies,
): void {
  const { service } = dependencies;
  const handle =
    (
      settings: boolean,
      work: (req: Request, res: Response, actorId: string) => Promise<void>,
      calculationOnly = false,
    ) =>
    async (req: Request, res: Response): Promise<void> => {
      res.setHeader("Cache-Control", "no-store");
      try {
        const actorId = req.session?.user?.id;
        if (!actorId)
          throw new OrderEditError(
            "ORDER_EDIT_AUTH_REQUIRED",
            "Staff sign-in is required.",
            401,
          );
        if (
          !(await dependencies.hasPermission(actorId, "orders", "edit")) ||
          (settings &&
            !(await dependencies.hasPermission(actorId, "settings", "edit")))
        ) {
          throw new OrderEditError(
            "ORDER_EDIT_PERMISSION_REQUIRED",
            "Order editing permission is required.",
            403,
          );
        }
        if (req.method !== "GET") {
          // Host comes from the request, never from a client-supplied forwarded host.
          // Browser JSON mutations must include their same-origin Origin header.
          const origin = req.get("Origin");
          let sameOrigin = false;
          try {
            sameOrigin =
              !!origin &&
              new URL(origin).origin === `${req.protocol}://${req.get("host")}`;
          } catch {
            /* Deny malformed origins. */
          }
          if (!sameOrigin || !req.is("application/json")) {
            throw new OrderEditError(
              "ORDER_EDIT_ORIGIN_REJECTED",
              "Open the order editor in this application before making changes.",
              403,
            );
          }
          if (!calculationOnly) operationId.parse(req.get("Idempotency-Key"));
        }
        await work(req, res, actorId);
      } catch (error) {
        const validation = error instanceof z.ZodError;
        const known =
          error instanceof OrderEditError ||
          error instanceof OrderEditProviderError;
        const code = validation
          ? "ORDER_EDIT_INVALID_REQUEST"
          : known
            ? error.code
            : "ORDER_EDIT_UNAVAILABLE";
        dependencies.report({
          code,
          method: req.method,
          route: req.route?.path ?? ORDER_EDIT_API,
        });
        res
          .status(
            validation
              ? 400
              : error instanceof OrderEditError
                ? error.status
                : known
                  ? 409
                  : 503,
          )
          .json({
            error: {
              code,
              message: validation
                ? "The order edit request is invalid."
                : known
                  ? error.message
                  : "The order editor is unavailable. Check the saved operation before retrying.",
            },
          });
      }
    };
  app.get(
    `${ORDER_EDIT_API}/state`,
    handle(false, async (_req, res) => {
      res.json(orderEditStateSchema.parse(await service.state()));
    }),
  );
  app.put(
    `${ORDER_EDIT_API}/settings/:connectionId`,
    handle(true, async (req, res, actor) => {
      res.json(
        orderEditConnectionSchema.parse(
          await service.settings(
            positiveId.parse(req.params.connectionId),
            orderEditSettingsInputSchema.parse(req.body),
            actor,
          ),
        ),
      );
    }),
  );
  app.get(
    `${ORDER_EDIT_API}/orders`,
    handle(false, async (req, res) => {
      const query = searchQuery.parse(req.query);
      res.json(
        orderEditOrdersSchema.parse(
          await service.orders(query.connectionId, query.search),
        ),
      );
    }),
  );
  app.get(
    `${ORDER_EDIT_API}/orders/:omsOrderId`,
    handle(false, async (req, res) => {
      const query = z
        .object({ connectionId: positiveId })
        .strict()
        .parse(req.query);
      res.json(
        orderEditOrderSchema.parse(
          await service.order(
            query.connectionId,
            positiveId.parse(req.params.omsOrderId),
          ),
        ),
      );
    }),
  );
  app.get(
    `${ORDER_EDIT_API}/variants`,
    handle(false, async (req, res) => {
      const query = searchQuery.parse(req.query);
      res.json(
        orderEditVariantsSchema.parse(
          await service.variants(query.connectionId, query.search),
        ),
      );
    }),
  );
  app.get(
    `${ORDER_EDIT_API}/catalog/categories`,
    handle(false, async (req, res) => {
      const { connectionId, ...input } = orderEditCatalogCategoriesInputSchema
        .extend({ connectionId: positiveId })
        .parse(req.query);
      res.json(
        orderEditCatalogCategoriesSchema.parse(
          await service.catalogCategories(connectionId, input),
        ),
      );
    }),
  );
  app.get(
    `${ORDER_EDIT_API}/catalog/products`,
    handle(false, async (req, res) => {
      const { connectionId, ...input } = orderEditCatalogProductsInputSchema
        .extend({ connectionId: positiveId })
        .parse(req.query);
      res.json(
        orderEditCatalogProductsSchema.parse(
          await service.catalogProducts(connectionId, input),
        ),
      );
    }),
  );
  app.get(
    `${ORDER_EDIT_API}/catalog/variants`,
    handle(false, async (req, res) => {
      const { connectionId, ...input } = orderEditCatalogVariantsInputSchema
        .extend({ connectionId: positiveId })
        .parse(req.query);
      res.json(
        orderEditCatalogVariantsSchema.parse(
          await service.catalogVariants(connectionId, input),
        ),
      );
    }),
  );
  app.post(
    `${ORDER_EDIT_API}/previews/warm`,
    handle(
      false,
      async (req, res, actor) => {
        res.json(
          orderEditPreviewWarmSchema.parse(
            await service.warmPreview(
              orderEditPreviewScopeSchema.parse(req.body),
              actor,
            ),
          ),
        );
      },
      true,
    ),
  );
  app.post(
    `${ORDER_EDIT_API}/previews`,
    handle(
      false,
      async (req, res, actor) => {
        res.json(
          orderEditPreviewSchema.parse(
            await service.preview(
              orderEditPreviewInputSchema.parse(req.body),
              actor,
            ),
          ),
        );
      },
      true,
    ),
  );
  app.post(
    `${ORDER_EDIT_API}/quotes`,
    handle(false, async (req, res, actor) => {
      const input = orderEditQuoteInputSchema.parse(req.body);
      if (input.requestKey !== req.get("Idempotency-Key"))
        throw new OrderEditError(
          "ORDER_EDIT_KEY_MISMATCH",
          "The quote request key does not match.",
          400,
        );
      res.json(
        orderEditOperationSchema.parse(await service.quote(input, actor)),
      );
    }),
  );
  app.get(
    `${ORDER_EDIT_API}/operations/:operationId`,
    handle(false, async (req, res) => {
      res.json(
        orderEditOperationSchema.parse(
          await service.get(operationId.parse(req.params.operationId)),
        ),
      );
    }),
  );
  for (const action of ["commit", "reconcile", "abandon"] as const) {
    app.post(
      `${ORDER_EDIT_API}/operations/:operationId/${action}`,
      handle(false, async (req, res, actor) => {
        emptyBody.parse(req.body);
        const id = operationId.parse(req.params.operationId);
        const result =
          action === "commit"
            ? await service.commit(
                id,
                operationId.parse(req.get("Idempotency-Key")),
                actor,
              )
            : await service[action](id, actor);
        res.json(orderEditOperationSchema.parse(result));
      }),
    );
  }
}
