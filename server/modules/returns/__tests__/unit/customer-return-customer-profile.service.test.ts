import { describe, expect, it, vi } from "vitest";
import { customerReturnCustomerProfileSchema } from "@shared/returns/customer-return-access.contract";
import { CustomerReturnCustomerProfileService, CustomerReturnCustomerProfileError } from "../../application/customer-return-customer-profile.service";

const principal = { channelId: 36, externalCustomerId: "9007199254740993123", shopDomain: "test.myshopify.com",
  sessionKey: "a".repeat(43), authenticatedAt: 1, expiresAt: 2 };
const evidence = { shopDomain: principal.shopDomain, externalCustomerId: principal.externalCustomerId,
  firstName: " Jane ", lastName: " Doe ", email: " jane@example.com " };
describe("verified returns customer profile", () => {
  it("reads only the verified account and returns just the current account name/email", async () => {
    const read = vi.fn(async () => ({ ...evidence }));
    const service = new CustomerReturnCustomerProfileService({ read });
    expect(await service.read(Object.freeze({ ...principal }))).toEqual({ name: "Jane Doe", email: "jane@example.com" });
    expect(read).toHaveBeenCalledWith({ channelId: 36, shopDomain: principal.shopDomain, externalCustomerId: principal.externalCustomerId });
  });
  it.each([
    { firstName: null, lastName: null, email: null, expected: { name: null, email: null } },
    { firstName: " ", lastName: " Doe ", email: " ", expected: { name: "Doe", email: null } },
  ])("does not guess missing account data from other sources: %#", async ({ expected, ...parts }) => {
    expect(await new CustomerReturnCustomerProfileService({ read: async () => ({ ...evidence, ...parts }) }).read(principal)).toEqual(expected);
  });
  it.each([
    { shopDomain: "other.myshopify.com" }, { externalCustomerId: "456" }, { email: "not an email" },
    { firstName: "a".repeat(256) }, { email: "a".repeat(321) }, { lastName: undefined }, { token: "private" },
  ])("rejects mismatched or malformed evidence with a safe error: %#", async patch => {
    const service = new CustomerReturnCustomerProfileService({ read: async () => ({ ...evidence, ...patch }) as never });
    await expect(service.read(principal)).rejects.toMatchObject({ code: "RETURN_CUSTOMER_PROFILE_UNAVAILABLE", status: 503 });
  });
  it("sanitizes provider messages, codes, status and credentials", async () => {
    const service = new CustomerReturnCustomerProfileService({ read: async () => {
      throw Object.assign(new Error("secret jane@example.com"), { code: "SECRET", status: 401 });
    } });
    const error = await service.read(principal).catch(value => value);
    expect(error).toBeInstanceOf(CustomerReturnCustomerProfileError);
    expect(error.code).toBe("RETURN_CUSTOMER_PROFILE_UNAVAILABLE");
    expect(error.message).not.toMatch(/secret|jane@/i);
    expect(error.cause).toBeUndefined();
  });
  it.each([{ channelId: 0 }, { externalCustomerId: "gid://shopify/Customer/123" }, { shopDomain: "https://evil.test" }])(
    "rejects invalid scope before the reader: %#", async patch => {
      const read = vi.fn();
      await expect(new CustomerReturnCustomerProfileService({ read }).read({ ...principal, ...patch })).rejects.toBeInstanceOf(CustomerReturnCustomerProfileError);
      expect(read).not.toHaveBeenCalled();
    });
  it("copies reader scope so a faulty reader cannot change the account comparison", async () => {
    const service = new CustomerReturnCustomerProfileService({ read: async scope => {
      scope.externalCustomerId = "456";
      return { ...evidence, externalCustomerId: scope.externalCustomerId };
    } });
    await expect(service.read(principal)).rejects.toBeInstanceOf(CustomerReturnCustomerProfileError);
  });
  it("validates the public DTO and rejects extra identity fields", () => {
    expect(customerReturnCustomerProfileSchema.safeParse({ name: null, email: null }).success).toBe(true);
    expect(customerReturnCustomerProfileSchema.safeParse({ name: "Jane", email: null, customerId: "123" }).success).toBe(false);
  });
});
