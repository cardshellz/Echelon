import type { CustomerReturnWorkflowStore, ReturnWorkflowRecord } from "../../application/customer-return-workflow.ports";
import { describe, expect, it, vi } from "vitest";
import {
  CustomerReturnCustomerOperationsService,
  customerReturnUnavailable,
  type CustomerReturnCustomerOperationsDependencies,
} from "../../application/customer-return-customer-operations.service";
import type { CustomerReturnLabelStatus } from "@shared/returns/customer-return-label.contract";
import { labelPreparationFixture, LABEL_KEY } from "../support/label-fixtures";

const principal = { channelId: 36, externalCustomerId: "customer-1" };
const order = { omsOrderId: 100, channelId: 36, externalOrderId: "gid://shopify/Order/100", externalOrderNumber: "#63210" };
const labelStatus: CustomerReturnLabelStatus = {
  channelId: 36, authorizationId: 10, authorizationNumber: "RMA-10", canProgress: false,
  parcels: [{ parcelId: 11, number: 1, status: "ready", trackingNumber: "TRACK-1",
    downloadPath: "/api/returns/admin/portal-preview/live/labels/36/10/parcels/11/download" }],
};
function setup() {
  const resolveOwned = vi.fn<CustomerReturnCustomerOperationsDependencies["orderAccess"]["resolveOwned"]>().mockResolvedValue(order);
  const readOwnedAuthorization = vi.fn<CustomerReturnCustomerOperationsDependencies["ownership"]["readOwnedAuthorization"]>()
    .mockResolvedValue({ authorizationId: 10, omsOrderId: 100 });
  const readOwnedCommand = vi.fn<CustomerReturnCustomerOperationsDependencies["ownership"]["readOwnedCommand"]>()
    .mockResolvedValue({ omsOrderId: 100, authorizationId: 10 });
  const listReturns = vi.fn<CustomerReturnCustomerOperationsDependencies["ownership"]["listReturns"]>().mockResolvedValue([]);
  const submitForOrder = vi.fn<CustomerReturnCustomerOperationsDependencies["submissions"]["submitForOrder"]>().mockResolvedValue(structuredClone(labelStatus));
  const resumeForOrder = vi.fn<CustomerReturnCustomerOperationsDependencies["submissions"]["resumeForOrder"]>().mockResolvedValue(structuredClone(labelStatus));
  const submissionStatus = vi.fn<CustomerReturnCustomerOperationsDependencies["submissions"]["status"]>().mockResolvedValue(structuredClone(labelStatus));
  const status = vi.fn<CustomerReturnCustomerOperationsDependencies["labels"]["status"]>().mockResolvedValue(structuredClone(labelStatus));
  const progress = vi.fn<CustomerReturnCustomerOperationsDependencies["labels"]["progress"]>().mockResolvedValue(structuredClone(labelStatus));
  const artifact = vi.fn<CustomerReturnCustomerOperationsDependencies["labels"]["artifact"]>();
  const dependencies = {
    principal: { ...principal }, orderAccess: { resolveOwned }, ownership: { readOwnedAuthorization, readOwnedCommand, listReturns },
    submissions: { submitForOrder, resumeForOrder, status: submissionStatus }, labels: { status, progress, artifact },
  };
  return { service: new CustomerReturnCustomerOperationsService(dependencies), dependencies, resolveOwned,
    readOwnedAuthorization, readOwnedCommand, listReturns, submitForOrder, resumeForOrder, submissionStatus, status, progress, artifact };
}
async function publicInput() {
  const { input } = await labelPreparationFixture();
  const { channelId: _channelId, orderReference: _orderReference, ...publicRequest } = input;
  return publicRequest;
}
describe("customer-bound return operations", () => {
  it("verifies the canonical order before submit and sends trusted identity with no private URLs", async () => {
    const s = setup();
    const input = await publicInput();
    const result = await s.service.submit(100, input);
    expect(s.resolveOwned).toHaveBeenCalledExactlyOnceWith({ omsOrderId: 100 });
    expect(s.submitForOrder).toHaveBeenCalledExactlyOnceWith({ ...input, channelId: 36, orderReference: "#63210" },
      "customer:36:customer-1", { channelId: 36, omsOrderId: 100, externalOrderId: order.externalOrderId, externalCustomerId: "customer-1" });
    expect(s.submitForOrder.mock.invocationCallOrder[0]).toBeGreaterThan(s.resolveOwned.mock.invocationCallOrder[0]);
    expect(result).not.toHaveProperty("channelId");
    expect(result.parcels[0].downloadPath).toBe("/api/returns/customer/returns/10/parcels/11/download");
    expect(JSON.stringify(result)).not.toContain("/admin/");
  });
  it("cannot mutate the verified principal after construction", async () => {
    const s = setup();
    s.dependencies.principal.externalCustomerId = "other-customer";
    await s.service.labelStatus(10);
    expect(s.readOwnedAuthorization).toHaveBeenCalledWith(principal, 10);
  });
  it.each(["channelId", "externalCustomerId", "orderReference", "actor", "weightGrams"])("rejects injected %s before access or command creation", async field => {
    const s = setup();
    await expect(s.service.submit(100, { ...await publicInput(), [field]: "forged" })).rejects.toMatchObject({ status: 400 });
    expect(s.resolveOwned).not.toHaveBeenCalled();
    expect(s.submitForOrder).not.toHaveBeenCalled();
  });
  it("does not create or replay a command for an unowned order", async () => {
    const s = setup();
    s.resolveOwned.mockRejectedValue(customerReturnUnavailable());
    await expect(s.service.submit(100, await publicInput())).rejects.toMatchObject({ status: 404 });
    expect(s.submitForOrder).not.toHaveBeenCalled();
  });
  it.each(["submissionStatus", "resumeSubmission"] as const)("checks immutable command ownership before %s", async method => {
    const s = setup();
    s.readOwnedCommand.mockResolvedValue(null);
    await expect(s.service[method](LABEL_KEY)).rejects.toMatchObject({ status: 404 });
    expect(s.submissionStatus).not.toHaveBeenCalled();
    expect(s.resumeForOrder).not.toHaveBeenCalled();
    expect(s.resolveOwned).not.toHaveBeenCalled();
  });
  it("resolves the persisted command order under the current customer on resume", async () => {
    const s = setup();
    await s.service.resumeSubmission(LABEL_KEY);
    expect(s.readOwnedCommand).toHaveBeenCalledExactlyOnceWith(principal, LABEL_KEY);
    expect(s.resolveOwned).toHaveBeenCalledExactlyOnceWith({ omsOrderId: 100 });
    expect(s.resumeForOrder).toHaveBeenCalledExactlyOnceWith(36, LABEL_KEY, "customer:36:customer-1", {
      channelId: 36, omsOrderId: 100, externalOrderId: order.externalOrderId, externalCustomerId: "customer-1",
    });
  });
  it.each(["labelStatus", "progressLabels", "artifact"] as const)("denies unowned RMA before %s", async method => {
    const s = setup();
    s.readOwnedAuthorization.mockResolvedValue(null);
    await expect(method === "artifact" ? s.service.artifact(10, 11) : s.service[method](10)).rejects.toMatchObject({ status: 404 });
    expect(s.status).not.toHaveBeenCalled();
    expect(s.progress).not.toHaveBeenCalled();
    expect(s.artifact).not.toHaveBeenCalled();
  });
  it("accepted labels/status do not depend on new-return order lookup or policy eligibility", async () => {
    const s = setup();
    s.resolveOwned.mockRejectedValue(new Error("new-return source unavailable"));
    await s.service.labelStatus(10);
    await s.service.progressLabels(10);
    await s.service.submissionStatus(LABEL_KEY);
    await s.service.artifact(10, 11);
    expect(s.resolveOwned).not.toHaveBeenCalled();
    expect(s.artifact).toHaveBeenCalledExactlyOnceWith(36, 10, 11);
  });
  it.each(["channel", "order", "authorization"])("fails closed when an underlying result changes %s identity", async field => {
    const s = setup();
    if (field === "channel") s.status.mockResolvedValue({ ...labelStatus, channelId: 37 });
    if (field === "authorization") s.status.mockResolvedValue({ ...labelStatus, authorizationId: 12 });
    if (field === "order") s.readOwnedAuthorization.mockResolvedValueOnce({ authorizationId: 10, omsOrderId: 100 })
      .mockResolvedValueOnce({ authorizationId: 10, omsOrderId: 101 });
    await expect(s.service.labelStatus(10)).rejects.toMatchObject({ status: 404 });
  });
  it("reauthorizes a replay result before disclosure", async () => {
    const s = setup();
    s.readOwnedAuthorization.mockResolvedValue(null);
    await expect(s.service.submissionStatus(LABEL_KEY)).rejects.toMatchObject({ status: 404 });
  });
  it("cannot replace the accepted command's RMA with another RMA for the same order", async () => {
    const s = setup();
    s.submissionStatus.mockResolvedValue({ ...labelStatus, authorizationId: 12 });
    await expect(s.service.submissionStatus(LABEL_KEY)).rejects.toMatchObject({ status: 404 });
    expect(s.readOwnedAuthorization).not.toHaveBeenCalled();
  });
  it("paginates history independently of current eligibility", async () => {
    const s = setup();
    s.listReturns.mockResolvedValue([12, 11, 10].map(authorizationId => ({ authorizationId, authorizationNumber: `RMA-${authorizationId}`,
      omsOrderId: 100, orderReference: "#63210", createdAt: "2026-09-01T12:00:00.000Z" })));
    const result = await s.service.listReturns({ pageSize: 2, beforeAuthorizationId: 15 });
    expect(result.returns.map(row => row.authorizationId)).toEqual([12, 11]);
    expect(result.nextBeforeAuthorizationId).toBe(11);
    expect(s.resolveOwned).not.toHaveBeenCalled();
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, 1.5])("rejects invalid canonical id %s before reads", async invalid => {
    const s = setup();
    await expect(s.service.labelStatus(invalid)).rejects.toMatchObject({ status: 400 });
    expect(s.readOwnedAuthorization).not.toHaveBeenCalled();
  });
});

async function workflowSetup() {
  const legacy = setup(), fixture = await labelPreparationFixture();
  const record: ReturnWorkflowRecord = { request: { ...fixture.input, orderReference: "#63210" },
    scope: { channelId: 36, omsOrderId: 100, externalOrderId: order.externalOrderId, externalCustomerId: principal.externalCustomerId },
    actor: "customer:36:customer-1", phase: "queued", reason: null, authorizationId: null, failures: 0,
    explicitRetry: false, leaseToken: null, updatedAt: new Date("2026-10-30T12:00:00.000Z") };
  const workflows = { enqueue: vi.fn<CustomerReturnWorkflowStore["enqueue"]>(async () => structuredClone(record)),
    readOwned: vi.fn<CustomerReturnWorkflowStore["readOwned"]>(async () => structuredClone(record)),
    readOwnedOrder: vi.fn<CustomerReturnWorkflowStore["readOwnedOrder"]>(async () => structuredClone(record)),
    readOwnedAuthorization: vi.fn<CustomerReturnWorkflowStore["readOwnedAuthorization"]>(async () => structuredClone(record)),
    retryOwned: vi.fn<CustomerReturnWorkflowStore["retryOwned"]>(async () => structuredClone(record)),
    acceptedRequest: vi.fn<CustomerReturnWorkflowStore["acceptedRequest"]>(async () => ({ request: record.request, scope: record.scope })),
    claim: vi.fn<CustomerReturnWorkflowStore["claim"]>(), settle: vi.fn<CustomerReturnWorkflowStore["settle"]>() };
  return { ...legacy, record, workflows, service: new CustomerReturnCustomerOperationsService({ ...legacy.dependencies, workflows, now: () => new Date(record.updatedAt) }) };
}
describe("customer-owned durable label workflow boundary", () => {
  it("queues one immutable request under verified identity without synchronously buying or preparing a label", async () => {
    const s = await workflowSetup(), input = await publicInput();
    const result = await s.service.queueLabels(100, input);
    expect(result.phase).toBe("queued");
    expect(s.workflows.enqueue).toHaveBeenCalledWith(expect.objectContaining({ request: { ...input, channelId: 36, orderReference: "#63210" },
      actor: "customer:36:customer-1", scope: s.record.scope }));
    expect(s.submitForOrder).not.toHaveBeenCalled(); expect(s.progress).not.toHaveBeenCalled();
  });
  it("restores an owned unfinished request by order with only read ports", async () => {
    const s = await workflowSetup(), result = await s.service.orderWorkflow(100);
    expect(result.input.idempotencyKey).toBe(s.record.request.idempotencyKey);
    expect(result.input).not.toHaveProperty("channelId"); expect(result.input).not.toHaveProperty("orderReference");
    expect(s.workflows.readOwnedOrder).toHaveBeenCalledExactlyOnceWith(principal, 100);
    expect(s.workflows.enqueue).not.toHaveBeenCalled(); expect(s.progress).not.toHaveBeenCalled();
  });
  it.each(["workflowStatus", "retryWorkflow"] as const)("does not disclose another customer's request through %s", async method => {
    const s = await workflowSetup(); s.workflows.readOwned.mockResolvedValue(null); s.workflows.retryOwned.mockResolvedValue(null);
    await expect(s.service[method](LABEL_KEY)).rejects.toMatchObject({ code: "RETURN_WORKFLOW_NOT_FOUND", status: 404 });
    expect(s.status).not.toHaveBeenCalled(); expect(s.progress).not.toHaveBeenCalled();
  });
  it.each(["customer", "channel", "order", "key"])("rejects changed %s identity returned by a read port", async field => {
    const s = await workflowSetup();
    if (field === "customer") s.record.scope.externalCustomerId = "other-customer";
    if (field === "channel") s.record.scope.channelId = 37;
    if (field === "order") s.record.scope.omsOrderId = 101;
    if (field === "key") s.record.request.idempotencyKey = "00000000-0000-4000-8000-000000000077";
    await expect(s.service.queueLabels(100, await publicInput())).rejects.toMatchObject({ status: 404 });
    expect(s.status).not.toHaveBeenCalled();
  });
  it("enrolls an accepted historical return only through verified ownership and its saved manifest", async () => {
    const s = await workflowSetup(); s.record.authorizationId = 10; s.record.phase = "labels";
    const result = await s.service.queueExistingLabels(10);
    expect(s.workflows.acceptedRequest).toHaveBeenCalledExactlyOnceWith(principal, 10);
    expect(s.workflows.enqueue).toHaveBeenCalledWith(expect.objectContaining({ authorizationId: 10, request: s.record.request }));
    expect(result.labels?.parcels[0].downloadPath).toBe("/api/returns/customer/returns/10/parcels/11/download");
    expect(s.progress).not.toHaveBeenCalled();
  });
  it("rejects a forged authorization before reading or enrolling its manifest", async () => {
    const s = await workflowSetup(); s.readOwnedAuthorization.mockResolvedValue(null);
    await expect(s.service.queueExistingLabels(10)).rejects.toMatchObject({ status: 404 });
    expect(s.workflows.acceptedRequest).not.toHaveBeenCalled(); expect(s.workflows.enqueue).not.toHaveBeenCalled();
  });
});
