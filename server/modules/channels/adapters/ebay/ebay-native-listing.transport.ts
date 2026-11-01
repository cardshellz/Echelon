import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  ChannelProviderReadError,
  providerHttpReadFailureKind,
  type ChannelProviderReadDiagnostic,
} from "@shared/channel-provider-read";
import { EbayListingSyncError } from "../../ebay-listing-sync.domain";

const MAX_NATIVE_RESPONSE_BYTES = 256_000;
export interface EbayNativeListingRead {
  listingId: string;
  accessToken: string;
  environment: "production" | "sandbox";
  fields: readonly string[];
  resource: string;
  codePrefix: "EBAY_PACKAGE" | "EBAY_PUBLISHED_CONTENT";
  request?: typeof fetch;
}

export function nativeListingReadFailure(
  input: Pick<EbayNativeListingRead, "resource" | "codePrefix">,
  kind: ChannelProviderReadDiagnostic["kind"] = "invalid_response",
  httpStatus?: number,
  cause?: unknown,
): EbayListingSyncError {
  return new EbayListingSyncError(
    httpStatus === 401
      ? "EBAY_AUTH_REQUIRED"
      : `${input.codePrefix}_READ_${kind === "unavailable" ? "UNAVAILABLE" : "INVALID"}`,
    "Echelon could not verify the published eBay listing. The saved update retains its write evidence and will retry the read.",
    {
      cause: new ChannelProviderReadError(
        {
          provider: "ebay",
          resource: input.resource,
          method: "POST",
          kind,
          ...(httpStatus === undefined ? {} : { httpStatus }),
        },
        { cause },
      ),
    },
  );
}

/** One bounded, authenticated Trading GetItem transport. Each projection
 * validates its own fields; reads never bypass the normal mutation owner. */
export async function readEbayNativeListing(
  input: EbayNativeListingRead,
): Promise<{ body: unknown; httpStatus: number }> {
  if (
    !/^\d{1,30}$/.test(input.listingId) ||
    input.fields.some((field) => !/^[A-Za-z][A-Za-z0-9.]*$/.test(field))
  )
    throw nativeListingReadFailure(input);
  const host =
    input.environment === "production"
      ? "api.ebay.com"
      : "api.sandbox.ebay.com";
  let response: Response;
  try {
    response = await (input.request ?? fetch)(`https://${host}/ws/api.dll`, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
      headers: {
        "Content-Type": "text/xml",
        "X-EBAY-API-CALL-NAME": "GetItem",
        "X-EBAY-API-COMPATIBILITY-LEVEL": "1477",
        "X-EBAY-API-SITEID": "0",
        "X-EBAY-API-IAF-TOKEN": input.accessToken,
      },
      body:
        `<?xml version="1.0" encoding="utf-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${input.listingId}</ItemID>` +
        input.fields
          .map((field) => `<OutputSelector>${field}</OutputSelector>`)
          .join("") +
        "</GetItemRequest>",
    });
  } catch (cause) {
    throw nativeListingReadFailure(input, "unavailable", undefined, cause);
  }
  if (!response.ok) {
    try {
      await response.body?.cancel();
    } finally {
      throw nativeListingReadFailure(
        input,
        providerHttpReadFailureKind(response.status),
        response.status,
      );
    }
  }
  if (!response.body) throw nativeListingReadFailure(input);
  const reader = response.body.getReader(),
    decoder = new TextDecoder();
  let raw = "",
    size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_NATIVE_RESPONSE_BYTES)
        throw nativeListingReadFailure(input);
      raw += decoder.decode(part.value, { stream: true });
    }
    raw += decoder.decode();
  } catch (cause) {
    if (cause instanceof EbayListingSyncError) throw cause;
    throw nativeListingReadFailure(
      input,
      "unavailable",
      response.status,
      cause,
    );
  } finally {
    try {
      await reader.cancel();
    } catch {
      console.warn(
        JSON.stringify({
          event: "ebay_native_read_cleanup_failed",
          resource: input.resource,
        }),
      );
    } finally {
      reader.releaseLock();
    }
  }
  if (
    /<!\s*(?:DOCTYPE|ENTITY)/i.test(raw) ||
    XMLValidator.validate(raw) !== true
  )
    throw nativeListingReadFailure(input);
  return {
    body: new XMLParser({
      parseTagValue: false,
      ignoreAttributes: true,
      removeNSPrefix: true,
      processEntities: true,
      htmlEntities: true,
    }).parse(raw),
    httpStatus: response.status,
  };
}
