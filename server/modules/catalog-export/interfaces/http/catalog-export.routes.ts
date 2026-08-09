import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { z } from "zod";
import { CatalogExportService } from "../../application/catalog-export.service";
import {
  CATALOG_EXPORT_DEFAULT_PAGE_SIZE,
  CATALOG_EXPORT_MAX_PAGE_SIZE,
  InvalidCatalogExportCursorError,
  type NormalizedCatalogExportPage,
} from "../../domain/catalog-export";
import { PostgresCatalogExportRepository } from "../../infrastructure/postgres-catalog-export.repository";

const querySchema = z.object({
  cursor: z.string().trim().min(1).max(255).optional(),
  limit: z.coerce.number().int().min(1).max(CATALOG_EXPORT_MAX_PAGE_SIZE)
    .default(CATALOG_EXPORT_DEFAULT_PAGE_SIZE),
}).strict();

const responseSchema = z.object({
  externalSourceId: z.string().trim().min(1).max(255),
  items: z.array(z.object({
    externalItemId: z.string().trim().min(1).max(255),
    externalParentId: z.string().trim().min(1).max(255),
    name: z.string().trim().min(1).max(500),
    sku: z.string().trim().min(1).max(255).nullable(),
    gtin: z.string().trim().min(1).max(255).nullable(),
    kind: z.enum(["inventory", "non_inventory", "service", "unknown"]),
    status: z.enum(["active", "archived"]),
    sourceUpdatedAt: z.string().datetime({ offset: true }),
    attributes: z.record(
      z.string().trim().min(1).max(100),
      z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
    ),
  }).strict()).max(CATALOG_EXPORT_MAX_PAGE_SIZE),
  nextCursor: z.string().trim().min(1).max(255).nullable(),
}).strict();

export interface CatalogExportRouteDependencies {
  readApiKey: () => string | undefined;
  listPage: (input: { cursor: string | null; limit: number }) => Promise<NormalizedCatalogExportPage>;
}

function secureStringEqual(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left, "utf8").digest();
  const rightHash = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftHash, rightHash);
}

function createCatalogExportAuthenticator(
  readApiKey: () => string | undefined,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    const configuredKey = readApiKey()?.trim();
    if (!configuredKey || configuredKey.length < 32) {
      return res.status(503).json({
        error: {
          code: "CATALOG_EXPORT_NOT_CONFIGURED",
          message: "Catalog export is not configured.",
        },
      });
    }
    const authorization = req.headers.authorization;
    const providedKey = authorization?.startsWith("Bearer ")
      ? authorization.slice("Bearer ".length)
      : null;
    if (!providedKey || !secureStringEqual(providedKey, configuredKey)) {
      return res.status(401).json({
        error: {
          code: "CATALOG_EXPORT_UNAUTHORIZED",
          message: "Catalog export authentication failed.",
        },
      });
    }
    return next();
  };
}

const repository = new PostgresCatalogExportRepository();
const defaultDependencies: CatalogExportRouteDependencies = {
  readApiKey: () => process.env.CATALOG_EXPORT_API_KEY,
  listPage: (input) => new CatalogExportService(
    repository,
    process.env.CATALOG_EXPORT_SOURCE_ID ?? "",
  ).listPage(input),
};

export function registerCatalogExportRoutes(
  app: Express,
  dependencies: CatalogExportRouteDependencies = defaultDependencies,
): void {
  app.get(
    "/api/integrations/catalog/v1/items",
    createCatalogExportAuthenticator(dependencies.readApiKey),
    async (req, res) => {
      const parsedQuery = querySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        return res.status(400).json({
          error: {
            code: "CATALOG_EXPORT_REQUEST_INVALID",
            message: "Catalog export cursor or limit is invalid.",
          },
        });
      }
      try {
        const page = await dependencies.listPage({
          cursor: parsedQuery.data.cursor ?? null,
          limit: parsedQuery.data.limit,
        });
        return res.json(responseSchema.parse(page));
      } catch (error) {
        if (error instanceof InvalidCatalogExportCursorError) {
          return res.status(400).json({
            error: {
              code: "CATALOG_EXPORT_CURSOR_INVALID",
              message: error.message,
            },
          });
        }
        const configurationError = error instanceof TypeError
          && error.message.startsWith("CATALOG_EXPORT_SOURCE_ID");
        if (configurationError) {
          return res.status(503).json({
            error: {
              code: "CATALOG_EXPORT_NOT_CONFIGURED",
              message: "Catalog export is not configured.",
            },
          });
        }
        console.error(JSON.stringify({
          code: "CATALOG_EXPORT_FAILED",
          message: "Catalog export failed.",
          context: { error: error instanceof Error ? error.message : String(error) },
        }));
        return res.status(500).json({
          error: {
            code: "CATALOG_EXPORT_FAILED",
            message: "Catalog export failed.",
          },
        });
      }
    },
  );
}
