import { channelProviderReadDiagnosticSchema, type ChannelProviderReadDiagnostic } from "@shared/channel-provider-read";
import type { EbayRegistrationReadResponse } from "./ebay-registration-contracts";

/** Translate eBay read evidence into the shared safe diagnostic contract. */
export function ebayReadDiagnostic(resource: string, kind: ChannelProviderReadDiagnostic["kind"],
  response?: Pick<EbayRegistrationReadResponse, "status" | "requestId">,
  issues?: ReadonlyArray<{ path: readonly (string | number)[]; code: string }>): ChannelProviderReadDiagnostic {
  const requestId = channelProviderReadDiagnosticSchema.shape.requestId.safeParse(response?.requestId);
  const status = channelProviderReadDiagnosticSchema.shape.httpStatus.safeParse(response?.status);
  return channelProviderReadDiagnosticSchema.parse({
    provider: "ebay", resource, method: "GET", kind,
    ...(status.success && status.data !== undefined ? { httpStatus: status.data } : {}),
    ...(requestId.success && requestId.data ? { requestId: requestId.data } : {}),
    ...(issues ? { issues: issues.slice(0, 25).map(issue => ({ path: issue.path.join(".").slice(0, 240), code: issue.code })),
      issuesTruncated: issues.length > 25 } : {}),
  });
}

export function ebayReadFailureKind(status: number): ChannelProviderReadDiagnostic["kind"] {
  return status === 408 || status === 429 || status >= 500 ? "unavailable" : "refused";
}
