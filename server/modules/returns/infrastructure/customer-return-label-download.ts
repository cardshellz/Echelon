import { returnLabelDownloadUrlSchema } from "../../shipping-engine/application/return-label-provider.port";
import { CustomerReturnIntakeError } from "../application/customer-return-intake.ports";

const MAX_LABEL_BYTES = 10 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 15_000;
/** No credentials are forwarded, redirects cannot escape the provider allowlist. */
export async function downloadCustomerReturnLabel(
  rawUrl: string,
  request: typeof fetch = fetch,
): Promise<Uint8Array> {
  const url = returnLabelDownloadUrlSchema.parse(rawUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await request(url, {
      method: "GET",
      redirect: "error",
      cache: "no-store",
      signal: controller.signal,
      headers: { Accept: "application/pdf" },
    });
    const size = response.headers.get("content-length");
    if (
      !response.ok ||
      response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase() !== "application/pdf" ||
      (size !== null &&
        (!/^\d+$/.test(size) || Number(size) > MAX_LABEL_BYTES)) ||
      !response.body
    ) {
      await response.body?.cancel();
      throw unavailable();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > MAX_LABEL_BYTES) throw unavailable();
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const result = Buffer.concat(chunks);
    if (result.subarray(0, 5).toString("ascii") !== "%PDF-")
      throw unavailable();
    return result;
  } catch {
    throw unavailable();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
function unavailable(): CustomerReturnIntakeError {
  return new CustomerReturnIntakeError(
    "RETURN_LABEL_DOWNLOAD_UNAVAILABLE",
    "This label could not be downloaded. Try the saved label again.",
    503,
  );
}
