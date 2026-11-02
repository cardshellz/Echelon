import { createHash } from "node:crypto";
import { canonicalJson } from "@shared/utils/canonical-json";

/** Pure economic/evidence identity; callers decide which facts belong in it. */
export function costFingerprint(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
