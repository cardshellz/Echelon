import * as React from "react";
import { createElement, isValidElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AddDestinationGroupButton,
  CoverageCell,
} from "../pricing-programs/ProgramDetail";
import type {
  ProgramDestinationGroup,
  ProgramOptionState,
  RateTableCoverage,
  RateTableSummary,
  ServiceLevelOption,
} from "../pricing-programs/api";

vi.stubGlobal("React", React);

const destination = {
  destinationCountry: "US",
  destinationRegion: "PA",
  postalPrefix: null,
};

const group: ProgramDestinationGroup = {
  key: "id:41",
  id: 41,
  rateBookId: 7,
  name: "Northeast",
  sortOrder: 1,
  lockVersion: 3,
  destinations: [destination],
  hasCurrentDefinition: true,
  appearsInLiveRevision: true,
  appearsInDraftRevision: false,
};

const serviceLevel: ServiceLevelOption = {
  id: 11,
  code: "standard",
  displayName: "Standard Shipping",
  description: null,
  fulfillmentMode: "parcel",
  promiseMinBusinessDays: null,
  promiseMaxBusinessDays: null,
  isActive: true,
};

function coverage(rateTableId: number): RateTableCoverage {
  return {
    id: rateTableId * 10,
    rateTableId,
    destinationGroupId: 41,
    originWarehouseId: null,
    availability: "offered",
    destinationGroupLockVersion: 3,
    destinationGroupName: "Northeast",
    name: "Northeast",
    sortOrder: 1,
    rateRowCount: 4,
    destinations: [destination],
  };
}

function rateTable(id: number, status: "active" | "draft"): RateTableSummary {
  return {
    id,
    rateBookId: 7,
    serviceLevelId: serviceLevel.id,
    pricingBasis: "shipment_weight",
    currency: "USD",
    status,
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveTo: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    metadata: null,
    rateBook: null,
    serviceLevel,
    coverages: [coverage(id)],
    rowCount: 4,
    regionCount: 1,
    stateCount: 1,
    zipOverrideCount: 0,
    productRuleCount: 0,
    minMeasure: 0,
    maxMeasure: 10,
  };
}

function renderCell(option: ProgramOptionState): string {
  return renderToStaticMarkup(createElement(CoverageCell, {
    group,
    option,
    warehouses: [],
    programRetired: false,
    onViewTable: vi.fn(),
    onContinueDraft: vi.fn(),
    onCreateRevision: vi.fn(),
    onStartRates: vi.fn(),
  }));
}

describe("pricing program coverage cell", () => {
  it("renders active coverage as status with separate read and edit commands", () => {
    const active = rateTable(101, "active");
    const html = renderCell({ serviceLevel, active, draft: null, history: [active] });

    expect(html).toContain('role="status"');
    expect(html).toContain("Active rates");
    expect(html).toContain("View live revision");
    expect(html).toContain("Edit rates");
    expect(html).not.toContain("View draft revision");
    expect(html).not.toContain("Continue editing");
  });

  it("shows existing drafts as pending work without hiding live revision access", () => {
    const active = rateTable(101, "active");
    const draft = rateTable(102, "draft");
    const html = renderCell({ serviceLevel, active, draft, history: [draft, active] });

    expect(html).toContain("View live revision");
    expect(html).toContain("View draft revision");
    expect(html).toContain("Continue editing");
    expect(html).not.toContain("Edit rates");
  });

  it("uses an explicit setup command when no revision exists", () => {
    const html = renderCell({ serviceLevel, active: null, draft: null, history: [] });

    expect(html).toContain("Not configured");
    expect(html).toContain("Set up rates");
    expect(html).not.toContain("View live revision");
  });
});

describe("add destination group", () => {
  function clickAddDestinationGroup(
    option: ProgramOptionState,
    callbacks: {
      onContinueDraft: ReturnType<typeof vi.fn>;
      onRequestCreateRevision: ReturnType<typeof vi.fn>;
      onStartRates: ReturnType<typeof vi.fn>;
    },
  ): void {
    const button = AddDestinationGroupButton({
      options: [option],
      ...callbacks,
    });
    if (!isValidElement<{ onClick: () => void }>(button)) {
      throw new Error("Expected Add destination group button to render.");
    }
    button.props.onClick();
  }

  it("requests confirmation before cloning an active revision", () => {
    const active = rateTable(101, "active");
    const callbacks = {
      onContinueDraft: vi.fn(),
      onRequestCreateRevision: vi.fn(),
      onStartRates: vi.fn(),
    };

    clickAddDestinationGroup(
      { serviceLevel, active, draft: null, history: [active] },
      callbacks,
    );

    expect(callbacks.onRequestCreateRevision).toHaveBeenCalledOnce();
    expect(callbacks.onRequestCreateRevision).toHaveBeenCalledWith(
      active.id,
      serviceLevel.displayName,
    );
    expect(callbacks.onContinueDraft).not.toHaveBeenCalled();
    expect(callbacks.onStartRates).not.toHaveBeenCalled();
  });

  it("opens an existing draft without requesting another revision", () => {
    const active = rateTable(101, "active");
    const draft = rateTable(102, "draft");
    const callbacks = {
      onContinueDraft: vi.fn(),
      onRequestCreateRevision: vi.fn(),
      onStartRates: vi.fn(),
    };

    clickAddDestinationGroup(
      { serviceLevel, active, draft, history: [draft, active] },
      callbacks,
    );

    expect(callbacks.onContinueDraft).toHaveBeenCalledWith(draft.id);
    expect(callbacks.onRequestCreateRevision).not.toHaveBeenCalled();
    expect(callbacks.onStartRates).not.toHaveBeenCalled();
  });

  it("starts unsaved setup when no revision exists", () => {
    const callbacks = {
      onContinueDraft: vi.fn(),
      onRequestCreateRevision: vi.fn(),
      onStartRates: vi.fn(),
    };

    clickAddDestinationGroup(
      { serviceLevel, active: null, draft: null, history: [] },
      callbacks,
    );

    expect(callbacks.onStartRates).toHaveBeenCalledWith(serviceLevel.code);
    expect(callbacks.onContinueDraft).not.toHaveBeenCalled();
    expect(callbacks.onRequestCreateRevision).not.toHaveBeenCalled();
  });
});
