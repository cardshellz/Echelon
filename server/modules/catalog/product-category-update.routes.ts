import type { Express } from "express";
import { requirePermission } from "../../routes/middleware";
import {
  isProductCategoryBusy,
  PRODUCT_CATEGORY_BUSY,
  updateProductCategory,
  type ProductCategoryChanges,
  type ProductCategoryUpdateOptions,
} from "./product-category-update.repository";

export function normalizeCategorySlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function registerProductCategoryUpdateRoute(
  app: Express,
  database: Parameters<typeof updateProductCategory>[0],
  options: ProductCategoryUpdateOptions = {},
): void {
  app.patch("/api/product-categories/:id", requirePermission("inventory", "edit"), async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) {
        return res.status(400).json({ error: "Invalid product category id" });
      }

      const changes: ProductCategoryChanges = {};
      if (req.body.name !== undefined) {
        changes.name = String(req.body.name).trim();
        if (!changes.name) return res.status(400).json({ error: "Category name is required" });
      }
      const slugSource = req.body.slug !== undefined ? String(req.body.slug) : changes.name;
      if (slugSource !== undefined) {
        changes.slug = normalizeCategorySlug(slugSource);
        if (!changes.slug) return res.status(400).json({ error: "Category slug is required" });
      }
      if (req.body.description !== undefined) changes.description = req.body.description || null;
      if (req.body.sortOrder !== undefined) changes.sortOrder = Number(req.body.sortOrder);
      if (req.body.isActive !== undefined) changes.isActive = Boolean(req.body.isActive);

      const category = await updateProductCategory(database, id, changes, options);
      if (!category) return res.status(404).json({ error: "Product category not found" });
      res.json(category);
    } catch (error: any) {
      if (isProductCategoryBusy(error)) {
        return res.status(503).json(PRODUCT_CATEGORY_BUSY);
      }
      if (error?.code === "23505") {
        return res.status(409).json({ error: "Category already exists" });
      }
      console.error("Error updating product category:", error);
      res.status(500).json({ error: "Failed to update product category" });
    }
  });
}
