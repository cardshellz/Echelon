import { describe, expect, it } from "vitest";
import {
  DEFAULT_DROPSHIP_COST_CHANGE_POLICY,
  belowCostListingActionValues,
  costDecreaseTimingValues,
  dropshipCostChangePolicySettingsSchema,
  rulePricedListingActionValues,
  type DropshipCostChangePolicySettings,
} from "@shared/dropship/cost-change-policy";
import {
  DROPSHIP_BELOW_COST_LISTING_CHOICES,
  DROPSHIP_COST_CHANGE_ENFORCEMENT_PARTS,
  DROPSHIP_COST_CHANGE_SETTING_DESCRIPTORS,
  DROPSHIP_COST_CHANGE_SETTING_GROUPS,
  DROPSHIP_COST_CHANGE_SETTING_KEYS,
  DROPSHIP_COST_DECREASE_TIMING_CHOICES,
  DROPSHIP_RULE_PRICED_LISTING_CHOICES,
  buildDropshipCostChangePolicyVersionRequest,
  describeDropshipCostChangePolicyChanges,
  dropshipCostChangePolicyFormFromSettings,
  dropshipCostChangePolicyNeedsStaffConfirmation,
  dropshipCostChangePolicyRequestFingerprint,
  dropshipCostChangePolicySaveErrorMessage,
  dropshipCostChangePolicySettingsKey,
  formatDropshipCostChangePolicyActor,
  formatDropshipCostChangeSetting,
  isDropshipCostChangePolicyFormDirty,
  isDropshipCostChangePolicyPartlyEnforced,
  isDropshipCostChangeSettingInEffect,
  parseDropshipCostChangePolicyForm,
  parseDropshipCostChangePolicyMutation,
  parseDropshipCostChangePolicyOverview,
  summarizeDropshipCostChangePolicyVersion,
  type DropshipCostChangePolicyOverview,
  type DropshipCostChangePolicyRecordView,
} from "../dropship-cost-change-policy-model";

const defaults: DropshipCostChangePolicySettings = { ...DEFAULT_DROPSHIP_COST_CHANGE_POLICY };

const published: DropshipCostChangePolicySettings = {
  increaseNoticeDays: 21,
  decreaseTiming: "after_notice",
  priceProtection: true,
  retailChangesGetNotice: false,
  notifyByEmail: true,
  notifyInPortal: true,
  notifyOnDecrease: false,
  noticeMinimumChangeCents: 25,
  noticeMinimumChangeBps: 150,
  rulePricedListings: "wait_for_review",
  belowCostFixedListings: "pause_listing",
  detectionIntervalMinutes: 30,
};

const noneLive = { detection: false, priceProtection: false, vendorNotices: false, listingActions: false };
const allLive = { detection: true, priceProtection: true, vendorNotices: true, listingActions: true };

function formWith(patch: Partial<ReturnType<typeof dropshipCostChangePolicyFormFromSettings>> = {}) {
  return { ...dropshipCostChangePolicyFormFromSettings(published), changeNote: "Holiday catalog.", ...patch };
}

function record(
  settings: DropshipCostChangePolicySettings,
  patch: Partial<DropshipCostChangePolicyRecordView> = {},
): DropshipCostChangePolicyRecordView {
  return {
    policyId: 1,
    version: 1,
    settings,
    isActive: true,
    changeNote: "Initial defaults from migration 0710. Confirm or change them in Dropship, Cost changes.",
    createdAt: "2026-09-27T10:00:00.000Z",
    createdBy: { actorType: "system", actorId: "migration:0710" },
    deactivatedAt: null,
    ...patch,
  };
}

describe("setting descriptors", () => {
  it("describes every setting exactly once, in the fixed order, inside a known group", () => {
    const settings = DROPSHIP_COST_CHANGE_SETTING_DESCRIPTORS.map((descriptor) => descriptor.setting);
    expect(settings).toEqual([...DROPSHIP_COST_CHANGE_SETTING_KEYS]);
    expect([...settings].sort()).toEqual(Object.keys(dropshipCostChangePolicySettingsSchema.shape).sort());
    const groups = new Set(DROPSHIP_COST_CHANGE_SETTING_GROUPS.map((group) => group.group));
    for (const descriptor of DROPSHIP_COST_CHANGE_SETTING_DESCRIPTORS) {
      expect(groups.has(descriptor.group), descriptor.setting).toBe(true);
      expect(descriptor.label.trim()).not.toBe("");
      expect(descriptor.help.trim()).not.toBe("");
    }
  });

  it("offers every choice the shared schema allows, and no other", () => {
    expect(DROPSHIP_COST_DECREASE_TIMING_CHOICES.map((choice) => choice.value)).toEqual([...costDecreaseTimingValues]);
    expect(DROPSHIP_RULE_PRICED_LISTING_CHOICES.map((choice) => choice.value)).toEqual([...rulePricedListingActionValues]);
    expect(DROPSHIP_BELOW_COST_LISTING_CHOICES.map((choice) => choice.value)).toEqual([...belowCostListingActionValues]);
  });
});

describe("parseDropshipCostChangePolicyForm", () => {
  it("round-trips the settings in force", () => {
    for (const settings of [defaults, published]) {
      const parsed = parseDropshipCostChangePolicyForm({
        ...dropshipCostChangePolicyFormFromSettings(settings),
        changeNote: "  Confirmed.  ",
      });
      expect(parsed).toEqual({ success: true, settings, changeNote: "Confirmed." });
    }
  });

  it("reads dollars and percentages digit by digit, never through a float", () => {
    // 0.29 * 100 is 28.999999999999996 in floating point.
    const parsed = parseDropshipCostChangePolicyForm(formWith({
      noticeMinimumChange: "0.29",
      noticeMinimumChangePercent: "0.07",
    }));
    expect(parsed).toMatchObject({ success: true, settings: { noticeMinimumChangeCents: 29, noticeMinimumChangeBps: 7 } });
  });

  it("accepts the edges of every range", () => {
    const low = parseDropshipCostChangePolicyForm(formWith({
      increaseNoticeDays: "0",
      noticeMinimumChange: "0",
      noticeMinimumChangePercent: "0",
      detectionIntervalMinutes: "15",
    }));
    expect(low).toMatchObject({
      success: true,
      settings: { increaseNoticeDays: 0, noticeMinimumChangeCents: 0, noticeMinimumChangeBps: 0, detectionIntervalMinutes: 15 },
    });
    const high = parseDropshipCostChangePolicyForm(formWith({
      increaseNoticeDays: "90",
      noticeMinimumChange: "1000.00",
      noticeMinimumChangePercent: "100",
      detectionIntervalMinutes: "1440",
    }));
    expect(high).toMatchObject({
      success: true,
      settings: {
        increaseNoticeDays: 90,
        noticeMinimumChangeCents: 100_000,
        noticeMinimumChangeBps: 10_000,
        detectionIntervalMinutes: 1_440,
      },
    });
  });

  it("names the box that is out of range or unreadable", () => {
    const cases: Array<[Parameters<typeof formWith>[0], string]> = [
      [{ increaseNoticeDays: "91" }, "increaseNoticeDays"],
      [{ increaseNoticeDays: "-1" }, "increaseNoticeDays"],
      [{ increaseNoticeDays: "1.5" }, "increaseNoticeDays"],
      [{ increaseNoticeDays: "" }, "increaseNoticeDays"],
      [{ noticeMinimumChange: "1000.01" }, "noticeMinimumChange"],
      [{ noticeMinimumChange: "0.255" }, "noticeMinimumChange"],
      [{ noticeMinimumChange: "$1" }, "noticeMinimumChange"],
      [{ noticeMinimumChangePercent: "100.01" }, "noticeMinimumChangePercent"],
      [{ noticeMinimumChangePercent: "1.555" }, "noticeMinimumChangePercent"],
      [{ noticeMinimumChangePercent: "-1" }, "noticeMinimumChangePercent"],
      [{ detectionIntervalMinutes: "14" }, "detectionIntervalMinutes"],
      [{ detectionIntervalMinutes: "1441" }, "detectionIntervalMinutes"],
      [{ detectionIntervalMinutes: "0" }, "detectionIntervalMinutes"],
      [{ detectionIntervalMinutes: "sixty" }, "detectionIntervalMinutes"],
    ];
    for (const [patch, field] of cases) {
      const parsed = parseDropshipCostChangePolicyForm(formWith(patch));
      expect(parsed.success, JSON.stringify(patch)).toBe(false);
      if (!parsed.success) {
        expect(Object.keys(parsed.errors), JSON.stringify(patch)).toEqual([field]);
      }
    }
  });

  it("requires a change note of at most 1,000 characters", () => {
    for (const changeNote of ["", "   ", "x".repeat(1_001)]) {
      const parsed = parseDropshipCostChangePolicyForm(formWith({ changeNote }));
      expect(parsed.success).toBe(false);
      if (!parsed.success) expect(Object.keys(parsed.errors)).toEqual(["changeNote"]);
    }
    expect(parseDropshipCostChangePolicyForm(formWith({ changeNote: "x".repeat(1_000) })).success).toBe(true);
  });

  it("reports a bad box and a missing note together", () => {
    const parsed = parseDropshipCostChangePolicyForm(formWith({ increaseNoticeDays: "abc", changeNote: "" }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(Object.keys(parsed.errors).sort()).toEqual(["changeNote", "increaseNoticeDays"]);
  });
});

describe("isDropshipCostChangePolicyFormDirty", () => {
  it("is clean when every setting matches, whatever the note says", () => {
    expect(isDropshipCostChangePolicyFormDirty(formWith({ changeNote: "" }), published)).toBe(false);
    expect(isDropshipCostChangePolicyFormDirty(formWith({ changeNote: "Only a note." }), published)).toBe(false);
    // "14" and "14.0" are not both accepted; equal values in another spelling are still equal.
    expect(isDropshipCostChangePolicyFormDirty(formWith({ noticeMinimumChange: "0.25" }), published)).toBe(false);
    expect(isDropshipCostChangePolicyFormDirty(formWith({ noticeMinimumChangePercent: "1.5" }), published)).toBe(false);
  });

  it("is dirty when any setting differs, or a box cannot be read", () => {
    expect(isDropshipCostChangePolicyFormDirty(formWith({ increaseNoticeDays: "22" }), published)).toBe(true);
    expect(isDropshipCostChangePolicyFormDirty(formWith({ priceProtection: false }), published)).toBe(true);
    expect(isDropshipCostChangePolicyFormDirty(formWith({ belowCostFixedListings: "warn" }), published)).toBe(true);
    expect(isDropshipCostChangePolicyFormDirty(formWith({ increaseNoticeDays: "abc" }), published)).toBe(true);
  });
});

describe("dropshipCostChangePolicySettingsKey", () => {
  it("does not depend on key order", () => {
    const reversed = Object.fromEntries(Object.entries(published).reverse()) as DropshipCostChangePolicySettings;
    expect(dropshipCostChangePolicySettingsKey(reversed)).toBe(dropshipCostChangePolicySettingsKey(published));
    expect(dropshipCostChangePolicySettingsKey({ ...published, increaseNoticeDays: 22 }))
      .not.toBe(dropshipCostChangePolicySettingsKey(published));
  });
});

describe("dropshipCostChangePolicyNeedsStaffConfirmation", () => {
  function overview(policy: DropshipCostChangePolicyRecordView | null): DropshipCostChangePolicyOverview {
    return {
      policy,
      settings: policy?.settings ?? defaults,
      settingsSource: policy ? "policy" : "defaults",
      defaults,
      versions: policy ? [policy] : [],
      enforcement: noneLive,
      generatedAt: "2026-09-27T10:00:00.000Z",
    };
  }

  it("asks staff to confirm the migration's seed or the code defaults, not a staff version", () => {
    expect(dropshipCostChangePolicyNeedsStaffConfirmation(overview(null))).toBe(true);
    expect(dropshipCostChangePolicyNeedsStaffConfirmation(overview(record(defaults)))).toBe(true);
    expect(dropshipCostChangePolicyNeedsStaffConfirmation(overview(record(published, {
      createdBy: { actorType: "admin", actorId: "admin-1" },
    })))).toBe(false);
  });
});

describe("buildDropshipCostChangePolicyVersionRequest", () => {
  it("builds the body the server's strict schema expects", () => {
    const body = buildDropshipCostChangePolicyVersionRequest({
      settings: published,
      changeNote: "  Holiday catalog.  ",
      idempotencyKey: " dropship-cost-change-policy:abc123 ",
    });
    expect(body).toEqual({
      settings: published,
      changeNote: "Holiday catalog.",
      idempotencyKey: "dropship-cost-change-policy:abc123",
    });
    expect(Object.keys(body.settings)).toEqual([...DROPSHIP_COST_CHANGE_SETTING_KEYS]);
  });

  it("refuses what the server would refuse", () => {
    expect(() => buildDropshipCostChangePolicyVersionRequest({
      settings: { ...published, increaseNoticeDays: 91 },
      changeNote: "note",
      idempotencyKey: "dropship-cost-change-policy:abc123",
    })).toThrow("outside the policy rules");
    expect(() => buildDropshipCostChangePolicyVersionRequest({
      settings: published,
      changeNote: "  ",
      idempotencyKey: "dropship-cost-change-policy:abc123",
    })).toThrow("Change note");
    expect(() => buildDropshipCostChangePolicyVersionRequest({
      settings: published,
      changeNote: "note",
      idempotencyKey: "short",
    })).toThrow("Idempotency key");
  });
});

describe("dropshipCostChangePolicyRequestFingerprint", () => {
  it("is the same for the same request and different for any other", () => {
    const base = dropshipCostChangePolicyRequestFingerprint(published, "Holiday catalog.");
    expect(dropshipCostChangePolicyRequestFingerprint({ ...published }, "  Holiday catalog. ")).toBe(base);
    expect(dropshipCostChangePolicyRequestFingerprint(published, "Holiday catalog!")).not.toBe(base);
    expect(dropshipCostChangePolicyRequestFingerprint({ ...published, notifyByEmail: false }, "Holiday catalog."))
      .not.toBe(base);
  });
});

describe("formatDropshipCostChangeSetting", () => {
  it("prints each kind of setting in staff words", () => {
    expect(formatDropshipCostChangeSetting(published, "increaseNoticeDays")).toBe("21 days");
    expect(formatDropshipCostChangeSetting({ ...published, increaseNoticeDays: 1 }, "increaseNoticeDays")).toBe("1 day");
    expect(formatDropshipCostChangeSetting({ ...published, increaseNoticeDays: 0 }, "increaseNoticeDays"))
      .toBe("None (at once)");
    expect(formatDropshipCostChangeSetting(published, "decreaseTiming")).toBe("Apply after the same notice as an increase");
    expect(formatDropshipCostChangeSetting(published, "priceProtection")).toBe("On");
    expect(formatDropshipCostChangeSetting(published, "retailChangesGetNotice")).toBe("Off");
    expect(formatDropshipCostChangeSetting(published, "noticeMinimumChangeCents")).toBe("$0.25");
    expect(formatDropshipCostChangeSetting({ ...published, noticeMinimumChangeCents: 100_000 }, "noticeMinimumChangeCents"))
      .toBe("$1,000.00");
    expect(formatDropshipCostChangeSetting(defaults, "noticeMinimumChangeCents")).toBe("No minimum");
    expect(formatDropshipCostChangeSetting(published, "noticeMinimumChangeBps")).toBe("1.50%");
    expect(formatDropshipCostChangeSetting(defaults, "noticeMinimumChangeBps")).toBe("No minimum");
    expect(formatDropshipCostChangeSetting(published, "rulePricedListings")).toBe("Wait for the vendor to review them");
    expect(formatDropshipCostChangeSetting(published, "belowCostFixedListings")).toBe("Pause the listing");
    expect(formatDropshipCostChangeSetting({ ...published, detectionIntervalMinutes: 1_440 }, "detectionIntervalMinutes"))
      .toBe("1,440 minutes");
  });
});

describe("version history", () => {
  it("lists what each version changed from the one before it", () => {
    expect(describeDropshipCostChangePolicyChanges(defaults, { ...defaults, increaseNoticeDays: 21, notifyOnDecrease: false }))
      .toEqual([
        {
          setting: "increaseNoticeDays",
          label: "Notice before a higher cost is charged",
          from: "14 days",
          to: "21 days",
        },
        {
          setting: "notifyOnDecrease",
          label: "Also tell vendors when a cost goes down",
          from: "On",
          to: "Off",
        },
      ]);
    expect(describeDropshipCostChangePolicyChanges(defaults, { ...defaults })).toEqual([]);
  });

  it("summarizes the first version, a change, a confirmation, and a version whose predecessor is not listed", () => {
    const versions = [
      record(published, { policyId: 4, version: 4, createdBy: { actorType: "admin", actorId: "admin-1" } }),
      record(defaults, { policyId: 3, version: 3, isActive: false }),
      record(defaults, { policyId: 2, version: 2, isActive: false }),
    ];
    expect(summarizeDropshipCostChangePolicyVersion(versions, 0)).toMatchObject({ kind: "changes" });
    expect(summarizeDropshipCostChangePolicyVersion(versions, 1)).toEqual({ kind: "confirmed" });
    expect(summarizeDropshipCostChangePolicyVersion(versions, 2)).toEqual({ kind: "earlier_not_listed" });
    expect(summarizeDropshipCostChangePolicyVersion([record(defaults)], 0)).toEqual({ kind: "first" });
    expect(() => summarizeDropshipCostChangePolicyVersion(versions, 3)).toThrow();
  });

  it("names who published a version", () => {
    expect(formatDropshipCostChangePolicyActor({ actorType: "system", actorId: "migration:0710" }))
      .toBe("System (migration:0710)");
    expect(formatDropshipCostChangePolicyActor({ actorType: "admin", actorId: "admin-1" })).toBe("Staff user admin-1");
    expect(formatDropshipCostChangePolicyActor({ actorType: "admin", actorId: null })).toBe("Staff user (not recorded)");
  });
});

describe("enforcement", () => {
  it("treats a setting as acting only when every part it needs is live", () => {
    for (const setting of DROPSHIP_COST_CHANGE_SETTING_KEYS) {
      expect(isDropshipCostChangeSettingInEffect(setting, noneLive), setting).toBe(false);
      expect(isDropshipCostChangeSettingInEffect(setting, allLive), setting).toBe(true);
    }
    // Detection alone schedules nothing that is charged, sent or applied.
    const detectionOnly = { ...noneLive, detection: true };
    expect(isDropshipCostChangeSettingInEffect("detectionIntervalMinutes", detectionOnly)).toBe(true);
    expect(isDropshipCostChangeSettingInEffect("increaseNoticeDays", detectionOnly)).toBe(false);
    expect(isDropshipCostChangeSettingInEffect("notifyByEmail", detectionOnly)).toBe(false);
    expect(isDropshipCostChangeSettingInEffect("rulePricedListings", detectionOnly)).toBe(false);
    // A part without detection is not enough either.
    expect(isDropshipCostChangeSettingInEffect("notifyByEmail", { ...noneLive, vendorNotices: true })).toBe(false);
  });

  it("says what happens today until every part is live", () => {
    expect(isDropshipCostChangePolicyPartlyEnforced(noneLive)).toBe(true);
    expect(isDropshipCostChangePolicyPartlyEnforced({ ...allLive, listingActions: false })).toBe(true);
    expect(isDropshipCostChangePolicyPartlyEnforced(allLive)).toBe(false);
    expect(DROPSHIP_COST_CHANGE_ENFORCEMENT_PARTS.map(({ part }) => part).sort())
      .toEqual(Object.keys(allLive).sort());
  });
});

describe("server faces", () => {
  it("turns the known codes into instructions and keeps the server's words for the rest", () => {
    for (const code of [
      "DROPSHIP_COST_CHANGE_POLICY_CONFLICT",
      "DROPSHIP_COST_CHANGE_POLICY_IDEMPOTENCY_CONFLICT",
      "DROPSHIP_COST_CHANGE_POLICY_COMMAND_INCOMPLETE",
      "DROPSHIP_COST_CHANGE_POLICY_TABLE_MISSING",
    ]) {
      const message = dropshipCostChangePolicySaveErrorMessage(code, "server words");
      expect(message, code).toContain("nothing was saved");
    }
    expect(dropshipCostChangePolicySaveErrorMessage("DROPSHIP_COST_CHANGE_POLICY_INVALID_INPUT", "bad value"))
      .toBe("The server refused these settings: bad value");
    expect(dropshipCostChangePolicySaveErrorMessage("SOMETHING_NEW", "server words")).toBe("server words");
    // No code means no structured answer at all: the save is unconfirmed, and a retry is safe.
    expect(dropshipCostChangePolicySaveErrorMessage(null, "Service Unavailable")).toBe(
      "Service Unavailable. The server did not confirm the save, so it may or may not have been published. "
        + "Try again: retrying the same change cannot publish it twice.",
    );
    expect(dropshipCostChangePolicySaveErrorMessage(null, "Failed to fetch.")).toMatch(/^Failed to fetch\. The server/);
  });

  it("accepts the overview and save responses the server sends", () => {
    const policy = record(published, { createdBy: { actorType: "admin", actorId: "admin-1" } });
    const overview = parseDropshipCostChangePolicyOverview({
      policy,
      settings: published,
      settingsSource: "policy",
      defaults,
      versions: [policy],
      enforcement: noneLive,
      generatedAt: "2026-09-27T10:00:00.000Z",
    });
    expect(overview.settings).toEqual(published);
    expect(parseDropshipCostChangePolicyMutation({ policy, previousPolicy: null, idempotentReplay: false }).policy.version)
      .toBe(1);
  });

  it("refuses a response outside the settings contract, naming where", () => {
    expect(() => parseDropshipCostChangePolicyOverview({
      policy: null,
      settings: { ...published, increaseNoticeDays: 91 },
      settingsSource: "defaults",
      defaults,
      versions: [],
      enforcement: noneLive,
      generatedAt: "2026-09-27T10:00:00.000Z",
    })).toThrow("settings.increaseNoticeDays");
    expect(() => parseDropshipCostChangePolicyOverview({ policy: null })).toThrow("cost change policy response");
  });
});
