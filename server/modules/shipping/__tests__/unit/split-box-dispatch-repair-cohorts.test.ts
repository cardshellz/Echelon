import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { parseFlags } from "../../../../../scripts/repair-historical-carrier-dispatch";

// 2026-10-06 (#63662): two carrier-dispatch failures parked packages whose
// fulfillment was already correct. Both code paths are fixed; a reviewed rerun
// (a7899a26) replays the allocation record or admits the split sibling box.
describe("parked carrier dispatches from the split-box bugs", () => {
  const repository = readFileSync(resolve(process.cwd(), "server/modules/shipping/carrier-tracking.repository.ts"), "utf8");
  const eligibility = repository.slice(repository.indexOf("function historicalCarrierDispatchRepairEligibilitySql"));
  const requeueable = eligibility.slice(0, eligibility.indexOf("OR ("));

  it("selects the label-time double count by its exact allocation reasons", () => {
    expect(repository).toContain("THEN 'label_time_package_replay'");
    expect(repository).toContain("= 'FULFILLMENT_AUTHORITY_EXCEEDED'");
    expect(repository).toContain(
      "'^Cannot allocate package [^ ]+ to OMS line [0-9]+: (physical_quantity_exceeds_paid_authority|physical_package_already_allocated)$'",
    );
    expect(requeueable).toContain("'label_time_package_replay'");
  });

  it("selects the split sibling box misread as a relabel", () => {
    expect(repository).toContain("THEN 'split_sibling_relabel_misread'");
    expect(repository).toContain("command.last_error_message = 'replaced_label_has_carrier_possession'");
    expect(requeueable).toContain("'split_sibling_relabel_misread'");
  });

  it.each(["label_time_package_replay", "split_sibling_relabel_misread"])(
    "lets the operator repair script select %s",
    (cohort) => {
      expect(parseFlags([`--cohort=${cohort}`]).cohort).toBe(cohort);
    },
  );
});
