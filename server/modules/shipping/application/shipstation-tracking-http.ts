const DEFAULT_MAX_RESPONSE_BYTES = 1_000_000;

export class ShipStationTrackingResponseReadError extends Error {
  readonly code = "RESPONSE_TOO_LARGE";

  constructor(
    message: string,
    readonly responseBytes: number,
    readonly maxResponseBytes: number,
  ) {
    super(message);
    this.name = "ShipStationTrackingResponseReadError";
  }
}

/**
 * Read a provider response without allowing an unbounded body to accumulate in
 * memory. Callers keep their AbortController timer active while this runs so
 * the timeout covers both response headers and body consumption.
 */
export async function readBoundedResponseText(
  response: Response,
  maxResponseBytes: number = DEFAULT_MAX_RESPONSE_BYTES,
): Promise<string> {
  if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("maxResponseBytes must be a positive integer");
  }

  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && /^\d+$/.test(contentLength)) {
    const declaredBytes = Number(contentLength);
    if (Number.isSafeInteger(declaredBytes) && declaredBytes > maxResponseBytes) {
      throw new ShipStationTrackingResponseReadError(
        "ShipStation tracking response exceeded the maximum accepted size",
        declaredBytes,
        maxResponseBytes,
      );
    }
  }

  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let responseBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      responseBytes += value.byteLength;
      if (responseBytes > maxResponseBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ShipStationTrackingResponseReadError(
          "ShipStation tracking response exceeded the maximum accepted size",
          responseBytes,
          maxResponseBytes,
        );
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, responseBytes).toString("utf8");
}
