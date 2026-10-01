import { describe, expect, it } from "vitest";
import {
  compileListingSchema,
  editorSchema,
  PROTECTED_ORDERABLE_FIELDS,
  CANONICAL_VISIBLE_FIELDS,
} from "../../adapters/walmart/walmart-listing-schema";
import { buildSchemaFieldModel } from "../../../../../client/src/features/channel-listing-publication/schema-field-model";
import createSchema from "../fixtures/walmart-listing-sleeves.schema.json";
import matchSchema from "../fixtures/walmart-listing-match.schema.json";

const productType = "Trading Card Sleeves & Holders";
type Schema = Record<string, unknown>;
const object = (value: unknown) => value as Schema;
const section = (schema: Schema, key: string) =>
  object(object(schema.properties)[key]);
const attributes = () => ({
  Orderable: {
    ShippingWeight: 0.1,
    country_of_origin_substantial_transformation: "United States",
  },
  Visible: {
    condition: "New",
    keyFeatures: [
      "Clear card protection",
      "One hundred sleeves per pack",
      "For standard trading cards",
    ],
    countPerPack: 100,
    multipackQuantity: 1,
    isProp65WarningRequired: "No",
    has_written_warranty: "No",
    netContent: {
      productNetContentUnit: "Each",
      productNetContentMeasure: 100,
    },
    pieceCount: 100,
  } as Record<string, unknown>,
});
const syntheticFeed = (visible: Schema, extra: Schema = {}): Schema => ({
  ...extra,
  type: "object",
  properties: {
    MPItem: {
      type: "array",
      items: {
        type: "object",
        properties: {
          Orderable: {
            type: "object",
            properties: {
              sku: { type: "string" },
              ShippingWeight: { type: "number" },
            },
            required: ["sku", "ShippingWeight"],
          },
          Visible: { type: "object", properties: { [productType]: visible } },
        },
      },
    },
  },
});

describe("Walmart writable listing requirements", () => {
  it("preserves all six real writable sleeves conditions and excludes protected orderable conditions", () => {
    const projected = editorSchema(createSchema, "MP_ITEM", productType);
    expect(section(projected, "Visible").allOf).toHaveLength(6);
    expect(section(projected, "Orderable").allOf).toBeUndefined();
    expect(
      section(projected, "Orderable")["x-editor-review-required"],
    ).toBeUndefined();
    for (const key of PROTECTED_ORDERABLE_FIELDS)
      expect(
        object(section(projected, "Orderable").properties),
      ).not.toHaveProperty(key);
    for (const key of CANONICAL_VISIBLE_FIELDS)
      expect(
        object(section(projected, "Visible").properties),
      ).not.toHaveProperty(key);
    expect(compileListingSchema(projected)(attributes())).toBe(true);
  });
  it("requires Prop65 warning text only for the real Yes value", () => {
    const projected = editorSchema(createSchema, "MP_ITEM", productType);
    const validate = compileListingSchema(projected);
    const value = attributes();
    value.Visible.isProp65WarningRequired = "Yes";
    expect(validate(value)).toBe(false);
    expect(validate.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "required",
          params: { missingProperty: "prop65WarningText" },
        }),
      ]),
    );
    expect(
      buildSchemaFieldModel(projected, value).missing.map((item) =>
        item.path.join("."),
      ),
    ).toContain("Visible.prop65WarningText");
    value.Visible.prop65WarningText = "Warning: cancer and reproductive harm.";
    expect(validate(value)).toBe(true);
    for (const choice of ["No", undefined, false]) {
      if (choice === undefined) delete value.Visible.isProp65WarningRequired;
      else value.Visible.isProp65WarningRequired = choice;
      delete value.Visible.prop65WarningText;
      const paths = buildSchemaFieldModel(projected, value).missing.map(
        (item) => item.path.join("."),
      );
      expect(paths).not.toContain("Visible.prop65WarningText");
    }
  });
  it("selects warranty text versus URL without promoting either for missing or No selections", () => {
    const projected = editorSchema(createSchema, "MP_ITEM", productType);
    const value = attributes();
    for (const [choice, expected] of [
      ["Yes - Warranty Text", "warrantyText"],
      ["Yes - Warranty URL", "warrantyURL"],
    ] as const) {
      value.Visible.has_written_warranty = choice;
      expect(
        buildSchemaFieldModel(projected, value).missing.map((item) =>
          item.path.join("."),
        ),
      ).toEqual(["Visible." + expected]);
    }
    for (const choice of ["No", false, undefined]) {
      if (choice === undefined) delete value.Visible.has_written_warranty;
      else value.Visible.has_written_warranty = choice;
      const paths = buildSchemaFieldModel(projected, value).missing.map(
        (item) => item.path.join("."),
      );
      expect(paths).not.toContain("Visible.warrantyText");
      expect(paths).not.toContain("Visible.warrantyURL");
    }
    const absent = buildSchemaFieldModel(projected, {}).missing.map((item) =>
      item.path.join("."),
    );
    expect(absent).not.toContain("Visible.warrantyText");
    expect(absent).not.toContain("Visible.prop65WarningText");
  });
  it("keeps matching requirements free of canonical content and identity fields", () => {
    const projected = editorSchema(matchSchema, "MP_ITEM_MATCH", "");
    expect(section(projected, "Visible")).toBeUndefined();
    const keys = Object.keys(
      object(section(projected, "Orderable").properties),
    );
    for (const key of [
      ...PROTECTED_ORDERABLE_FIELDS,
      ...CANONICAL_VISIBLE_FIELDS,
    ])
      expect(keys).not.toContain(key);
  });
  it("does not request empty provider-assembled sections that have no writable requirements", () => {
    const feed = syntheticFeed({
      type: "object",
      properties: {
        productName: { type: "string" },
        color: { type: "string" },
      },
      required: ["productName"],
    });
    const orderable = object(
      object(object(object(feed.properties).MPItem).items).properties,
    ).Orderable as Schema;
    orderable.required = ["sku"];
    const projected = editorSchema(feed, "MP_ITEM", productType);
    expect(buildSchemaFieldModel(projected, {}).missing).toEqual([]);
  });
  it("inlines only referenced local definitions while preserving their validation constraints", () => {
    const input = syntheticFeed(
      {
        type: "object",
        properties: {
          warranty: { $ref: "#/$defs/warranty" },
          enabled: { type: "boolean" },
        },
        allOf: [
          { if: { $ref: "#/$defs/enabled" }, then: { required: ["warranty"] } },
        ],
      },
      {
        $defs: {
          warranty: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
          enabled: {
            properties: { enabled: { const: true } },
            required: ["enabled"],
          },
          protectedFeed: {
            type: "object",
            properties: { inventory: { type: "array" } },
          },
        },
      },
    );
    const before = JSON.stringify(input);
    const projected = editorSchema(input, "MP_ITEM", productType);
    expect(JSON.stringify(projected)).not.toContain("$ref");
    expect(JSON.stringify(projected)).not.toContain("protectedFeed");
    expect(JSON.stringify(projected)).not.toContain("inventory");
    expect(
      buildSchemaFieldModel(projected, {
        Orderable: { ShippingWeight: 0 },
        Visible: { enabled: true },
      }).missing,
    ).toEqual([
      {
        path: ["Visible", "warranty", "text"],
        label: "Product attributes › Warranty › Text",
      },
    ]);
    expect(JSON.stringify(input)).toBe(before);
  });
  it("drops hidden-field conditions whole, including their otherwise writable consequence", () => {
    const projected = editorSchema(
      syntheticFeed({
        type: "object",
        properties: {
          productName: { type: "string" },
          text: { type: "string" },
        },
        allOf: [
          {
            if: {
              properties: { productName: { const: "hidden" } },
              required: ["productName"],
            },
            then: { required: ["text"] },
          },
        ],
      }),
      "MP_ITEM",
      productType,
    );
    expect(section(projected, "Visible").allOf).toBeUndefined();
    expect(
      buildSchemaFieldModel(projected, { Visible: {} }).missing.map((item) =>
        item.path.join("."),
      ),
    ).not.toContain("Visible.text");
    expect(buildSchemaFieldModel(projected, {}).warnings).toHaveLength(1);
  });
  it("warns about object-wide requirements that cannot safely be projected", () => {
    const projected = editorSchema(
      syntheticFeed({
        type: "object",
        properties: { color: { type: "string" } },
        allOf: [{ minProperties: 2 }],
        anyOf: [{ required: ["color"] }],
      }),
      "MP_ITEM",
      productType,
    );
    expect(section(projected, "Visible").allOf).toBeUndefined();
    expect(buildSchemaFieldModel(projected, {}).warnings).toHaveLength(1);
  });
  it("rejects remote, unresolved, cyclic, oversized and unsafe schema references before rendering", () => {
    for (const ref of [
      "https://example.com/schema",
      "#/$defs/missing",
      "#/$defs/cycle",
    ]) {
      const feed = syntheticFeed(
        { properties: { value: { $ref: ref } } },
        { $defs: { cycle: { $ref: "#/$defs/cycle" } } },
      );
      expect(() => editorSchema(feed, "MP_ITEM", productType)).toThrow(
        /reference/,
      );
    }
    let nested: Schema = { type: "string" };
    for (let i = 0; i < 40; i++)
      nested = { type: "object", properties: { child: nested } };
    expect(() =>
      editorSchema(
        syntheticFeed({ properties: { nested } }),
        "MP_ITEM",
        productType,
      ),
    ).toThrow(/limits/);
    const unsafe = JSON.parse(
      '{"type":"object","properties":{"nested":{"properties":{"__proto__":{"type":"string"}}}}}',
    );
    expect(() =>
      editorSchema(syntheticFeed(unsafe), "MP_ITEM", productType),
    ).toThrow(/unsupported field/);
  });
});
