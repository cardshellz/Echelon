import { z } from "zod";
import {
  buildCustomerReturnOrderNumberAliases,
  CustomerReturnOrderReferenceError,
  MAX_CUSTOMER_RETURN_ORDER_REFERENCE_INPUT_LENGTH,
  MAX_CUSTOMER_RETURN_ORDER_REFERENCE_LENGTH,
} from "../domain/customer-return-order-reference";

const canonicalIdSchema = z.number().int().positive().safe();
const externalIdSchema = z.string().min(1).max(100)
  .refine((value) => !/\s|[\u0000-\u001f\u007f-\u009f]/.test(value));

export const customerReturnOrderAccessInputSchema = z.object({
  orderReference: z.string().max(MAX_CUSTOMER_RETURN_ORDER_REFERENCE_INPUT_LENGTH),
}).strict();

export const customerReturnVerifiedPrincipalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("customer"),
    channelId: canonicalIdSchema,
    externalCustomerId: externalIdSchema,
  }).strict(),
  z.object({
    kind: z.literal("order"),
    channelId: canonicalIdSchema,
    omsOrderId: canonicalIdSchema,
    externalOrderId: externalIdSchema,
  }).strict(),
]);

export type CustomerReturnVerifiedPrincipal = z.infer<typeof customerReturnVerifiedPrincipalSchema>;

export interface CustomerReturnPrincipalReader {
  /**
   * Request-scoped trusted server adapter: verify session/signature/email grant
   * before returning. An order grant is bound to both canonical order IDs.
   * Never construct this principal from the public request body.
   */
  getVerifiedPrincipal(): Promise<CustomerReturnVerifiedPrincipal | null>;
}

export type CustomerReturnOrderAccessScope =
  | { kind: "customer"; externalCustomerId: string }
  | { kind: "order"; omsOrderId: number; externalOrderId: string };

export const customerReturnOrderCandidateSchema = z.object({
  omsOrderId: canonicalIdSchema,
  channelId: canonicalIdSchema,
  externalOrderId: externalIdSchema,
  externalOrderNumber: z.string().min(1).max(MAX_CUSTOMER_RETURN_ORDER_REFERENCE_LENGTH),
  externalCustomerId: externalIdSchema.nullable(),
}).strict();

export type CustomerReturnOrderCandidate = z.infer<typeof customerReturnOrderCandidateSchema>;

export interface CustomerReturnOrderCandidateQuery {
  channelId: number;
  scope: CustomerReturnOrderAccessScope;
  orderNumberAliases: readonly string[];
}

export interface CustomerReturnOrderAccessRepository {
  /**
   * Apply channel AND scope AND exact order-number equality in the query.
   * Return up to two distinct OMS orders to detect ambiguity; never LIMIT 1.
   * Do not search global orders, match email, use substrings, or choose a shipment.
   */
  findExactOrderCandidates(input: CustomerReturnOrderCandidateQuery): Promise<readonly CustomerReturnOrderCandidate[]>;
}

export const customerReturnOrderAccessResultSchema = customerReturnOrderCandidateSchema.omit({
  externalCustomerId: true,
});
export type CustomerReturnOrderAccessResult = z.infer<typeof customerReturnOrderAccessResultSchema>;

export type CustomerReturnOrderAccessErrorCode =
  | "CUSTOMER_RETURN_ORDER_REFERENCE_INVALID"
  | "CUSTOMER_RETURN_ORDER_UNAVAILABLE"
  | "CUSTOMER_RETURN_ORDER_ACCESS_UNAVAILABLE"
  | "CUSTOMER_RETURN_ORDER_ACCESS_CONFIGURATION_INVALID";

export class CustomerReturnOrderAccessError extends Error {
  constructor(
    public readonly code: CustomerReturnOrderAccessErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "CustomerReturnOrderAccessError";
  }
}

export interface CustomerReturnOrderAccessDependencies {
  /** Configured U.S. Shopify channel, resolved by trusted server configuration. */
  channelId: number;
  principalReader: CustomerReturnPrincipalReader;
  repository: CustomerReturnOrderAccessRepository;
}

export class CustomerReturnOrderAccessService {
  private readonly channelId: number;

  constructor(private readonly dependencies: CustomerReturnOrderAccessDependencies) {
    const configuredChannel = canonicalIdSchema.safeParse(dependencies.channelId);
    if (!configuredChannel.success) {
      throw new CustomerReturnOrderAccessError(
        "CUSTOMER_RETURN_ORDER_ACCESS_CONFIGURATION_INVALID",
        "Return order access is not configured.",
        503,
      );
    }
    this.channelId = configuredChannel.data;
  }

  async resolve(input: unknown): Promise<CustomerReturnOrderAccessResult> {
    const parsedInput = customerReturnOrderAccessInputSchema.safeParse(input);
    if (!parsedInput.success) throw invalidReference();

    let aliases: readonly string[];
    try {
      aliases = buildCustomerReturnOrderNumberAliases(parsedInput.data.orderReference);
    } catch (error) {
      if (error instanceof CustomerReturnOrderReferenceError) throw invalidReference();
      throw accessUnavailable();
    }

    const principal = await this.readPrincipal();
    if (principal === null || principal.channelId !== this.channelId) throw orderUnavailable();
    const scope: CustomerReturnOrderAccessScope = principal.kind === "customer"
      ? { kind: "customer", externalCustomerId: principal.externalCustomerId }
      : { kind: "order", omsOrderId: principal.omsOrderId, externalOrderId: principal.externalOrderId };

    let rawCandidates: readonly CustomerReturnOrderCandidate[];
    try {
      rawCandidates = await this.dependencies.repository.findExactOrderCandidates({
        channelId: this.channelId,
        scope,
        orderNumberAliases: aliases,
      });
    } catch {
      // Provider/DB exception messages can contain SQL, order references or PII.
      // Expose only this classified error; the interface can log its safe code.
      throw accessUnavailable();
    }

    const parsedCandidates = z.array(customerReturnOrderCandidateSchema).safeParse(rawCandidates);
    if (!parsedCandidates.success) throw accessUnavailable();
    const candidates = parsedCandidates.data;
    // Even a repository defect must not weaken authorization or exact matching.
    // Repeated rows are also fail-closed: the port promises distinct OMS orders.
    if (candidates.length !== 1) throw orderUnavailable();
    const candidate = candidates[0];
    if (
      candidate.channelId !== this.channelId
      || !aliases.includes(candidate.externalOrderNumber)
      || !matchesPrincipal(candidate, principal)
    ) throw orderUnavailable();

    // Only canonical order identity leaves this boundary. Fulfillment retrieval
    // must load every fulfillment by this OMS order, not by a display reference.
    return customerReturnOrderAccessResultSchema.parse({
      omsOrderId: candidate.omsOrderId,
      channelId: candidate.channelId,
      externalOrderId: candidate.externalOrderId,
      externalOrderNumber: candidate.externalOrderNumber,
    });
  }

  private async readPrincipal(): Promise<CustomerReturnVerifiedPrincipal | null> {
    let rawPrincipal: CustomerReturnVerifiedPrincipal | null;
    try {
      rawPrincipal = await this.dependencies.principalReader.getVerifiedPrincipal();
    } catch {
      throw accessUnavailable();
    }
    if (rawPrincipal === null) return null;
    const parsed = customerReturnVerifiedPrincipalSchema.safeParse(rawPrincipal);
    if (!parsed.success) throw accessUnavailable();
    return parsed.data;
  }
}

function matchesPrincipal(
  candidate: CustomerReturnOrderCandidate,
  principal: CustomerReturnVerifiedPrincipal,
): boolean {
  return principal.kind === "customer"
    ? candidate.externalCustomerId === principal.externalCustomerId
    : candidate.omsOrderId === principal.omsOrderId && candidate.externalOrderId === principal.externalOrderId;
}

function invalidReference(): CustomerReturnOrderAccessError {
  return new CustomerReturnOrderAccessError(
    "CUSTOMER_RETURN_ORDER_REFERENCE_INVALID", "Enter a valid order reference.", 400,
  );
}

function orderUnavailable(): CustomerReturnOrderAccessError {
  return new CustomerReturnOrderAccessError(
    "CUSTOMER_RETURN_ORDER_UNAVAILABLE", "This order is unavailable for returns.", 404,
  );
}

function accessUnavailable(): CustomerReturnOrderAccessError {
  return new CustomerReturnOrderAccessError(
    "CUSTOMER_RETURN_ORDER_ACCESS_UNAVAILABLE", "Return order access is temporarily unavailable.", 503,
  );
}
