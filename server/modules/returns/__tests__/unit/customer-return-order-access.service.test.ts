import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnOrderAccessError,
  CustomerReturnOrderAccessService,
  type CustomerReturnOrderCandidate,
  type CustomerReturnOrderCandidateQuery,
  type CustomerReturnVerifiedPrincipal,
} from "../../application/customer-return-order-access.service";

const CHANNEL_ID = 36;
const CUSTOMER: CustomerReturnVerifiedPrincipal = {
  kind: "customer", channelId: CHANNEL_ID, externalCustomerId: "customer-123",
};
const ORDER_GRANT: CustomerReturnVerifiedPrincipal = {
  kind: "order", channelId: CHANNEL_ID, omsOrderId: 321, externalOrderId: "99999999999999999999",
};

function order(overrides: Partial<CustomerReturnOrderCandidate> = {}): CustomerReturnOrderCandidate {
  return {
    omsOrderId: 321,
    channelId: CHANNEL_ID,
    externalOrderId: "99999999999999999999",
    externalOrderNumber: "#63210",
    externalCustomerId: "customer-123",
    ...overrides,
  };
}

function setup(
  principal: CustomerReturnVerifiedPrincipal | null = CUSTOMER,
  candidates: readonly CustomerReturnOrderCandidate[] = [order()],
) {
  const principalReader = { getVerifiedPrincipal: vi.fn(async () => principal) };
  const repository = {
    findExactOrderCandidates: vi.fn(async (_query: CustomerReturnOrderCandidateQuery) => candidates),
  };
  const dependencies = { channelId: CHANNEL_ID, principalReader, repository };
  return { service: new CustomerReturnOrderAccessService(dependencies), dependencies, principalReader, repository };
}

const unavailable = {
  name: "CustomerReturnOrderAccessError",
  code: "CUSTOMER_RETURN_ORDER_UNAVAILABLE",
  message: "This order is unavailable for returns.",
  status: 404,
};

describe("CustomerReturnOrderAccessService", () => {
  it("queries exact aliases inside the verified customer/channel and returns canonical order identity", async () => {
    const { service, repository } = setup();
    const result = await service.resolve({ orderReference: " # 63210 " });

    expect(repository.findExactOrderCandidates).toHaveBeenCalledExactlyOnceWith({
      channelId: CHANNEL_ID,
      scope: { kind: "customer", externalCustomerId: CUSTOMER.externalCustomerId },
      orderNumberAliases: ["63210", "#63210", "# 63210"],
    });
    expect(result).toEqual({
      omsOrderId: 321, channelId: CHANNEL_ID, externalOrderId: "99999999999999999999", externalOrderNumber: "#63210",
    });
    expect(result).not.toHaveProperty("externalCustomerId");
  });

  it("allows a verified order grant for a guest order with no customer ID", async () => {
    const { service, repository } = setup(ORDER_GRANT, [order({ externalCustomerId: null })]);
    await expect(service.resolve({ orderReference: "63210" })).resolves.toMatchObject({ omsOrderId: 321 });
    expect(repository.findExactOrderCandidates).toHaveBeenCalledExactlyOnceWith({
      channelId: CHANNEL_ID,
      scope: { kind: "order", omsOrderId: 321, externalOrderId: "99999999999999999999" },
      orderNumberAliases: ["63210", "#63210"],
    });
  });

  it.each([
    [],
    [order({ externalCustomerId: "someone-else" })],
    [order({ externalCustomerId: null })],
    [order({ channelId: 37 })],
    [order({ externalOrderNumber: "#632100" })],
    [order({ externalOrderNumber: "#CS-63210" })],
    [order({ externalOrderNumber: "#063210" })],
    [order(), order({ omsOrderId: 322, externalOrderId: "another-order", externalOrderNumber: "63210" })],
    [order(), order()],
  ])("fails closed with the same unavailable result for missing, unauthorized or ambiguous candidates: %j", async (...rows) => {
    // Each table entry is a candidate array; Vitest expands its elements.
    const { service } = setup(CUSTOMER, rows);
    await expect(service.resolve({ orderReference: "63210" })).rejects.toMatchObject(unavailable);
  });

  it.each([
    { omsOrderId: 322 },
    { externalOrderId: "different-canonical-id" },
    { channelId: 37 },
    { externalOrderNumber: "#63211" },
  ])("checks both canonical IDs and the requested reference for order grants: %j", async (override) => {
    const { service } = setup(ORDER_GRANT, [order(override)]);
    await expect(service.resolve({ orderReference: "63210" })).rejects.toMatchObject(unavailable);
  });

  it.each([null, { ...CUSTOMER, channelId: 37 }, { ...ORDER_GRANT, channelId: 37 }])(
    "does not query orders without a verified principal in the configured channel: %j", async (principal) => {
      const { service, repository } = setup(principal);
      await expect(service.resolve({ orderReference: "63210" })).rejects.toMatchObject(unavailable);
      expect(repository.findExactOrderCandidates).not.toHaveBeenCalled();
    },
  );

  it.each([
    null, {}, { orderReference: 63210 }, { orderReference: "##63210" },
    { orderReference: "63210", channelId: CHANNEL_ID },
    { orderReference: "63210", externalCustomerId: "someone-else" },
    { orderReference: "63210", email: "private@example.test" },
    { orderReference: "63210", principal: CUSTOMER },
    { orderReference: "63210", omsOrderId: 321 },
  ])("rejects invalid/public identity fields before invoking trusted ports: %j", async (input) => {
    const { service, principalReader, repository } = setup();
    await expect(service.resolve(input)).rejects.toMatchObject({
      code: "CUSTOMER_RETURN_ORDER_REFERENCE_INVALID", message: "Enter a valid order reference.", status: 400,
    });
    expect(principalReader.getVerifiedPrincipal).not.toHaveBeenCalled();
    expect(repository.findExactOrderCandidates).not.toHaveBeenCalled();
  });

  it("does not weaken literal wildcard, case or affix matching", async () => {
    const { service, repository } = setup(CUSTOMER, [order({ externalOrderNumber: "#CS_%001-A" })]);
    await service.resolve({ orderReference: "CS_%001-A" });
    expect(repository.findExactOrderCandidates.mock.calls[0][0].orderNumberAliases).toEqual([
      "CS_%001-A", "#CS_%001-A",
    ]);
    await expect(service.resolve({ orderReference: "cs_%001-A" })).rejects.toMatchObject(unavailable);
  });

  it("validates the trusted principal without exposing its contents", async () => {
    const { service, principalReader, repository } = setup();
    principalReader.getVerifiedPrincipal.mockResolvedValue({
      ...CUSTOMER, externalCustomerId: "private@example.test\n",
    });
    await expect(service.resolve({ orderReference: "63210" })).rejects.toMatchObject({
      code: "CUSTOMER_RETURN_ORDER_ACCESS_UNAVAILABLE", status: 503,
      message: "Return order access is temporarily unavailable.",
    });
    expect(repository.findExactOrderCandidates).not.toHaveBeenCalled();
  });

  it.each([
    { omsOrderId: Number.MAX_SAFE_INTEGER + 1 },
    { externalOrderId: "" },
    { externalCustomerId: "\n" },
  ])("validates repository output before authorizing access: %j", async (overrides) => {
    const { service } = setup(CUSTOMER, [order(overrides)]);
    await expect(service.resolve({ orderReference: "63210" })).rejects.toMatchObject({
      code: "CUSTOMER_RETURN_ORDER_ACCESS_UNAVAILABLE", status: 503,
    });
  });

  it.each(["principal", "repository"] as const)("sanitizes unexpected %s failures", async (port) => {
    const { service, principalReader, repository } = setup();
    const error = new Error("SQL/customer private@example.test order #63210");
    if (port === "principal") principalReader.getVerifiedPrincipal.mockRejectedValue(error);
    else repository.findExactOrderCandidates.mockRejectedValue(error);
    let actual: unknown;
    try { await service.resolve({ orderReference: "63210" }); } catch (caught) { actual = caught; }
    expect(actual).toBeInstanceOf(CustomerReturnOrderAccessError);
    expect(actual).toMatchObject({ code: "CUSTOMER_RETURN_ORDER_ACCESS_UNAVAILABLE", status: 503 });
    expect(String(actual)).not.toContain("private@example.test");
    expect(JSON.stringify(actual)).not.toContain("63210");
    expect(actual).not.toHaveProperty("cause");
  });

  it("snapshots channel configuration instead of accepting subsequent external mutation", async () => {
    const { service, dependencies, repository } = setup();
    dependencies.channelId = 37;
    await service.resolve({ orderReference: "63210" });
    expect(repository.findExactOrderCandidates.mock.calls[0][0].channelId).toBe(CHANNEL_ID);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])("rejects invalid channel configuration: %j", (channelId) => {
    const { dependencies } = setup();
    expect(() => new CustomerReturnOrderAccessService({ ...dependencies, channelId })).toThrow(
      "Return order access is not configured.",
    );
  });
});
