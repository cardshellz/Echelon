import { describe, expect, it } from "vitest";
import {
  buildBulkAttributeColumns,
  buildBulkAttributeColumnsForRows,
  BULK_ATTRIBUTE_COLUMN_LIMITS,
  parseBulkAttributeCellInput,
  type BulkAttributeColumn,
} from "../bulk-attribute-columns";
import type { FieldSchema } from "../schema-field-model";

const schema: FieldSchema = {
  type: "object",
  required: ["Orderable", "Visible"],
  properties: {
    Orderable: {
      type: "object",
      title: "Shipping and offer details",
      required: ["weight"],
      properties: {
        weight: { type: "number", title: "Shipping weight", minimum: 0 },
        shipsInOwnContainer: {
          type: "boolean",
          title: "Ships in its own container",
        },
        dimensions: {
          type: "object",
          title: "Package dimensions",
          required: ["width"],
          properties: {
            width: { type: "number", title: "Width" },
            unit: { type: "string", title: "Unit", enum: ["in", "cm"] },
          },
        },
        packages: {
          type: "array",
          items: { type: "object", properties: { count: { type: "integer" } } },
        },
      },
    },
    Visible: {
      type: "object",
      title: "Product attributes",
      properties: {
        hasWarranty: { type: "boolean", title: "Has warranty" },
        warrantyText: { type: "string", title: "Warranty text" },
        multipack: { type: "integer", minimum: 1 },
        color: { type: "string", enum: ["Red", "Blue"] },
      },
      allOf: [
        {
          if: {
            properties: { hasWarranty: { const: true } },
            required: ["hasWarranty"],
          },
          then: { required: ["warrantyText"] },
        },
      ],
    },
  },
};
const key = (...path: string[]) => JSON.stringify(path);
const column = (path: string[]) =>
  buildBulkAttributeColumns(schema, [{}]).columns.find(
    (column) => column.key === JSON.stringify(path),
  )!;

describe("provider-derived bulk attribute columns", () => {
  it("derives nested measurement, unit, and optional packaging fields without provider name assumptions", () => {
    const result = buildBulkAttributeColumns(schema, [{}]);
    expect(result.columns.map((column) => column.path)).toContainEqual([
      "Orderable",
      "shipsInOwnContainer",
    ]);
    expect(
      result.columns.find(
        (column) => column.key === key("Orderable", "dimensions", "width"),
      ),
    ).toMatchObject({
      label: "Width",
      group: "Shipping and offer details › Package dimensions",
      pathLabel: "Shipping and offer details › Package dimensions › Width",
      type: "number",
      required: false,
    });
    expect(
      result.columns.find((column) => column.key === key("Orderable", "weight"))
        ?.required,
    ).toBe(true);
  });
  it("preserves exact ancestor guidance on flattened measurement fields without inferring values", () => {
    // Synthetic annotations exercise the generic contract, not category rules.
    const input: FieldSchema = {
      type: "object",
      properties: {
        Visible: {
          type: "object",
          title: "Product attributes",
          description: "Describe the item being sold.",
          properties: {
            netContent: {
              type: "object",
              title: "Net Content",
              description:
                "  Provider guidance for the measure and unit together.  ",
              properties: {
                unit: {
                  type: "string",
                  title: "Unit",
                  enum: ["Each", "Count"],
                },
                measure: {
                  type: "number",
                  title: "Measure",
                  description: "Provider measure guidance.",
                },
              },
            },
          },
        },
      },
    };
    const values = [{ Visible: { netContent: { unit: "Each" } } }, {}];
    const before = structuredClone({ input, values });
    const result = buildBulkAttributeColumns(input, values);
    const inherited = [
      {
        path: ["Visible"],
        label: "Product attributes",
        description: "Describe the item being sold.",
      },
      {
        path: ["Visible", "netContent"],
        label: "Net Content",
        description: "  Provider guidance for the measure and unit together.  ",
      },
    ];
    expect(
      result.columns.find((entry) => entry.path.at(-1) === "unit")?.help,
    ).toEqual(inherited);
    expect(
      result.columns.find((entry) => entry.path.at(-1) === "measure")?.help,
    ).toEqual([
      ...inherited,
      {
        path: ["Visible", "netContent", "measure"],
        label: "Measure",
        description: "Provider measure guidance.",
      },
    ]);
    expect({ input, values }).toEqual(before);
  });
  it("includes complex-field help and skips absent or blank annotations", () => {
    const input: FieldSchema = {
      type: "object",
      properties: {
        Visible: {
          type: "object",
          description: "   ",
          properties: {
            contents: {
              type: "array",
              title: "Contents",
              description: "Provider list guidance.",
              items: { type: "string" },
            },
            note: { type: "string" },
          },
        },
      },
    };
    const result = buildBulkAttributeColumns(input, [{}]);
    expect(
      result.columns.find((entry) => entry.path.at(-1) === "contents"),
    ).toMatchObject({
      kind: "complex",
      help: [
        {
          path: ["Visible", "contents"],
          label: "Contents",
          description: "Provider list guidance.",
        },
      ],
    });
    expect(
      result.columns.find((entry) => entry.path.at(-1) === "note")?.help,
    ).toEqual([]);
  });
  it("resolves required flags for each row rather than applying a shared discriminator to everyone", () => {
    const result = buildBulkAttributeColumns(schema, [
      { Visible: { hasWarranty: true }, Orderable: { dimensions: {} } },
      { Visible: { hasWarranty: false } },
      {},
    ]);
    const warranty = result.columns.find(
      (column) => column.key === key("Visible", "warrantyText"),
    )!;
    expect(warranty).toMatchObject({ required: true, requiredForSome: true });
    expect(result.requiredKeysByRow[0]).toContain(warranty.key);
    expect(result.requiredKeysByRow[1]).not.toContain(warranty.key);
    expect(result.requiredKeysByRow[2]).not.toContain(warranty.key);
    expect(result.requiredKeysByRow[0]).toContain(
      key("Orderable", "dimensions", "width"),
    );
    expect(result.requiredKeysByRow[1]).not.toContain(
      key("Orderable", "dimensions", "width"),
    );
  });
  it("shows arrays and ambiguous branches as complex columns without flattening their values", () => {
    const result = buildBulkAttributeColumns(schema, [
      { Orderable: { packages: [{ count: 1 }] } },
    ]);
    expect(
      result.columns.find((column) => column.path.at(-1) === "packages"),
    ).toMatchObject({
      type: "complex",
      kind: "complex",
      complexReason: "array",
    });
    expect(result.columns.some((column) => column.path.includes("count"))).toBe(
      false,
    );
    expect(result.hasRowDetails).toBe(true);
    const ambiguous = {
      type: "object",
      properties: {
        Visible: {
          type: "object",
          properties: {
            shape: { oneOf: [{ type: "string" }, { type: "object" }] },
          },
        },
      },
    };
    expect(buildBulkAttributeColumns(ambiguous, [{}]).columns).toEqual([
      expect.objectContaining({ path: ["Visible", "shape"], kind: "complex" }),
    ]);
    expect(
      buildBulkAttributeColumns(ambiguous, [{}]).warnings.length,
    ).toBeGreaterThan(0);
  });
  it("shows conflicting conditional controls as complex columns", () => {
    const conditional = {
      type: "object",
      properties: {
        Visible: {
          type: "object",
          properties: { mode: { type: "boolean" }, value: { type: "string" } },
          if: { required: ["mode"], properties: { mode: { const: true } } },
          then: { properties: { value: { enum: ["a", "b"] } } },
        },
      },
    };
    const result = buildBulkAttributeColumns(conditional, [
      { Visible: { mode: true } },
      { Visible: { mode: false } },
    ]);
    expect(
      result.columns.find((column) => column.path.at(-1) === "value"),
    ).toMatchObject({ kind: "complex", complexReason: "conditional" });
    expect(result.hasRowDetails).toBe(true);
  });
  it("includes safe condition-only columns with exact per-row applicability", () => {
    const conditional = {
      type: "object",
      properties: {
        Visible: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          if: {
            required: ["enabled"],
            properties: { enabled: { const: true } },
          },
          then: {
            properties: { note: { type: "string" } },
            required: ["note"],
          },
        },
      },
    };
    const result = buildBulkAttributeColumns(conditional, [
      { Visible: { enabled: true } },
      { Visible: { enabled: false } },
    ]);
    expect(
      result.columns.find((column) => column.key === key("Visible", "note")),
    ).toMatchObject({
      appliesToAll: false,
      required: true,
      requiredForSome: true,
    });
    expect(result.applicableKeysByRow[0]).toContain(key("Visible", "note"));
    expect(result.applicableKeysByRow[1]).not.toContain(key("Visible", "note"));
  });
  it("excludes immutable identity, inventory, and price paths at the patch boundary", () => {
    const properties = Object.fromEntries(
      ["sku", "price", "inventory", "upc", "productIdentifiers", "safe"].map(
        (name) => [name, { type: "string" }],
      ),
    );
    const input = {
      type: "object",
      properties: { Orderable: { type: "object", properties } },
    };
    expect(
      buildBulkAttributeColumns(input, [{}]).columns.map(
        (column) => column.path,
      ),
    ).toEqual([["Orderable", "safe"]]);
  });
  it("shows every available column by default and retains required metadata", () => {
    const properties = Object.fromEntries(
      Array.from({ length: 30 }, (_, index) => [
        "field" + index,
        { type: "string" },
      ]),
    );
    const input = {
      type: "object",
      required: ["Visible"],
      properties: {
        Visible: { type: "object", required: ["field29"], properties },
      },
    };
    const result = buildBulkAttributeColumns(input, [{}]);
    expect(result.columns).toHaveLength(30);
    expect(result.columns[0].key).toBe(key("Visible", "field29"));
    expect(result.defaultColumnKeys).toHaveLength(30);
    expect(result.defaultColumnKeys).toEqual(
      result.columns.map((column) => column.key),
    );
    expect(
      result.columns.find((column) => column.key === key("Visible", "field29"))
        ?.required,
    ).toBe(true);
  });
  it("does not mutate selected values or synthesize row writes when discovering columns", () => {
    const values = [
      {
        Visible: { color: "Blue", hasWarranty: false },
        Orderable: { weight: 0 },
      },
    ];
    const before = structuredClone(values);
    const schemaBefore = JSON.stringify(schema);
    buildBulkAttributeColumns(schema, values);
    expect(values).toEqual(before);
    expect(JSON.stringify(schema)).toBe(schemaBefore);
    expect(buildBulkAttributeColumns(schema, []).requiredKeysByRow).toEqual([]);
    expect(() =>
      buildBulkAttributeColumns(
        schema,
        Array.from({ length: 101 }, () => ({})),
      ),
    ).toThrow("Too many");
  });
  it("keeps incompatible type unions and nonprimitive enum members in item details", () => {
    const input = {
      type: "object",
      properties: {
        Visible: {
          type: "object",
          properties: {
            nullable: { type: ["string", "null"] },
            mixed: { type: "string", enum: ["x", null] },
            object: { type: "string", enum: [{}] },
          },
        },
      },
    };
    expect(buildBulkAttributeColumns(input, [{}]).columns).toHaveLength(3);
    expect(
      buildBulkAttributeColumns(input, [{}]).columns.every(
        (column) => column.kind === "complex",
      ),
    ).toBe(true);
  });
  it("bounds the full column set and discloses overflow rather than implying all fields were shown", () => {
    const input = {
      type: "object",
      properties: {
        Visible: {
          type: "object",
          properties: Object.fromEntries(
            Array.from({ length: 600 }, (_, index) => [
              "field" + index,
              { type: "string" },
            ]),
          ),
        },
      },
    };
    const second = {
      type: "object",
      required: ["Visible"],
      properties: {
        Visible: {
          type: "object",
          required: ["lastRequired"],
          properties: {
            ...Object.fromEntries(
              Array.from({ length: 600 }, (_, index) => [
                "other" + index,
                { type: "string" },
              ]),
            ),
            lastRequired: { type: "string" },
          },
        },
      },
    };
    const result = buildBulkAttributeColumnsForRows([
      { schema: input, value: {} },
      { schema: second, value: {} },
    ]);
    expect(result.columns).toHaveLength(BULK_ATTRIBUTE_COLUMN_LIMITS.total);
    expect(result.defaultColumnKeys).toHaveLength(
      BULK_ATTRIBUTE_COLUMN_LIMITS.total,
    );
    expect(result.hasRowDetails).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.columns[0].key).toBe(key("Visible", "lastRequired"));
    const complex = {
      ...column(["Orderable", "weight"]),
      type: "complex" as const,
      kind: "complex" as const,
    };
    expect(parseBulkAttributeCellInput(complex, "1").error).toContain(
      "details panel",
    );
  });
  it("keeps required columns for a typed row when other selected rows have no product type", () => {
    const result = buildBulkAttributeColumnsForRows([
      { schema, value: {} },
      { value: {} },
    ]);
    const weight = result.columns.find(
      (entry) => entry.key === key("Orderable", "weight"),
    );
    expect(weight).toMatchObject({
      required: true,
      requiredForSome: true,
      appliesToAll: false,
    });
    expect(result.columns[0]).toBe(weight);
    expect(result.requiredKeysByRow[0]).toContain(weight!.key);
    expect(result.requiredKeysByRow[1]).toEqual([]);
    expect(result.columnsByRow[1].size).toBe(0);
    expect(result.applicableKeysByRow[1]).toEqual([]);
  });
  it("keeps each category's control and validation when paths have incompatible types", () => {
    const text = {
      type: "object",
      properties: {
        Visible: {
          type: "object",
          properties: {
            size: { type: "string", enum: ["Small", "Large"] },
          },
        },
      },
    };
    const number = {
      type: "object",
      properties: {
        Visible: {
          type: "object",
          properties: {
            size: { type: "number", minimum: 1 },
          },
        },
      },
    };
    const rows = [
      { schema: text, value: {} },
      { schema: number, value: {} },
    ];
    const before = structuredClone(rows);
    const result = buildBulkAttributeColumnsForRows(rows);
    const sizeKey = key("Visible", "size");
    expect(result.columns[0]).toMatchObject({
      kind: "complex",
      appliesToAll: true,
    });
    expect(result.columnsByRow[0].get(sizeKey)).toMatchObject({
      type: "string",
      kind: "scalar",
    });
    expect(result.columnsByRow[1].get(sizeKey)).toMatchObject({
      type: "number",
      kind: "scalar",
    });
    expect(
      parseBulkAttributeCellInput(
        result.columnsByRow[0].get(sizeKey)!,
        "choice:1",
      ).value,
    ).toBe("Large");
    expect(
      parseBulkAttributeCellInput(result.columnsByRow[1].get(sizeKey)!, "0")
        .error,
    ).not.toBeNull();
    expect(rows).toEqual(before);
  });
});

describe("explicit bulk cell edits", () => {
  it("preserves zero, false and explicit scalar clearing", () => {
    expect(
      parseBulkAttributeCellInput(column(["Orderable", "weight"]), "0"),
    ).toEqual({ value: 0, error: null });
    expect(
      parseBulkAttributeCellInput(
        column(["Orderable", "shipsInOwnContainer"]),
        "false",
      ),
    ).toEqual({ value: false, error: null });
    expect(
      parseBulkAttributeCellInput(column(["Orderable", "weight"]), ""),
    ).toEqual({ value: undefined, error: null });
  });
  it("rejects invalid intermediate and out-of-range numeric edits without emitting stale or invalid values", () => {
    const weight = column(["Orderable", "weight"]);
    for (const value of ["-", ".", "abc", "Infinity", "1e309", "-1"])
      expect(parseBulkAttributeCellInput(weight, value)).toMatchObject({
        value: undefined,
        error: expect.any(String),
      });
    expect(parseBulkAttributeCellInput(weight, ".25")).toEqual({
      value: 0.25,
      error: null,
    });
    expect(
      parseBulkAttributeCellInput(column(["Visible", "multipack"]), "1.5")
        .error,
    ).toContain("whole number");
    expect(
      parseBulkAttributeCellInput(
        column(["Visible", "multipack"]),
        "9007199254740992",
      ).error,
    ).toContain("whole number");
  });
  it("returns exact enum values and rejects values outside the choice list", () => {
    const unit = column(["Orderable", "dimensions", "unit"]);
    expect(parseBulkAttributeCellInput(unit, "choice:1")).toEqual({
      value: "cm",
      error: null,
    });
    for (const value of ["cm", "choice:2", "choice:-1", "choice:1.5"])
      expect(parseBulkAttributeCellInput(unit, value).error).not.toBeNull();
    const booleanEnum = {
      ...unit,
      type: "boolean",
      schema: { type: "boolean", enum: [false, true] },
    } as BulkAttributeColumn;
    expect(parseBulkAttributeCellInput(booleanEnum, "choice:0")).toEqual({
      value: false,
      error: null,
    });
  });
  it("checks scalar length and exclusive bounds while leaving complete schema validation to Review", () => {
    const text = {
      ...column(["Visible", "warrantyText"]),
      schema: { type: "string", minLength: 2, maxLength: 5 },
    };
    expect(parseBulkAttributeCellInput(text, "a").error).toContain("short");
    expect(parseBulkAttributeCellInput(text, "123456").error).toContain("long");
    const number = {
      ...column(["Orderable", "weight"]),
      schema: { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 10 },
    };
    expect(parseBulkAttributeCellInput(number, "0").error).toContain("below");
    expect(parseBulkAttributeCellInput(number, "10").error).toContain("above");
    expect(parseBulkAttributeCellInput(number, "1.5").error).toBeNull();
  });
});
