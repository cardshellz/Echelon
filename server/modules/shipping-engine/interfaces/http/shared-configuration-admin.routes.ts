import type { Express, Request, Response } from "express";
import { ZodError } from "zod";
import { requirePermission } from "../../../../routes/middleware";
import { SharedShippingConfigurationService } from "../../application/shared-configuration.service";
import { ShippingConfigurationError } from "../../infrastructure/shared-configuration.repository";
import { SharedShippingConfigurationRepository } from "../../infrastructure/shared-configuration.repository";
import { readDropshipShippingCutoverConfig } from "../../../dropship/application/dropship-shipping-cutover-policy";
import { ChannelPackagingService } from "../../application/channel-packaging.service";
import { ChannelPackagingRepository } from "../../infrastructure/channel-packaging.repository";
import { resolveDropshipPackagingChannel } from "../../../dropship/infrastructure/dropship-packaging-channel";
import { pool } from "../../../../db";

export function registerSharedConfigurationAdminRoutes(
  app: Express,
  service = new SharedShippingConfigurationService(
    new SharedShippingConfigurationRepository(),
  ),
  packagingPolicies = new ChannelPackagingService(
    new ChannelPackagingRepository(),
    undefined,
    () => resolveDropshipPackagingChannel(pool),
  ),
): void {
  const run =
    (operation: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response) => {
      try {
        res.json(await operation(req));
      } catch (error) {
        if (error instanceof ZodError) {
          res.status(400).json({
            error: {
              code: "SHIPPING_CONFIG_INVALID",
              message: "Check the configuration fields.",
              issues: error.issues,
            },
          });
          return;
        }
        if (error instanceof ShippingConfigurationError) {
          res
            .status(error.status)
            .json({ error: { code: error.code, message: error.message } });
          return;
        }
        const code = (error as { code?: string })?.code;
        if (code === "23505" || code === "23503") {
          res.status(409).json({
            error: {
              code: "SHIPPING_CONFIG_CONFLICT",
              message:
                "The name is already used, or a referenced configuration no longer exists. Reload and try again.",
            },
          });
          return;
        }
        console.error(
          JSON.stringify({
            event: "shipping.configuration.failed",
            path: req.path,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        res.status(500).json({
          error: {
            code: "SHIPPING_CONFIG_FAILED",
            message:
              "Shipping configuration could not be saved. Try again with the same request.",
          },
        });
      }
    };
  const actor = (req: Request): string => {
    const id = (req.session?.user as { id?: string | number } | undefined)?.id;
    if (id === undefined)
      throw new ShippingConfigurationError(
        "SHIPPING_ACTOR_REQUIRED",
        "Sign in before changing shipping configuration.",
        401,
      );
    return String(id);
  };
  const configuredChannelId = (): number | null => {
    const text = process.env.DROPSHIP_OMS_CHANNEL_ID?.trim();
    if (!text) return null;
    const value = Number(text);
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new ShippingConfigurationError(
        "SHIPPING_CHANNEL_INVALID",
        "Dropship channel binding is invalid.",
        500,
      );
    return value;
  };
  app.get(
    "/api/shipping/admin/packaging-policies",
    requirePermission("settings", "view"),
    run(() => packagingPolicies.overview()),
  );
  app.put(
    "/api/shipping/admin/catalog-boxes/branding",
    requirePermission("settings", "edit"),
    run((req) => packagingPolicies.bulkBranding(req.body, actor(req))),
  );
  app.put(
    "/api/shipping/admin/warehouse-packaging/availability",
    requirePermission("settings", "edit"),
    run((req) => packagingPolicies.saveAvailability(req.body, actor(req))),
  );
  app.put(
    "/api/shipping/admin/warehouse-packaging/suites",
    requirePermission("settings", "edit"),
    run((req) => packagingPolicies.assignWarehouseSuites(req.body, actor(req))),
  );
  app.put(
    "/api/shipping/admin/packaging-policies",
    requirePermission("settings", "edit"),
    run((req) => packagingPolicies.savePolicy(req.body, actor(req))),
  );
  app.put(
    "/api/shipping/admin/catalog-boxes",
    requirePermission("settings", "edit"),
    run((req) => packagingPolicies.saveBox(req.body, actor(req))),
  );
  app.get(
    "/api/dropship/admin/shipping/shared/packaging-policies",
    requirePermission("dropship", "view"),
    run(() => packagingPolicies.dropshipOverview()),
  );
  app.put(
    "/api/dropship/admin/shipping/shared/packaging-policies",
    requirePermission("dropship", "manage_operations"),
    run((req) => packagingPolicies.saveDropshipPolicy(req.body, actor(req))),
  );
  app.get(
    "/api/dropship/admin/shipping/shared",
    requirePermission("dropship", "view"),
    run(async () => {
      const config = readDropshipShippingCutoverConfig();
      return {
        ...(await service.dropshipConfig(configuredChannelId())),
        runtimeMode: config.policy.mode,
        runtimeConfigurationError: config.configurationError,
      };
    }),
  );
  app.put(
    "/api/dropship/admin/shipping/shared/program",
    requirePermission("dropship", "manage_operations"),
    run((req) =>
      service.saveDropshipProgram(req.body, actor(req), configuredChannelId()),
    ),
  );
  app.put(
    "/api/dropship/admin/shipping/shared/service",
    requirePermission("dropship", "manage_operations"),
    run((req) => service.saveDropshipService(req.body, actor(req))),
  );
  app.put(
    "/api/dropship/admin/shipping/shared/packaging",
    requirePermission("dropship", "manage_operations"),
    run((req) => {
      if (req.body?.channel !== "dropship")
        throw new ShippingConfigurationError(
          "SHIPPING_CHANNEL_FORBIDDEN",
          "This endpoint only configures Dropship.",
          403,
        );
      return service.saveAssignment(req.body, actor(req));
    }),
  );
  // Preserve read-only legacy history; reject old clients trying to edit a
  // second configuration source after the shared-engine cutover.
  app.use(
    "/api/dropship/admin/shipping",
    requirePermission("dropship", "view"),
    (req, res, next) => {
      if (
        ["GET", "HEAD", "OPTIONS"].includes(req.method) ||
        req.path.startsWith("/shared")
      )
        return next();
      if (
        /^\/(boxes|package-profiles|zone-rules|rate-tables|markup-policies|insurance-policies)(\/|$)/.test(
          req.path,
        )
      ) {
        res.status(410).json({
          error: {
            code: "DROPSHIP_SHIPPING_CONFIG_MOVED",
            message:
              "Use shared Shipping Settings for packaging, rates, markup and insurance charges.",
          },
        });
        return;
      }
      next();
    },
  );
  app.get(
    "/api/shipping/admin/packaging",
    requirePermission("settings", "view"),
    run(() => service.listPackaging()),
  );
  app.get(
    "/api/shipping/admin/packaging/resolve",
    requirePermission("settings", "view"),
    run((req) =>
      service.loadPackaging(req.query.channel, req.query.warehouseId),
    ),
  );
  app.post(
    "/api/shipping/admin/box-suites",
    requirePermission("settings", "edit"),
    run((req) => service.saveSuite(req.body, actor(req))),
  );
  app.put(
    "/api/shipping/admin/packaging/assignment",
    requirePermission("settings", "edit"),
    run((req) => service.saveAssignment(req.body, actor(req))),
  );
  app.post(
    "/api/dropship/admin/shipping/shared/program/reset",
    requirePermission("dropship", "manage_operations"),
    run((req) =>
      service.resetDropshipProgram(req.body, actor(req), configuredChannelId()),
    ),
  );
  app.put(
    "/api/shipping/admin/box-suites/status",
    requirePermission("settings", "edit"),
    run((req) => service.changeSuiteStatus(req.body, actor(req))),
  );
  app.post(
    "/api/shipping/admin/packaging/assignment/reset",
    requirePermission("settings", "edit"),
    run((req) => service.resetAssignment(req.body, actor(req))),
  );
  app.post(
    "/api/dropship/admin/shipping/shared/packaging/reset",
    requirePermission("dropship", "manage_operations"),
    run((req) => {
      if (req.body?.channel !== "dropship")
        throw new ShippingConfigurationError(
          "SHIPPING_CHANNEL_FORBIDDEN",
          "This endpoint only configures Dropship.",
          403,
        );
      return service.resetAssignment(req.body, actor(req));
    }),
  );
  app.get(
    "/api/shipping/admin/rate-books/:id/charges",
    requirePermission("settings", "view"),
    run((req) => service.loadCharges(req.params.id)),
  );
  app.put(
    "/api/shipping/admin/rate-books/:id/charges",
    requirePermission("settings", "edit"),
    run((req) => service.saveCharges(req.params.id, req.body, actor(req))),
  );
  app.get(
    "/api/shipping/admin/configuration-history",
    requirePermission("settings", "view"),
    run((req) => service.history(req.query.key)),
  );
}
