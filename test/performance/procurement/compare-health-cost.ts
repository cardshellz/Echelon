import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { z } from "zod";

const reportSchema = z.object({
  status: z.literal("passed"), disposed: z.literal(true), mode: z.enum(["unresolved", "posted"]).default("unresolved"),
  tiers: z.array(z.number().int().positive()),
  sourceBefore: z.record(z.string(), z.string().nullable()), sourceAfter: z.record(z.string(), z.string().nullable()),
  fingerprints: z.array(z.object({ tier: z.number(), unchanged: z.literal(true) })),
  measurements: z.array(z.object({ tier: z.number(), owner: z.string(), samples: z.array(z.object({
    elapsedMs: z.number().nonnegative(), queries: z.number().int().nonnegative(), value: z.unknown(),
  })).length(3) })),
});

/** Compare complete public owner outputs, with no ignored timestamps, money,
 * statuses or identities. Driver counts/timings are intentionally diagnostic. */
function read(path: string | undefined) {
  if (!path) throw new Error("Provide before and after report paths");
  const report = reportSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  assert.deepEqual(report.sourceBefore, report.sourceAfter, "Source changed during the measured run");
  assert.deepEqual(report.fingerprints.map(item => item.tier), report.tiers, "Every tier must retain its read-only fingerprint proof");
  for (const result of report.measurements) for (const sample of result.samples) {
    assert.deepEqual(sample.value, result.samples[0].value, `${result.owner}/${result.tier} changed between unchanged-data samples`);
  }
  return report;
}

const before = read(process.argv[2]);
const after = read(process.argv[3]);
assert.equal(before.mode, after.mode);
assert.deepEqual(before.tiers, after.tiers);
assert.deepEqual(before.measurements.map(row => [row.tier, row.owner]), after.measurements.map(row => [row.tier, row.owner]));
for (let index = 0; index < before.measurements.length; index++) {
  const original = before.measurements[index], current = after.measurements[index];
  assert.deepEqual(original.samples[0].value, current.samples[0].value, `${original.owner}/${original.tier} public output changed`);
  const ms = (samples: typeof original.samples) => samples.map(sample => Math.round(sample.elapsedMs));
  console.log(JSON.stringify({ tier: original.tier, owner: original.owner, identicalOutput: true,
    before: { queries: original.samples[0].queries, ms: ms(original.samples) },
    after: { queries: current.samples[0].queries, ms: ms(current.samples) } }));
}
