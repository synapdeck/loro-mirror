import { describe, expectTypeOf, test } from "vitest";
import { InferInputType, InferType, schema } from "../src/index.js";

const Shape = schema.Union("kind", {
    circle: schema.LoroMap({ r: schema.Number() }),
    label: schema.LoroMap({ text: schema.LoroText() }),
});
type Shape = InferType<typeof Shape>;

const exhaustive = (s: Shape): number => {
    switch (s.kind) {
        case "circle":
            return 1;
        case "label":
            return 2;
        default: {
            // @ts-expect-error the placeholder (kind: undefined) is unhandled
            const _unreachable: never = s;
            return _unreachable;
        }
    }
};

describe("schema.Union types", () => {
    test("narrows each variant by its tag, and the placeholder by undefined", () => {
        const read = (s: Shape): void => {
            switch (s.kind) {
                case "circle":
                    expectTypeOf(s.r).toEqualTypeOf<number>();
                    return;
                case "label":
                    expectTypeOf(s.text).toEqualTypeOf<string>();
                    return;
                case undefined:
                    expectTypeOf(s.$unknownVariant.tag).toEqualTypeOf<
                        string | null
                    >();
                    return;
            }
        };
        expectTypeOf(read).toBeFunction();
    });

    test("an exhaustive switch must handle the placeholder", () => {
        expectTypeOf(exhaustive).toBeFunction();
    });

    test("every known variant carries $cid", () => {
        expectTypeOf<
            Extract<Shape, { kind: "circle" }>["$cid"]
        >().toEqualTypeOf<string>();
    });

    test("input types make $cid optional", () => {
        expectTypeOf<{ kind: "circle"; r: number }>().toMatchTypeOf<
            InferInputType<typeof Shape>
        >();
    });

    test("a catchall variant admits the tag, declared fields and catchall entries", () => {
        const WithCatchall = schema.Union("kind", {
            a: schema.LoroMap({ id: schema.String() }).catchall(schema.Number()),
        });
        const input: InferInputType<typeof WithCatchall> = {
            kind: "a",
            id: "x",
            extra: 1,
        };
        expectTypeOf(input).not.toBeAny();
        const read = (s: InferType<typeof WithCatchall>): void => {
            if (s.kind === "a") {
                expectTypeOf(s.id).toEqualTypeOf<string>();
                expectTypeOf(s.extra).toEqualTypeOf<number>();
            }
        };
        expectTypeOf(read).toBeFunction();
        const wrong: InferInputType<typeof WithCatchall> = {
            kind: "a",
            id: "x",
            // @ts-expect-error a catchall entry must match the catchall schema
            extra: true,
        };
        expectTypeOf(wrong).not.toBeAny();
    });

    test("an optional union admits undefined", () => {
        const Opt = schema.Union(
            "kind",
            { a: schema.LoroMap({}) },
            { required: false },
        );
        expectTypeOf<undefined>().toMatchTypeOf<InferType<typeof Opt>>();
    });
});
