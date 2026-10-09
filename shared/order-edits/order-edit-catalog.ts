import { z } from "zod";
import { orderEditVariantSchema } from "./order-edit.contract";
import { memberPlanPresentationSchema } from "../membership/member-plan-presentation";

// Bound a single catalog read; larger catalogs use cursors rather than truncation.
export const ORDER_EDIT_CATALOG_PRODUCT_PAGE_SIZE = 20;
export const ORDER_EDIT_CATALOG_VARIANT_PAGE_SIZE = 50;
export const ORDER_EDIT_CATALOG_CATEGORY_PAGE_SIZE = 250;
// Small stock probes keep the nested product query within Shopify's query-cost limit.
export const ORDER_EDIT_CATALOG_AVAILABILITY_SAMPLE_SIZE = 5;
export const orderEditCatalogProductIdSchema = z
  .string()
  .regex(/^gid:\/\/shopify\/Product\/[1-9]\d*$/);
const connectionId = z.number().int().positive().safe();
const cursor = z.string().min(1).max(1024).nullable().default(null);
const category = z.string().trim().min(1).max(255).nullable().default(null);
export const orderEditCatalogSearchSchema = z
  .string()
  .trim()
  .max(100)
  .refine(
    (value) => !value || new RegExp("[\\p{L}\\p{N}]", "u").test(value),
    "Enter a product name or SKU.",
  )
  .default("");
export const orderEditCatalogCategoriesInputSchema = z
  .object({ after: cursor })
  .strict();
export const orderEditCatalogProductsInputSchema = z
  .object({ search: orderEditCatalogSearchSchema, category, after: cursor })
  .strict();
export const orderEditCatalogVariantsInputSchema = z
  .object({
    productId: orderEditCatalogProductIdSchema,
    after: cursor,
    omsOrderId: z.coerce
      .number()
      .int()
      .positive()
      .safe()
      .nullable()
      .default(null),
    expectedRevision: z.string().min(1).max(256).nullable().default(null),
  })
  .strict()
  .refine(
    (input) =>
      (input.omsOrderId === null) === (input.expectedRevision === null),
    "The order and its revision must be supplied together.",
  );
export const orderEditCatalogVariantSchema = orderEditVariantSchema
  .extend({
    retailPriceCents: z.number().int().nonnegative().safe().optional(),
  })
  .refine(
    (option) =>
      option.retailPriceCents === undefined ||
      option.priceCents <= option.retailPriceCents,
    "The displayed price cannot exceed retail.",
  );
export const orderEditCatalogPageSchema = z
  .object({ hasNextPage: z.boolean(), endCursor: cursor })
  .strict()
  .refine(
    (page) => !page.hasNextPage || page.endCursor !== null,
    "A next page requires a cursor.",
  );
export const orderEditCatalogProductSchema = z
  .object({
    productId: orderEditCatalogProductIdSchema,
    title: z.string().min(1).max(500),
    category,
    imageUrl: z
      .string()
      .url()
      .max(2048)
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "A safe HTTPS image URL is required.")
      .nullable(),
  })
  .strict();
export const orderEditCatalogCategoriesSchema = z
  .object({
    connectionId,
    input: orderEditCatalogCategoriesInputSchema,
    categories: z
      .array(z.string().trim().min(1).max(255))
      .max(ORDER_EDIT_CATALOG_CATEGORY_PAGE_SIZE),
    pageInfo: orderEditCatalogPageSchema,
  })
  .strict();
export const orderEditCatalogProductsSchema = z
  .object({
    connectionId,
    input: orderEditCatalogProductsInputSchema,
    products: z
      .array(orderEditCatalogProductSchema)
      .max(ORDER_EDIT_CATALOG_PRODUCT_PAGE_SIZE),
    pageInfo: orderEditCatalogPageSchema,
  })
  .strict();
export const orderEditCatalogVariantsSchema = z
  .object({
    connectionId,
    input: orderEditCatalogVariantsInputSchema,
    product: orderEditCatalogProductSchema,
    variants: z
      .array(orderEditCatalogVariantSchema)
      .max(ORDER_EDIT_CATALOG_VARIANT_PAGE_SIZE),
    memberPlan: memberPlanPresentationSchema.nullable().optional(),
    pageInfo: orderEditCatalogPageSchema,
  })
  .strict()
  .refine(
    (result) => result.product.productId === result.input.productId,
    "The product does not match the requested parent.",
  )
  .refine(
    (result) =>
      result.memberPlan != null ||
      !result.variants.some(
        (option) =>
          option.retailPriceCents !== undefined &&
          option.priceCents < option.retailPriceCents,
      ),
    "Discounted member prices require the verified plan presentation.",
  )
  .refine(
    (result) =>
      result.input.omsOrderId === null ||
      (result.memberPlan !== undefined &&
        result.variants.every(
          (option) => option.retailPriceCents !== undefined,
        )),
    "Order-scoped discovery requires verified pricing metadata.",
  );
export type OrderEditCatalogCategoriesInput = z.infer<
  typeof orderEditCatalogCategoriesInputSchema
>;
export type OrderEditCatalogProductsInput = z.infer<
  typeof orderEditCatalogProductsInputSchema
>;
export type OrderEditCatalogVariantsInput = z.input<
  typeof orderEditCatalogVariantsInputSchema
>;
export type OrderEditCatalogProduct = z.infer<
  typeof orderEditCatalogProductSchema
>;
export type OrderEditCatalogVariant = z.infer<
  typeof orderEditCatalogVariantSchema
>;
export type OrderEditCatalogCategories = z.infer<
  typeof orderEditCatalogCategoriesSchema
>;
export type OrderEditCatalogProducts = z.infer<
  typeof orderEditCatalogProductsSchema
>;
export type OrderEditCatalogVariants = z.infer<
  typeof orderEditCatalogVariantsSchema
>;
