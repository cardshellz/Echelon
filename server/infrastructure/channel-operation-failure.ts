import { createHash } from "node:crypto";
import { channelOperationFailureSchema } from "@shared/channel-operation-failure";

/** pg-pool emits this exact, uncoded error when its acquisition deadline
 * expires. Match the library error, not arbitrary substring guesses. */
const POOL_ACQUISITION_TIMEOUT = "timeout exceeded when trying to connect";

export function channelOperationFailure(error: unknown) {
  if (!(error instanceof Error)) return undefined;
  const seen = new Set<Error>();
  const codes: string[] = [];
  let poolTimeout = false;
  let current: unknown = error;
  const hash = createHash("sha256");
  while (current instanceof Error && seen.size < 8 && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current ? current.code : undefined;
    if (typeof code === "string" && /^[A-Z0-9_]{1,100}$/.test(code)) codes.push(code);
    poolTimeout ||= current.message === POOL_ACQUISITION_TIMEOUT;
    hash.update(current.name).update("\0").update(current.message).update("\0").update(current.stack ?? "").update("\0");
    current = current.cause;
  }
  return channelOperationFailureSchema.parse({
    category: poolTimeout ? "pool_acquisition_timeout" : codes.some(code => /^[0-9]{2}[A-Z0-9]{3}$/.test(code)) ? "database" : "unexpected",
    errorType: /^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(error.name) ? error.name : "Error",
    codes: [...new Set(codes)], fingerprint: hash.digest("hex"),
  });
}
