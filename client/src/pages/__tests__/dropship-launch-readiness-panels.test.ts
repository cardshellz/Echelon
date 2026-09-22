import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Source contract for the Launch Readiness tab of the staff Dropship page.
 *
 * The tab grew five panels that answered two questions between them, and a
 * blocker appeared in three of them at once, so an operator could not tell how
 * many problems they actually had. These pins keep each panel to one job.
 */
const source = readFileSync(join(__dirname, "..", "Dropship.tsx"), "utf8");

function componentSource(start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from, start).toBeGreaterThan(0);
  expect(to, end).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("Dropship launch readiness panels", () => {
  it("states the verdict once and sends the reader to the panel that owns the detail", () => {
    const gate = componentSource("function DogfoodLaunchGatePanel", "function LaunchGateMetric");

    // The verdict and its status stay.
    expect(gate).toContain("Can we run live orders?");
    expect(gate).toContain("dogfoodReadinessStatusTone(displayStatus)");
    expect(gate).toContain("Fix a blocker there, not here.");

    // Its blocker cards restated the checklist rows, and its four counters
    // restated the checklist counters. Neither comes back.
    expect(gate).not.toContain("firstBlockers");
    expect(gate).not.toContain("LaunchGateMetric");
    expect(gate).not.toContain("System blocked");
    expect(gate).not.toContain("Rows blocked");
  });

  it("names the checklist once, with its filters, counts and rows in one panel", () => {
    const tab = componentSource("function DogfoodReadinessTab", "function ListingPushOpsTab");
    const table = componentSource("function DogfoodReadinessTable", "function ListingPushJobsTable");

    expect(tab).toContain("Launch checklist");
    expect(tab).toContain('data-testid="launch-checklist-counts"');
    // The old second heading over the same rows is gone; the table keeps only
    // the row count, so the filters, the counts and the rows read as one panel.
    expect(table).not.toContain("Launch checklist");
    expect(table).toContain("matching row");
    expect(source.match(/Launch checklist/g)).toHaveLength(1);

    // The tab no longer has a panel called after the page's own tab name.
    expect(source).not.toContain("Dogfood readiness</h2>");
    expect(source).not.toContain("Dogfood launch gate");
  });

  it("says that smoke evidence answers a different question from the checklist", () => {
    const smoke = componentSource("function DogfoodSmokePanel", "function DogfoodSmokeCandidateCard");

    expect(smoke).toContain("Has a real order run end to end?");
    expect(smoke).toContain("Separate from the launch checklist");
    // It still reports what the server said about the evidence.
    expect(smoke).toContain("{smoke.message}");
  });

  it("keeps the environment panel and the manual sweeps as their own jobs", () => {
    const tab = componentSource("function DogfoodReadinessTab", "function ListingPushOpsTab");

    expect(tab).toContain("<SystemReadinessPanel");
    expect(tab).toContain("<WorkerSweepPanel");
    expect(tab).toContain("<DogfoodLaunchGatePanel");
    expect(tab).toContain("<DogfoodSmokePanel");
    expect(tab).toContain("<DogfoodReadinessTable");
  });
});
