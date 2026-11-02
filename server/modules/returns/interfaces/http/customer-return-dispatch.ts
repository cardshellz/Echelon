import { z } from "zod";
import { CustomerReturnCustomerAccessError } from "../../application/customer-return-customer-auth.service";
import type { createCustomerReturnCustomerServices } from "../../infrastructure/customer-return-customer.composition";
const id = z.coerce.number().int().positive().safe();
const empty = z.object({}).strict();
type CustomerServices = Awaited<ReturnType<typeof createCustomerReturnCustomerServices>>;
type Returns = { orders: Pick<CustomerServices["orders"], "choices" | "order" | "review">;
  operations: Pick<CustomerServices["operations"], keyof CustomerServices["operations"]>; download: CustomerServices["download"] };
export async function dispatchCustomerReturn(input: { path: string; method: "GET" | "POST"; query: Record<string,string>; body?: unknown }, returns: Returns): Promise<unknown> {
  const { path, method, query, body } = input;
  const read = method === "GET";
  if (!path.startsWith("/returns/")) throw notFound();
  if (path === "/returns/order-options" && read) {
    const parsed = z.object({ before: id.optional() }).strict().parse(query);
    return returns.orders.choices(
      parsed.before ? { beforeOmsOrderId: parsed.before } : {},
    );
  }
  const returnOrder =
    /^\/returns\/orders\/([1-9][0-9]*)(?:\/(review|returns|label-requests))?$/.exec(path);
  if (returnOrder) {
    empty.parse(query);
    const omsOrderId = id.parse(returnOrder[1]);
    if (!returnOrder[2] && read) return returns.orders.order(omsOrderId);
    if (!read && returnOrder[2] === "review")
      return returns.orders.review(omsOrderId, body);
    if (!read && returnOrder[2] === "returns")
      return returns.operations.submit(omsOrderId, body);
    if (read && returnOrder[2] === "label-requests")
      return returns.operations.orderWorkflow(omsOrderId);
    if (!read && returnOrder[2] === "label-requests")
      return returns.operations.queueLabels(omsOrderId, body);
  }
  if (path === "/returns/returns" && read) {
    const parsed = z.object({ before: id.optional() }).strict().parse(query);
    return returns.operations.listReturns(
      parsed.before ? { beforeAuthorizationId: parsed.before } : {},
    );
  }
  const workflow = /^\/returns\/label-requests\/([a-f0-9-]+)(?:\/(retry))?$/.exec(path);
  if (workflow) {
    empty.parse(query);
    const key = z.string().uuid().parse(workflow[1]);
    if (read && !workflow[2]) return returns.operations.workflowStatus(key);
    if (!read && workflow[2]) { empty.parse(body); return returns.operations.retryWorkflow(key); }
  }
  const existingLabels = /^\/returns\/returns\/([1-9][0-9]*)\/label-requests$/.exec(path);
  if (existingLabels && read) {
    empty.parse(query);
    return returns.operations.authorizationWorkflow(id.parse(existingLabels[1]));
  }
  if (existingLabels && !read) {
    empty.parse(query); empty.parse(body);
    return returns.operations.queueExistingLabels(id.parse(existingLabels[1]));
  }
  const command = /^\/returns\/commands\/([a-f0-9-]+)(?:\/(resume))?$/.exec(
    path,
  );
  if (command) {
    empty.parse(query);
    const key = z.string().uuid().parse(command[1]);
    if (!command[2] && read) return returns.operations.submissionStatus(key);
    if (command[2] && !read) {
      empty.parse(body);
      return returns.operations.resumeSubmission(key);
    }
  }
  const label =
    /^\/returns\/returns\/([1-9][0-9]*)(?:\/(progress)|\/parcels\/([1-9][0-9]*)\/download)?$/.exec(
      path,
    );
  if (label) {
    empty.parse(query);
    const authorizationId = id.parse(label[1]);
    if (label[3] && read) {
      const artifact = await returns.operations.artifact(
        authorizationId,
        id.parse(label[3]),
      );
      return returns.download(artifact.downloadUrl);
    }
    if (label[2] && !read) {
      empty.parse(body);
      return returns.operations.progressLabels(authorizationId);
    }
    if (!label[2] && !label[3] && read)
      return returns.operations.labelStatus(authorizationId);
  }
  throw notFound();
}
function notFound() { return new CustomerReturnCustomerAccessError("CUSTOMER_RETURN_NOT_FOUND", "This return action is unavailable.", 404); }
