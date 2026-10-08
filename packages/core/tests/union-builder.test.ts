import { describe, expect, it } from "vitest";
import { isContainerSchema, isLoroUnionSchema, schema } from "../src/index.js";

describe("schema.Union builder", () => {
    it("is a Map-backed container schema", () => {
        const u = schema.Union("kind", {
            a: schema.LoroMap({ x: schema.Number() }),
        });
        expect(isLoroUnionSchema(u)).toBe(true);
        expect(isContainerSchema(u)).toBe(true);
        expect(u.getContainerType()).toBe("Map");
        expect(u.discriminant).toBe("kind");
    });

    it("rejects a variant that declares the discriminant", () => {
        expect(() =>
            schema.Union("kind", {
                a: schema.LoroMap({ kind: schema.String() }),
            }),
        ).toThrow(/must not declare the discriminant/);
    });

    it("rejects nested unions", () => {
        const inner = schema.Union("t", { x: schema.LoroMap({}) });
        expect(() => schema.Union("kind", { a: inner as never })).toThrow(
            /must be a schema\.LoroMap/,
        );
    });

    it("rejects an empty variant set", () => {
        expect(() => schema.Union("kind", {})).toThrow(/at least one variant/);
    });

    it("rejects reserved discriminants", () => {
        expect(() => schema.Union("$cid", { a: schema.LoroMap({}) })).toThrow(
            /reserved/,
        );
        expect(() =>
            schema.Union("$unknownVariant", { a: schema.LoroMap({}) }),
        ).toThrow(/reserved/);
    });
});
