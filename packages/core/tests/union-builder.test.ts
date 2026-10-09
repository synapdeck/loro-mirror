import { describe, expect, it } from "vitest";
import * as api from "../src/index.js";
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

    it("accepts a catchall variant", () => {
        const u = schema.Union("kind", {
            a: schema
                .LoroMap({ id: schema.String() })
                .catchall(schema.Number()),
        });
        expect(u.variants.a.type).toBe("loro-map");
        expect(u.variants.a.catchallType.type).toBe("number");
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

    it("rejects an empty discriminant", () => {
        expect(() => schema.Union("", { a: schema.LoroMap({}) })).toThrow(
            /discriminant must be a non-empty string/,
        );
    });

    it("rejects variants that declare reserved keys", () => {
        expect(() =>
            schema.Union("kind", {
                a: schema.LoroMap({ $cid: schema.String() }),
            }),
        ).toThrow(/variant "a" must not declare the reserved key "\$cid"/);
        expect(() =>
            schema.Union("kind", {
                a: schema.LoroMap({ $unknownVariant: schema.String() }),
            }),
        ).toThrow(
            /variant "a" must not declare the reserved key "\$unknownVariant"/,
        );
    });

    it("rejects unions under tree nodes", () => {
        const u = schema.Union("kind", { a: schema.LoroMap({}) });
        expect(() => schema.LoroTree(schema.LoroMap({ shape: u }))).toThrow(
            /unions are not supported under LoroTree nodes/,
        );
        expect(() =>
            schema.LoroTree(schema.LoroMap({ items: schema.LoroList(u) })),
        ).toThrow(/unions are not supported under LoroTree nodes/);
        expect(() =>
            schema.LoroTree(schema.LoroMap({ title: schema.String() })),
        ).not.toThrow();
    });

    it("keeps schemaContainsUnion internal", () => {
        expect("schemaContainsUnion" in api).toBe(false);
        expect("schemaContainsUnion" in api.default).toBe(false);
    });
});
