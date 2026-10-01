import { describe, expect, it } from "vitest";
import {
  buildSchemaFieldModel,
  fieldValueAtPath,
  resolveFieldSchema,
  schemaFieldMatches,
  updateSchemaFieldValue,
  type FieldSchema,
  type SchemaFieldNode,
} from "../schema-field-model";

const nodeAt = (root: SchemaFieldNode, ...path: string[]): SchemaFieldNode => {
  let node = root;
  for (const key of path)
    node = node.children.find((child) => child.path.at(-1) === key)!;
  return node;
};
const paths = (schema: FieldSchema, value: FieldSchema) =>
  buildSchemaFieldModel(schema, value).missing.map((item) =>
    item.path.join("."),
  );

describe("listing field requirements model", () => {
  const schema: FieldSchema = {
    type: "object",
    required: ["Visible"],
    properties: {
      Visible: {
        type: "object",
        title: "Product attributes",
        required: ["dimensions", "isFragile", "count"],
        properties: {
          dimensions: {
            type: "object",
            required: ["width"],
            properties: { width: { type: "number", title: "Width" } },
          },
          isFragile: { type: "boolean" },
          count: { type: "integer" },
          optionalWarranty: {
            type: "object",
            required: ["text"],
            properties: { text: { type: "string" } },
          },
        },
      },
    },
  };
  it("promotes required descendants of an absent required section", () => {
    expect(paths(schema, {})).toEqual([
      "Visible.dimensions.width",
      "Visible.isFragile",
      "Visible.count",
    ]);
    const result = buildSchemaFieldModel(schema, {});
    expect(result.missing[0].label).toBe(
      "Product attributes › Dimensions › Width",
    );
    expect(nodeAt(result.root, "Visible", "dimensions").required).toBe(true);
  });
  it("does not make required children of an absent optional object globally required", () => {
    const model = buildSchemaFieldModel(schema, {});
    const text = nodeAt(model.root, "Visible", "optionalWarranty", "text");
    expect(text.required).toBe(false);
    expect(text.requiredWhenProvided).toBe(true);
    expect(text.missing).toBe(false);
  });
  it("requires children once an optional object is explicitly present", () => {
    expect(
      paths(schema, {
        Visible: {
          dimensions: { width: 0 },
          isFragile: false,
          count: 0,
          optionalWarranty: {},
        },
      }),
    ).toEqual(["Visible.optionalWarranty.text"]);
  });
  it("preserves valid false and zero, but treats null and whitespace as missing", () => {
    expect(
      paths(schema, {
        Visible: { dimensions: { width: 0 }, isFragile: false, count: 0 },
      }),
    ).toEqual([]);
    expect(
      paths(schema, {
        Visible: { dimensions: { width: null }, isFragile: null, count: " " },
      }),
    ).toHaveLength(3);
  });
  it("searches labels, descriptions, and descendant paths without changing requirements", () => {
    const root = buildSchemaFieldModel(schema, {}).root;
    expect(schemaFieldMatches(root, "width")).toBe(true);
    expect(schemaFieldMatches(root, "warranty text")).toBe(true);
    expect(schemaFieldMatches(root, "no-such-field")).toBe(false);
    expect(paths(schema, {})).toHaveLength(3);
  });
});

describe("conditional and referenced requirements", () => {
  const conditional: FieldSchema = {
    type: "object",
    properties: {
      hasWarranty: { type: "boolean" },
      warrantyText: { type: "string" },
      warrantyUrl: { type: "string" },
      method: { type: "string" },
    },
    allOf: [
      {
        if: {
          properties: { hasWarranty: { const: true } },
          required: ["hasWarranty"],
        },
        then: { required: ["warrantyText"] },
      },
      {
        if: { properties: { method: { enum: ["url"] } }, required: ["method"] },
        then: { required: ["warrantyUrl"] },
      },
    ],
  };
  it("does not activate conditional requirements for false or an unset discriminator", () => {
    expect(paths(conditional, {})).toEqual([]);
    expect(paths(conditional, { hasWarranty: false })).toEqual([]);
    expect(paths(conditional, { hasWarranty: true })).toEqual(["warrantyText"]);
  });
  it("does not treat an absent required object as satisfying its object-only condition", () => {
    const nested = {
      type: "object",
      required: ["Visible"],
      properties: { Visible: conditional },
    };
    expect(paths(nested, {})).toEqual(["Visible"]);
    expect(paths(nested, { Visible: {} })).toEqual([]);
    expect(paths(nested, { Visible: { hasWarranty: false } })).toEqual([]);
    expect(paths(nested, { Visible: { hasWarranty: true } })).toEqual([
      "Visible.warrantyText",
    ]);
  });
  it("evaluates independent allOf conditions once and unions their requirements", () => {
    expect(paths(conditional, { hasWarranty: true, method: "url" })).toEqual([
      "warrantyText",
      "warrantyUrl",
    ]);
    expect(paths(conditional, { hasWarranty: false, method: "url" })).toEqual([
      "warrantyUrl",
    ]);
  });
  it("handles else requirements and does not mutate provider schemas", () => {
    const input = {
      ...conditional,
      allOf: [
        {
          if: { required: ["hasWarranty"] },
          then: { required: ["warrantyText"] },
          else: { required: ["method"] },
        },
      ],
    };
    const before = JSON.stringify(input);
    expect(paths(input, {})).toEqual(["method"]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("resolves bounded local refs and merges allOf field definitions", () => {
    const input = {
      type: "object",
      required: ["size"],
      properties: {
        size: { allOf: [{ $ref: "#/$defs/size" }, { title: "Package size" }] },
      },
      $defs: {
        size: {
          type: "object",
          properties: { width: { type: "number" } },
          required: ["width"],
        },
      },
    };
    const model = buildSchemaFieldModel(input, {});
    expect(model.missing).toEqual([
      { path: ["size", "width"], label: "Package size › Width" },
    ]);
    expect(model.warnings).toEqual([]);
  });
  it("evaluates a local condition reference without reading a remote schema", () => {
    const input = {
      type: "object",
      properties: { enabled: { type: "boolean" }, text: { type: "string" } },
      $defs: {
        enabled: {
          properties: { enabled: { const: true } },
          required: ["enabled"],
        },
      },
      if: { $ref: "#/$defs/enabled" },
      then: { required: ["text"] },
    };
    expect(paths(input, { enabled: true })).toEqual(["text"]);
    expect(paths(input, {})).toEqual([]);
  });
  it("does not assume unsupported or unresolved conditions are true or false", () => {
    for (const predicate of [
      { $ref: "https://example.com/schema" },
      { $ref: "#/$defs/absent" },
      { properties: { enabled: { pattern: ".*" } } },
    ]) {
      const model = buildSchemaFieldModel(
        {
          type: "object",
          properties: { yes: { type: "string" }, no: { type: "string" } },
          if: predicate,
          then: { required: ["yes"] },
          else: { required: ["no"] },
        },
        {},
      );
      expect(model.missing).toEqual([]);
      expect(model.warnings).toHaveLength(1);
    }
  });
  it("terminates cyclic references and discloses ambiguous branches", () => {
    const cyclic = {
      $defs: { loop: { $ref: "#/$defs/loop" } },
      type: "object",
      properties: { value: { $ref: "#/$defs/loop" } },
    };
    expect(buildSchemaFieldModel(cyclic, {}).warnings).toHaveLength(1);
    expect(
      buildSchemaFieldModel(
        { type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] },
        {},
      ).warnings,
    ).toHaveLength(1);
    expect(
      resolveFieldSchema({ $ref: "https://example.com/schema" }, {}),
    ).toEqual({ $ref: "https://example.com/schema" });
  });
});

describe("arrays, bounds, and safe updates", () => {
  const arraySchema = {
    type: "object",
    required: ["packages"],
    properties: {
      packages: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["count"],
          properties: {
            count: { type: "number" },
            optional: { type: "string" },
          },
        },
      },
    },
  };
  it("identifies empty required arrays and missing required fields in real array members", () => {
    expect(paths(arraySchema, {})).toEqual(["packages"]);
    expect(paths(arraySchema, { packages: [] })).toEqual(["packages"]);
    expect(paths(arraySchema, { packages: [{}, { count: 0 }] })).toEqual([
      "packages.0.count",
    ]);
  });
  it("does not require absent optional arrays but applies minItems when provided", () => {
    const optional = { ...arraySchema, required: [] };
    expect(paths(optional, {})).toEqual([]);
    expect(paths(optional, { packages: [] })).toEqual(["packages"]);
  });
  it("updates nested fields immutably and preserves false, zero, unrelated values", () => {
    const original = {
      Visible: {
        enabled: false,
        quantityPerPack: 0,
        labels: [{ text: "old", sibling: "keep" }],
      },
    };
    const result = updateSchemaFieldValue(
      original,
      ["Visible", "labels", "0", "text"],
      "new",
    );
    expect(result).toEqual({
      Visible: {
        enabled: false,
        quantityPerPack: 0,
        labels: [{ text: "new", sibling: "keep" }],
      },
    });
    expect(fieldValueAtPath(original, ["Visible", "labels", "0", "text"])).toBe(
      "old",
    );
    expect(fieldValueAtPath(result, ["Visible", "labels"])).not.toBe(
      original.Visible.labels,
    );
  });
  it("an explicit clear removes only the selected leaf and keeps an explicitly used parent", () => {
    expect(
      updateSchemaFieldValue(
        { Visible: { warranty: { text: "old" }, other: "keep" } },
        ["Visible", "warranty", "text"],
        undefined,
      ),
    ).toEqual({ Visible: { warranty: {}, other: "keep" } });
    expect(
      updateSchemaFieldValue(
        { Visible: { texts: ["old"] } },
        ["Visible", "texts", "0"],
        undefined,
      ),
    ).toEqual({ Visible: { texts: [""] } });
  });
  it("rejects unsafe paths, ignores unsafe schema properties, and does not pollute prototypes", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      expect(() =>
        updateSchemaFieldValue({}, ["Visible", key, "polluted"], true),
      ).toThrow("Invalid attribute path");
    }
    const schema = JSON.parse(
      '{"type":"object","properties":{"__proto__":{"type":"string"},"safe":{"type":"string"}}}',
    );
    const model = buildSchemaFieldModel(schema, {});
    expect(model.root.children.map((node) => node.path)).toEqual([["safe"]]);
    expect(model.warnings).toHaveLength(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("bounds wide and deep schemas without claiming unsupported fields are complete", () => {
    const wide = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 1_100 }, (_, i) => [
          "field" + i,
          { type: "string" },
        ]),
      ),
    };
    expect(
      buildSchemaFieldModel(wide, {}).root.children.length,
    ).toBeLessThanOrEqual(999);
    expect(buildSchemaFieldModel(wide, {}).warnings).toHaveLength(1);
    let deep: FieldSchema = { type: "string" };
    for (let i = 0; i < 30; i++)
      deep = {
        type: "object",
        required: ["child"],
        properties: { child: deep },
      };
    expect(buildSchemaFieldModel(deep, {}).warnings).toHaveLength(1);
  });
});
