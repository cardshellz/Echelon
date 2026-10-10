import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomerReturnCustomerProfileError } from "../../application/customer-return-customer-profile.service";
import { ShopifyCustomerReturnCustomerProfileReader } from "../../infrastructure/customer-return-customer-profile.reader";

const scope = { channelId: 36, shopDomain: "test.myshopify.com", externalCustomerId: "9007199254740993123" };
const connection = { id: 4, channelId: 36, shopDomain: scope.shopDomain, accessToken: "test-token",
  apiVersion: "2025-01", shopifyLocationId: null };
const data = () => ({ shop: { id: "gid://shopify/Shop/1", myshopifyDomain: scope.shopDomain },
  customer: { id: `gid://shopify/Customer/${scope.externalCustomerId}`, firstName: "Jane", lastName: "Doe",
    defaultEmailAddress: { emailAddress: "jane@example.com" } } });
const response = (body: unknown = { data: data() }, headers: Record<string, string> = { "X-Shopify-API-Version": "2026-07" }) =>
  new Response(JSON.stringify(body), { headers });
function fixture() {
  const resolveConnection = vi.fn(async () => ({ ...connection }));
  const request = vi.fn<typeof fetch>(async () => response());
  return { resolveConnection, request, reader: new ShopifyCustomerReturnCustomerProfileReader({ resolveConnection, request }) };
}
afterEach(() => vi.restoreAllMocks());
describe("Shopify verified customer profile reader", () => {
  it("uses one pinned account query with the exact customer ID and channel credentials", async () => {
    const { reader, request, resolveConnection } = fixture();
    expect(await reader.read(scope)).toEqual({ shopDomain: scope.shopDomain, externalCustomerId: scope.externalCustomerId,
      firstName: "Jane", lastName: "Doe", email: "jane@example.com" });
    expect(resolveConnection).toHaveBeenCalledTimes(2);
    expect(resolveConnection).toHaveBeenNthCalledWith(1, 36);
    expect(request).toHaveBeenCalledTimes(1);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://test.myshopify.com/admin/api/2026-07/graphql.json");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store",
      headers: { "X-Shopify-Access-Token": "test-token" } });
    expect(JSON.parse(String(init?.body))).toMatchObject({ variables: { id: `gid://shopify/Customer/${scope.externalCustomerId}` } });
    expect(JSON.parse(String(init?.body)).query).toContain("defaultEmailAddress { emailAddress }");
    expect(JSON.parse(String(init?.body)).query).not.toMatch(/orders|addresses|phone|mutation/);
  });
  it("accepts an account without name or email without querying order data", async () => {
    const { reader, request } = fixture();
    request.mockResolvedValue(response({ data: { ...data(), customer: { ...data().customer, firstName: null, lastName: null, defaultEmailAddress: null } } }));
    expect(await reader.read(scope)).toMatchObject({ firstName: null, lastName: null, email: null });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it.each([{ channelId: 37 }, { shopDomain: "other.myshopify.com" }, { shopDomain: "test.myshopify.com/evil" }, { accessToken: "" }])(
    "rejects wrong or malformed connections before sending credentials: %#", async patch => {
      const { reader, request, resolveConnection } = fixture();
      resolveConnection.mockResolvedValue({ ...connection, ...patch });
      await expect(reader.read(scope)).rejects.toBeInstanceOf(CustomerReturnCustomerProfileError);
      expect(request).not.toHaveBeenCalled();
    });
  it.each([{ id: 5 }, { accessToken: "new-token" }, { apiVersion: "2026-01" }, { shopDomain: "other.myshopify.com" }, { channelId: 37 }])(
    "rejects an account connection change during the request: %#", async patch => {
      const { reader, resolveConnection } = fixture();
      resolveConnection.mockResolvedValueOnce({ ...connection }).mockResolvedValueOnce({ ...connection, ...patch });
      await expect(reader.read(scope)).rejects.toMatchObject({ code: "RETURN_CUSTOMER_PROFILE_UNAVAILABLE" });
    });
  it.each([
    () => ({ data: { ...data(), customer: { ...data().customer, id: "gid://shopify/Customer/456" } } }),
    () => ({ data: { ...data(), shop: { ...data().shop, myshopifyDomain: "other.myshopify.com" } } }),
    () => ({ data: { ...data(), customer: null } }),
    () => ({ data: { ...data(), customer: { id: data().customer.id } } }),
    () => ({ data: data(), errors: [{ message: "Denied for jane@example.com and token" }] }),
    () => ({ data: data(), errors: "secret" }),
    () => ({ data: data(), errors: null }),
  ])("rejects missing, mismatched, partial or errored provider evidence: %#", async body => {
    const { reader, request } = fixture(); request.mockResolvedValue(response(body()));
    await expect(reader.read(scope)).rejects.toEqual(new CustomerReturnCustomerProfileError());
  });
  it.each(["missing-version", "wrong-version", "http-failure", "invalid-json", "too-large", "invalid-utf8"])(
    "rejects unsafe provider responses: %s", async kind => {
      const { reader, request } = fixture();
      const headers = { "X-Shopify-API-Version": "2026-07" };
      const raw = kind === "missing-version" ? response(undefined, {})
        : kind === "wrong-version" ? response(undefined, { "X-Shopify-API-Version": "2026-10" })
        : kind === "http-failure" ? new Response("secret", { status: 403, headers })
        : kind === "invalid-json" ? new Response("secret", { headers })
        : kind === "too-large" ? new Response("a".repeat(32_769), { headers })
        : new Response(new Uint8Array([0xff]), { headers });
      request.mockResolvedValue(raw);
      await expect(reader.read(scope)).rejects.toEqual(new CustomerReturnCustomerProfileError());
    });
  it.each(["connection", "request", "body", "recheck"])("bounds a stalled %s and cancels provider work", async phase => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const { reader, request, resolveConnection } = fixture();
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const never = () => { entered(); return new Promise<never>(() => {}); };
    if (phase === "connection") resolveConnection.mockImplementation(never);
    if (phase === "request") request.mockImplementation(never);
    if (phase === "recheck") resolveConnection.mockResolvedValueOnce({ ...connection }).mockImplementationOnce(never);
    if (phase === "body") request.mockResolvedValue(new Response(new ReadableStream({ pull() { return never(); } }),
      { headers: { "X-Shopify-API-Version": "2026-07" } }));
    const result = reader.read(scope);
    const expectation = expect(result).rejects.toEqual(new CustomerReturnCustomerProfileError());
    await pending; timeout.abort(); await expectation;
    expect(AbortSignal.timeout).toHaveBeenCalledWith(5_000);
    if (request.mock.calls.length) expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it("sanitizes raw connection/provider exceptions", async () => {
    const { reader, resolveConnection } = fixture();
    resolveConnection.mockRejectedValue(Object.assign(new Error("secret jane@example.com"), { code: "SECRET", status: 400 }));
    await expect(reader.read(scope)).rejects.toEqual(new CustomerReturnCustomerProfileError());
  });
});
