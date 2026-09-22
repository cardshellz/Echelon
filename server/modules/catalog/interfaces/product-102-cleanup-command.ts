import {
  product102CleanupCommandSchema,
  Product102CleanupError,
  type Product102CleanupCommand,
} from "../domain/product-102-cleanup";

export type Product102CleanupCliInput =
  | { mode: "preview" }
  | { mode: "verify" }
  | { mode: "execute"; command: Product102CleanupCommand };

/** No positional IDs, fallback database, inferred approval or mutable command key. */
export function parseProduct102CleanupArguments(
  args: readonly string[],
): Product102CleanupCliInput {
  if (args.length === 0 || (args.length === 1 && args[0] === "--preview"))
    return { mode: "preview" };
  if (args.length === 1 && args[0] === "--verify") return { mode: "verify" };
  const invalid = () =>
    new Product102CleanupError(
      "CLEANUP_INVALID_ARGUMENTS",
      "Use --preview (default), --verify, or --execute --expected-hash HASH --actor-id ID --approval TEXT. Modes cannot be combined.",
    );
  if (args[0] !== "--execute" || args.length !== 7) throw invalid();
  const values: Record<string, string> = {};
  const allowed = ["--expected-hash", "--actor-id", "--approval"];
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index],
      value = args[index + 1];
    if (
      !allowed.includes(key) ||
      Object.hasOwn(values, key) ||
      !value ||
      value.startsWith("--")
    )
      throw invalid();
    values[key] = value;
  }
  return {
    mode: "execute",
    command: product102CleanupCommandSchema.parse({
      expectedHash: values["--expected-hash"],
      actorId: values["--actor-id"],
      approval: values["--approval"],
    }),
  };
}
