import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express, { type NextFunction, type Request, type Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { productCategories, products } from "@shared/schema";
import { registerProductCategoryUpdateRoute } from "../../product-category-update.routes";
import { PRODUCT_CATEGORY_BUSY } from "../../product-category-update.repository";

const mocks = vi.hoisted(() => ({ permission: vi.fn() }));
vi.mock("../../../../routes/middleware", () => ({ requirePermission: (resource: string, action: string) => {
  mocks.permission(resource, action);
  return (_req: Request, _res: Response, next: NextFunction) => next();
} }));

const armalopes = { id: 9, name: "Armalopes", slug: "armalopes", description: null, sortOrder: 0, isActive: true };

function sqlError(code: string) {
  return Object.assign(new Error("database refused"), { code });
}

describe("product category update HTTP boundary", () => {
  let server: Server;
  let url: string;
  let locked: typeof armalopes | undefined;
  let writes: Array<{ table: unknown; values: Record<string, unknown> }>;
  const sleep = vi.fn(async () => undefined);
  const transaction = vi.fn();

  /** Records each table a transaction writes; a products write throws `refuseProducts` if set. */
  function fakeTransaction(refuseProducts?: Error) {
    return {
      select: () => ({ from: () => ({ where: () => ({ for: async () => (locked ? [locked] : []) }) }) }),
      update: (table: unknown) => ({
        set: (values: Record<string, unknown>) => {
          writes.push({ table, values });
          if (table === products && refuseProducts) throw refuseProducts;
          return { where: () => ({
            returning: async () => [{ ...locked, ...values }],
            then: (resolve: (value: unknown) => void) => resolve(undefined),
          }) };
        },
      }),
    };
  }

  async function patch(id: number | string, body: unknown) {
    const response = await fetch(`${url}/${id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  beforeEach(async () => {
    mocks.permission.mockClear();
    sleep.mockClear();
    transaction.mockReset();
    transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(fakeTransaction()));
    locked = armalopes;
    writes = [];
    const app = express();
    app.use(express.json());
    registerProductCategoryUpdateRoute(app, { transaction } as never, { sleep });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/product-categories`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it("requires inventory edit permission", () => {
    expect(mocks.permission).toHaveBeenCalledWith("inventory", "edit");
  });

  it("archives without writing to products, even when a products write would be refused", async () => {
    transaction.mockImplementation(async (run: (tx: unknown) => Promise<unknown>) => run(fakeTransaction(sqlError("55P03"))));

    const result = await patch(9, { isActive: false });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ id: 9, name: "Armalopes", isActive: false });
    expect(writes.map(write => write.table)).toEqual([productCategories]);
    expect(writes[0].values).toMatchObject({ isActive: false });
    expect(writes[0].values).not.toHaveProperty("name");
    expect(writes[0].values).not.toHaveProperty("slug");
  });

  it("does not write to products when a save repeats the current name", async () => {
    const result = await patch(9, { name: " Armalopes " });

    expect(result.status).toBe(200);
    expect(writes.map(write => write.table)).toEqual([productCategories]);
  });

  it("copies a new name onto products in the same transaction", async () => {
    const result = await patch(9, { name: "Bubble Mailers" });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ name: "Bubble Mailers", slug: "bubble-mailers" });
    expect(transaction).toHaveBeenCalledOnce();
    expect(writes.map(write => write.table)).toEqual([productCategories, products]);
    expect(writes[1].values).toMatchObject({ category: "Bubble Mailers" });
  });

  it("keeps an explicit slug and clears a blank description", async () => {
    await patch(9, { name: "Bubble Mailers", slug: "Mailers!", description: "", sortOrder: "3" });

    expect(writes[0].values).toMatchObject({ slug: "mailers", description: null, sortOrder: 3 });
  });

  it.each([
    ["an invalid id", "abc", {}, "Invalid product category id"],
    ["a blank name", 9, { name: "   " }, "Category name is required"],
    ["a slug with no usable characters", 9, { slug: "!!!" }, "Category slug is required"],
  ])("refuses %s before opening a transaction", async (_label, id, body, error) => {
    const result = await patch(id, body);

    expect(result).toEqual({ status: 400, body: { error } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("returns 404 for a category that does not exist", async () => {
    locked = undefined;

    const result = await patch(404, { isActive: false });

    expect(result).toEqual({ status: 404, body: { error: "Product category not found" } });
    expect(writes).toEqual([]);
  });

  it.each(["55P03", "40P01", "40001"])("retries %s with a bounded backoff, then returns 503", async (code) => {
    transaction.mockRejectedValue(sqlError(code));

    const result = await patch(9, { name: "Bubble Mailers" });

    expect(result).toEqual({ status: 503, body: { ...PRODUCT_CATEGORY_BUSY } });
    expect(transaction).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[50], [150], [350]]);
  });

  it("saves when the lock clears during the retries", async () => {
    transaction.mockRejectedValueOnce(sqlError("55P03"));

    const result = await patch(9, { isActive: false });

    expect(result.status).toBe(200);
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("keeps the 409 for a duplicate category and does not retry it", async () => {
    transaction.mockRejectedValue(sqlError("23505"));

    const result = await patch(9, { name: "Armalope" });

    expect(result).toEqual({ status: 409, body: { error: "Category already exists" } });
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("returns the generic 500 for any other failure and does not retry it", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    transaction.mockRejectedValue(new Error("connection lost"));

    const result = await patch(9, { isActive: false });

    expect(result).toEqual({ status: 500, body: { error: "Failed to update product category" } });
    expect(transaction).toHaveBeenCalledOnce();
    consoleError.mockRestore();
  });
});
