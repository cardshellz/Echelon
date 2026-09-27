import { z } from "zod";
import {
  returnPolicyArchiveInputSchema,
  returnPolicyArchivePreviewSchema,
  returnPolicyArchiveResultSchema,
  type ReturnPolicyArchiveInput,
} from "@shared/returns/return-policy-archive.contract";

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface ReturnPolicyArchiveReferences {
  channels: readonly { id: number; name: string }[];
  vendors: readonly { id: number; name: string }[];
  stores: readonly { id: number; name: string }[];
}

/** Add names to display-only scope labels; never change their IDs or exclusions. */
export function formatReturnPolicyArchiveContext(
  label: string,
  references: ReturnPolicyArchiveReferences,
): string {
  const namedId = (
    id: string,
    entries: readonly { id: number; name: string }[],
  ) => {
    const entry = entries.find((candidate) => String(candidate.id) === id);
    return entry ? `${entry.name} (#${id})` : id;
  };
  // Process only the server's complete scope segments. Unrecognized future
  // grammar remains intact rather than making an incomplete impact claim.
  return label
    .split(" · ")
    .map((segment) => {
      const direct = /^(Channel|Vendor|Store) (\d+)$/.exec(segment);
      if (direct) {
        const entries =
          direct[1] === "Channel"
            ? references.channels
            : direct[1] === "Vendor"
              ? references.vendors
              : references.stores;
        return `${direct[1]} ${namedId(direct[2], entries)}`;
      }
      const residual =
        /^Other (channels|vendors|stores) \(excluding (\d+(?:, \d+)*)\)(, including unassigned)?$/.exec(
          segment,
        );
      if (!residual) return segment;
      const entries =
        residual[1] === "channels"
          ? references.channels
          : residual[1] === "vendors"
            ? references.vendors
            : references.stores;
      const excluded = residual[2]
        .split(", ")
        .map((id) => namedId(id, entries))
        .join(", ");
      return `Other ${residual[1]} (excluding ${excluded})${residual[3] ?? ""}`;
    })
    .join(" · ");
}
const policyIdSchema = z.number().int().positive().safe();
const errorSchema = z.object({
  error: z.object({ code: z.string().max(100) }),
});

export class ReturnPolicyArchiveError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ReturnPolicyArchiveError";
  }
}

async function readArchiveResponse<T extends z.ZodTypeAny>(
  response: Response,
  schema: T,
): Promise<z.output<T>> {
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(body);
    const code =
      response.status === 401 || response.status === 403
        ? "RETURN_POLICY_ACCESS_REQUIRED"
        : parsed.success
          ? parsed.data.error.code
          : "RETURN_POLICY_ARCHIVE_UNCONFIRMED";
    const message =
      code === "RETURN_POLICY_ACCESS_REQUIRED"
        ? "Administrator access is required to archive a policy."
        : code === "RETURN_POLICY_ARCHIVE_CHANGED"
          ? "The policy or its impact changed. Refresh the impact and review it before archiving."
          : code === "RETURN_POLICY_NOT_ACTIVE"
            ? "This policy is no longer active. Close this review and refresh the policies."
            : "The archive outcome could not be confirmed. Retry the same request to check its outcome.";
    throw new ReturnPolicyArchiveError(code, message);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ReturnPolicyArchiveError(
      "RETURN_POLICY_RESPONSE_INVALID",
      "The archive response could not be verified. Retry before assuming the policy was archived.",
    );
  return parsed.data;
}

export async function loadReturnPolicyArchivePreview(
  policyId: number,
  signal: AbortSignal,
  request: FetchRequest = fetch,
) {
  policyIdSchema.parse(policyId);
  const preview = await readArchiveResponse(
    await request(`/api/returns/admin/policies/${policyId}/archive-preview`, {
      credentials: "include",
      cache: "no-store",
      signal,
    }),
    returnPolicyArchivePreviewSchema,
  );
  if (preview.policy.id !== policyId || preview.policy.status !== "active")
    throw new ReturnPolicyArchiveError(
      "RETURN_POLICY_RESPONSE_INVALID",
      "The archive impact does not match this active policy. Refresh the impact.",
    );
  return preview;
}

export async function archiveReturnPolicy(
  policyId: number,
  raw: ReturnPolicyArchiveInput,
  idempotencyKey: string,
  signal: AbortSignal,
  request: FetchRequest = fetch,
) {
  policyIdSchema.parse(policyId);
  const input = returnPolicyArchiveInputSchema.parse(raw);
  z.string().uuid().parse(idempotencyKey);
  const result = await readArchiveResponse(
    await request(`/api/returns/admin/policies/${policyId}/archive`, {
      method: "POST",
      credentials: "include",
      cache: "no-store",
      signal,
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(input),
    }),
    returnPolicyArchiveResultSchema,
  );
  if (
    result.policy.id !== policyId ||
    result.policy.version !== input.expectedVersion ||
    result.policy.status !== "retired"
  )
    throw new ReturnPolicyArchiveError(
      "RETURN_POLICY_RESPONSE_INVALID",
      "The archive result does not match this policy. Retry before assuming it was archived.",
    );
  return result;
}
