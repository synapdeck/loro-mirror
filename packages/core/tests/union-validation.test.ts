import { describe, expect, it } from "vitest";
import { getDefaultValue, schema, validateSchema } from "../src/index.js";
import {
    isUnknownVariantPlaceholder,
    resolveUnionVariant,
    unionTagOf,
} from "../src/schema/union.js";
import { decodeNestedJsonValues } from "../src/core/utils.js";

const Shape = schema.Union("kind", {
    circle: schema.LoroMap({ r: schema.Number() }),
    stamp: schema.LoroMap({
        at: schema.Number().transform({
            decode: (n: number) => new Date(n),
            encode: (d: Date) => d.getTime(),
        }),
    }),
});

describe("union helpers", () => {
    it("resolves only own string tags", () => {
        expect(resolveUnionVariant(Shape, "circle")).toBe(Shape.variants.circle);
        expect(resolveUnionVariant(Shape, "video")).toBeUndefined();
        expect(resolveUnionVariant(Shape, 1)).toBeUndefined();
        expect(resolveUnionVariant(Shape, "toString")).toBeUndefined();
        expect(resolveUnionVariant(Shape, undefined)).toBeUndefined();
    });

    it("normalizes tags", () => {
        expect(unionTagOf("circle")).toBe("circle");
        expect(unionTagOf(3)).toBeNull();
        expect(unionTagOf(undefined)).toBeNull();
    });

    it("recognizes placeholders by own key", () => {
        expect(isUnknownVariantPlaceholder({ $unknownVariant: { tag: null, data: {} } })).toBe(true);
        expect(isUnknownVariantPlaceholder({ kind: "circle", r: 1 })).toBe(false);
        expect(isUnknownVariantPlaceholder(null)).toBe(false);
    });
});

describe("validateSchema on unions", () => {
    it("accepts a known variant", () => {
        expect(validateSchema(Shape, { kind: "circle", r: 1 }).valid).toBe(true);
    });

    it("validates fields against the tagged variant", () => {
        const result = validateSchema(Shape, { kind: "circle", r: "x" });
        expect(result.valid).toBe(false);
        expect(result.errors?.join("\n")).toMatch(/r:/);
    });

    it("rejects an unknown or missing tag written by the user", () => {
        expect(validateSchema(Shape, { kind: "video" }).errors?.join()).toMatch(
            /Unknown variant "video"/,
        );
        expect(validateSchema(Shape, { r: 1 }).valid).toBe(false);
    });

    it("accepts the placeholder structurally", () => {
        expect(
            validateSchema(Shape, { $unknownVariant: { tag: "video", data: {} } }).valid,
        ).toBe(true);
    });

    it("rejects a key the tagged variant does not declare, naming it", () => {
        const result = validateSchema(Shape, {
            kind: "circle",
            r: 1,
            codec: "h264",
        });
        expect(result.valid).toBe(false);
        expect(result.errors?.join("\n")).toMatch(/codec/);
    });

    it("accepts undeclared keys on a catchall variant", () => {
        const WithCatchall = schema.Union("kind", {
            a: schema.LoroMap({ r: schema.Number() }).catchall(schema.Number()),
        });
        expect(
            validateSchema(WithCatchall, { kind: "a", r: 1, extra: 2 }).valid,
        ).toBe(true);
    });

    it("rejects a non-object", () => {
        expect(validateSchema(Shape, 3).valid).toBe(false);
    });

    it("has no default unless one is given", () => {
        expect(getDefaultValue(Shape)).toBeUndefined();
        const withDefault = schema.Union(
            "kind",
            { circle: schema.LoroMap({ r: schema.Number() }) },
            { defaultValue: { kind: "circle", r: 0 } },
        );
        expect(getDefaultValue(withDefault)).toEqual({ kind: "circle", r: 0 });
    });
});

describe("decodeNestedJsonValues on unions", () => {
    it("decodes with the tagged variant's transforms", () => {
        const decoded = decodeNestedJsonValues({ kind: "stamp", at: 0 }, Shape) as {
            at: Date;
        };
        expect(decoded.at).toBeInstanceOf(Date);
    });

    it("leaves unknown variants untouched", () => {
        expect(decodeNestedJsonValues({ kind: "video", at: 0 }, Shape)).toEqual({
            kind: "video",
            at: 0,
        });
    });
});
