import { z } from "zod";

const optionsSchema = z
  .object({
    mode: z.enum(["seed", "run", "status", "retry-review"]),
    channelId: z.coerce.number().int().positive().safe(),
    runKey: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    actor: z.string().trim().min(1).max(200),
    batches: z.coerce.number().int().min(1).max(1_000),
    execute: z.boolean(),
  })
  .strict();
export function parsePackageHistoryBackfillOptions(args: readonly string[]) {
  const values: Record<string, unknown> = {
    mode: "status",
    runKey: "history-v1",
    batches: 1,
    execute: false,
  };
  const names: Record<string, string> = {
    "--mode": "mode",
    "--channel-id": "channelId",
    "--run-key": "runKey",
    "--actor": "actor",
    "--batches": "batches",
  };
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (seen.has(argument))
      throw new Error("Duplicate package history argument");
    seen.add(argument);
    if (argument === "--execute") {
      values.execute = true;
      continue;
    }
    const name = names[argument];
    if (!name || index + 1 >= args.length || args[index + 1].startsWith("--"))
      throw new Error("Invalid package history argument");
    values[name] = args[++index];
  }
  return optionsSchema.parse(values);
}
