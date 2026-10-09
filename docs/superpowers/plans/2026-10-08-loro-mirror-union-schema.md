# loro-mirror `schema.Union` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a discriminated-union schema (`schema.Union`) to loro-mirror, written fresh on current `main`, with in-place variant switches, a typed unknown-variant placeholder, and real `move` ops for movable lists nested inside variants.

**Architecture:** A union-typed `LoroMap` registers its *resolved variant* `LoroMapSchema` in the mirror's container registry, plus a back-pointer to the union, so the ~10 registry-based lookups see an ordinary map schema. Variants are resolved from the pending value on writes and from the doc on reads. A variant change is one new change kind, `union-switch`, applied in place to the existing container. Remote tag changes force re-registration of the map's subtree. Map events on union maps re-project that map wholesale from the doc.

**Tech Stack:** TypeScript (strict), loro-crdt (peer `^1.8.0`; mergeable children need `>= 1.13.3`), Immer, Vitest 3 (with `typecheck` enabled for `*.test-d.ts`), oxlint, pnpm.

**Spec:** `~/slideshow-editor/docs/superpowers/specs/2026-10-08-loro-mirror-union-schema-design.md` (uncommitted; read it before starting).

## Global Constraints

- Work on a new branch `feat/union-schema` off `main` in the `~/loro-mirror` repo (fork `synapdeck/loro-mirror`; `main` == upstream `loro-dev/loro-mirror` main, 2.3.3). Do **not** base anything on `feat/discriminated-unions`.
- Do not push, open a PR, or comment on loro-dev/loro-mirror#76 without the user's explicit go-ahead.
- No `any` in TypeScript (repo rule). `as never` / `as unknown as T` casts are acceptable in tests only.
- Do not reformat whole files. Prettier only the lines you touch (tabWidth 4); never run `prettier --write` on an existing file wholesale. Run `pnpm exec prettier --write <new file>` only on files you create.
- Conventional commits with scope `core`, e.g. `feat(core): add schema.Union builder and types`.
- No constructor doc writes, no `$cid` descriptor changes, no `initialState` persistence. These were #76 regressions the spec rules out.
- Reserved keys: `$cid` (existing) and `$unknownVariant` (new). The placeholder's `tag` is `string | null` (`null` = missing or non-string tag).
- Unions may appear as a map field, `LoroMapRecord` value, or `LoroList`/`LoroMovableList` item. Never at the root or as `LoroTree` node `data`. Variants are `schema.LoroMap(...)` (catchall allowed), never nested unions; the discriminant is a string key that variants must not declare.
- Every union test runs with `inferOptions: { mergeableMapChildContainers: true }` **and** without it, with `checkStateConsistency: true`.
- Gates before the branch is done: `pnpm build && pnpm test && pnpm lint && pnpm typecheck` from the repo root.

## Review Focus

1. A variant switch through a Mirror constructed with `ephemeralStore`: changes are applied via the local-event path, not `updateLoro`. Expect state to equal the doc projection. Test: Task 6, step 1, `"switches through an ephemeral-store mirror"`.
2. A `LoroMovableList` item moved and switched in the same `setState`: expect it at its new index, with the new variant and the same container id. Test: Task 5, step 1, `"moves and switches one item in a single setState"`.
3. A record entry deleted and then re-added under the same key with a different tag, with mergeable children on. A re-ensured mergeable map revives old contents; expect only the new variant's keys. Test: Task 3, step 1, `"re-adding a deleted record entry with another tag leaves no old keys"`.
4. A switch value carrying an explicit `undefined` for an optional field: expect the key to be absent from the doc and no Loro `null` written. Test: Task 5, step 1, `"an explicit undefined in a switch value writes no key"`.
5. `initialState` containing a union value on an empty doc: expect the constructor not to throw and nothing to be written. Test: Task 4, step 1, `"an initialState union hint neither throws nor writes"`.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/core/src/constants.ts` (modify) | `UNKNOWN_VARIANT_KEY` |
| `packages/core/src/schema/types.ts` (modify) | `LoroUnionSchema`, `UnionVariantSchema`, `AnyLoroUnionSchema`, placeholder types, `InferType`/`InferInputType` branches |
| `packages/core/src/schema/index.ts` (modify) | `schema.Union` builder |
| `packages/core/src/schema/union.ts` (create) | Pure helpers: `resolveUnionVariant`, `unionTagOf`, `isUnknownVariantPlaceholder` |
| `packages/core/src/schema/validators.ts` (modify) | `isLoroUnionSchema`, `isContainerSchema`, `validateSchema` union case, `schemaContainsIgnoreField`/`schemaContainsUnion` |
| `packages/core/src/schema/resolver.ts` (modify) | `getChildContainerSchema` accepts unions |
| `packages/core/src/core/union.ts` (create) | `makeUnknownVariantPlaceholder`, `deepFreeze` |
| `packages/core/src/core/utils.ts` (modify) | `decodeNestedJsonValues` union case |
| `packages/core/src/core/diff.ts` (modify) | `diffUnionMap`; `diffContainer` routes unions to it |
| `packages/core/src/core/mirror.ts` (modify) | Registry union fields, registration/resolution, projection, `applyUnionSwitch`, event routing/re-projection, path walks |
| `packages/core/src/core/loroEventApply.ts` (modify) | `reproject` option on `applyEventBatchToState` |
| `packages/core/tests/union-fixtures.ts` (create) | Shared schemas, placements, sync helpers (not a test file) |
| `packages/core/tests/union-*.test.ts`, `union-types.test-d.ts` (create) | Tests per task |
| `README.md`, `packages/core/README.md`, `api.md`, `AGENTS.md` (modify) | Docs (Task 8) |

---

### Task 1: Union builder, types, guards

**Files:**
- Modify: `packages/core/src/constants.ts`, `packages/core/src/schema/types.ts`, `packages/core/src/schema/index.ts`, `packages/core/src/schema/validators.ts`, `packages/core/src/schema/resolver.ts`
- Test: `packages/core/tests/union-builder.test.ts`, `packages/core/tests/union-types.test-d.ts`

**Interfaces:**
- Produces: `schema.Union<D, V, O>(discriminant: D, variants: V, options?: O): LoroUnionSchema<D, V> & { options: O }`; types `UnionVariantSchema`, `LoroUnionSchema<D, V>` (`type: "loro-union"`, `discriminant`, `variants`), `AnyLoroUnionSchema`, `UnknownVariantInfo`, `UnknownVariant<D>`; `isLoroUnionSchema(schema?): schema is AnyLoroUnionSchema`; `UNKNOWN_VARIANT_KEY = "$unknownVariant"`. `isContainerSchema` and `getChildContainerSchema` return true / the schema for unions.

- [ ] **Step 0: Set up the branch.** Use superpowers:using-git-worktrees to create a worktree for a new branch `feat/union-schema` from `main` of `~/loro-mirror`. Then:

```bash
pnpm install
pnpm --filter loro-mirror test
```
Expected: the whole existing suite passes on untouched `main`. If not, stop and report.

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/union-builder.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isContainerSchema, isLoroUnionSchema, schema } from "../src/index.js";

describe("schema.Union builder", () => {
    it("is a Map-backed container schema", () => {
        const u = schema.Union("kind", { a: schema.LoroMap({ x: schema.Number() }) });
        expect(isLoroUnionSchema(u)).toBe(true);
        expect(isContainerSchema(u)).toBe(true);
        expect(u.getContainerType()).toBe("Map");
        expect(u.discriminant).toBe("kind");
    });

    it("rejects a variant that declares the discriminant", () => {
        expect(() =>
            schema.Union("kind", { a: schema.LoroMap({ kind: schema.String() }) }),
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
        expect(() => schema.Union("$cid", { a: schema.LoroMap({}) })).toThrow(/reserved/);
        expect(() => schema.Union("$unknownVariant", { a: schema.LoroMap({}) })).toThrow(/reserved/);
    });
});
```

`packages/core/tests/union-types.test-d.ts`:
```ts
import { describe, expectTypeOf, test } from "vitest";
import { InferInputType, InferType, schema } from "../src/index.js";

const Shape = schema.Union("kind", {
    circle: schema.LoroMap({ r: schema.Number() }),
    label: schema.LoroMap({ text: schema.LoroText() }),
});
type Shape = InferType<typeof Shape>;

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
                    expectTypeOf(s.$unknownVariant.tag).toEqualTypeOf<string | null>();
                    return;
            }
        };
        expectTypeOf(read).toBeFunction();
    });

    test("an exhaustive switch must handle the placeholder", () => {
        const exhaustive = (s: Shape): number => {
            switch (s.kind) {
                case "circle":
                    return 1;
                case "label":
                    return 2;
                default: {
                    // @ts-expect-error the placeholder (kind: undefined) is unhandled
                    const unreachable: never = s;
                    return unreachable;
                }
            }
        };
        expectTypeOf(exhaustive).toBeFunction();
    });

    test("every known variant carries $cid", () => {
        expectTypeOf<Extract<Shape, { kind: "circle" }>["$cid"]>().toEqualTypeOf<string>();
    });

    test("input types make $cid optional", () => {
        expectTypeOf<{ kind: "circle"; r: number }>().toMatchTypeOf<
            InferInputType<typeof Shape>
        >();
    });

    test("an optional union admits undefined", () => {
        const Opt = schema.Union("kind", { a: schema.LoroMap({}) }, { required: false });
        expectTypeOf<undefined>().toMatchTypeOf<InferType<typeof Opt>>();
    });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-builder.test.ts tests/union-types.test-d.ts`
Expected: FAIL (`schema.Union is not a function` / type errors on `schema.Union`).

- [ ] **Step 3: Implement**

`packages/core/src/constants.ts`: append
```ts
export const UNKNOWN_VARIANT_KEY = "$unknownVariant";
```

`packages/core/src/schema/types.ts`: after `LoroTreeSchema`, add:
```ts
/** A union variant: a LoroMap schema, with or without a catchall. */
export type UnionVariantSchema =
    | LoroMapSchema<Record<string, SchemaType>>
    | LoroMapSchemaWithCatchall<Record<string, SchemaType>, SchemaType>;

/**
 * Discriminated union of LoroMap variants. Stored as one LoroMap whose
 * `discriminant` key holds the variant's tag (a key of `variants`).
 */
export interface LoroUnionSchema<
    D extends string,
    V extends Record<string, UnionVariantSchema>,
> extends BaseSchemaType {
    type: "loro-union";
    discriminant: D;
    variants: V;
}

export type AnyLoroUnionSchema = LoroUnionSchema<
    string,
    Record<string, UnionVariantSchema>
>;

/** What an older client sees of a variant its schema does not know. */
export interface UnknownVariantInfo {
    /** The stored tag; `null` when the tag is missing or not a string. */
    readonly tag: string | null;
    /** The map's contents, inferred as `schema.Any()` would, deep-frozen. */
    readonly data: Readonly<Record<string, unknown>>;
}

/**
 * State placeholder for an unknown variant. The discriminant is absent, so
 * `switch (x[D])` narrows it via `case undefined` and exhaustive switches
 * must handle it.
 */
export type UnknownVariant<D extends string> = {
    readonly [P in D]?: undefined;
} & {
    readonly $cid: string;
    readonly $unknownVariant: UnknownVariantInfo;
};

type UnknownVariantInput<D extends string> = {
    readonly [P in D]?: undefined;
} & {
    readonly $cid?: string;
    readonly $unknownVariant: UnknownVariantInfo;
};

type Simplify<T> = T extends infer U ? { [K in keyof U]: U[K] } : never;

type InferUnionType<
    D extends string,
    V extends Record<string, UnionVariantSchema>,
> =
    | {
          [K in keyof V & string]: Simplify<{ [P in D]: K } & InferType<V[K]>>;
      }[keyof V & string]
    | UnknownVariant<D>;

type InferInputUnionType<
    D extends string,
    V extends Record<string, UnionVariantSchema>,
> =
    | {
          [K in keyof V & string]: Simplify<
              { [P in D]: K } & InferInputType<V[K]>
          >;
      }[keyof V & string]
    | UnknownVariantInput<D>;
```
Add `| LoroUnionSchema<string, Record<string, UnionVariantSchema>>` to both `SchemaType` and `ContainerSchemaType`. Change `RootFieldSchemaType` so a union is not a root field:
```ts
export type RootFieldSchemaType =
    | Exclude<ContainerSchemaType, { type: "loro-union" }>
    | IgnoreSchemaType;
```
In `InferType`, add a branch in the optional half, right after the `S extends LoroTextSchemaType ? string | undefined` line:
```ts
: S extends LoroUnionSchema<infer D, infer V>
  ? InferUnionType<D, V> | undefined
```
and in the required half, right after `S extends AnySchemaType ? unknown`:
```ts
: S extends LoroUnionSchema<infer D, infer V>
  ? InferUnionType<D, V>
```
Do the same in `InferInputType` with `InferInputUnionType`. Keep the surrounding conditional chain intact; only insert these branches.

`packages/core/src/schema/validators.ts`: add the guard, and include unions in `isContainerSchema`:
```ts
export function isLoroUnionSchema(schema?: SchemaType): schema is AnyLoroUnionSchema {
    return !!schema && (schema as BaseSchemaType).type === "loro-union";
}
```
In `isContainerSchema` add `schema.type === "loro-union" ||` to the list.

`packages/core/src/schema/resolver.ts`, in `getChildContainerSchema`'s switch, add `case "loro-union":` to the container cases. Leave `getChildSchema` unchanged: it returns `undefined` for a union, and path walks handle unions in Task 7.

`packages/core/src/schema/index.ts`: import `AnyLoroUnionSchema`, `LoroUnionSchema`, `UnionVariantSchema` from `./types.js` and `CID_KEY`, `UNKNOWN_VARIANT_KEY` from `../constants.js`; add after `schema.LoroTree`:
```ts
/**
 * Define a discriminated union of LoroMap variants, stored as one LoroMap
 * whose `discriminant` key holds the variant's tag. Variants must not declare
 * the discriminant themselves. A variant switch rewrites the same container in
 * place; see the README for concurrency semantics.
 */
schema.Union = function <
    D extends string,
    V extends Record<string, UnionVariantSchema>,
    O extends SchemaOptions = {},
>(discriminant: D, variants: V, options?: O): LoroUnionSchema<D, V> & { options: O } {
    if (discriminant === CID_KEY || discriminant === UNKNOWN_VARIANT_KEY) {
        throw new Error(`schema.Union: "${discriminant}" is a reserved key`);
    }
    const entries = Object.entries(variants);
    if (entries.length === 0) {
        throw new Error("schema.Union requires at least one variant");
    }
    for (const [tag, variant] of entries) {
        if ((variant as { type: string }).type !== "loro-map") {
            throw new Error(
                `schema.Union variant "${tag}" must be a schema.LoroMap (nested unions are not supported)`,
            );
        }
        if (Object.prototype.hasOwnProperty.call(variant.definition, discriminant)) {
            throw new Error(
                `schema.Union variant "${tag}" must not declare the discriminant "${discriminant}"`,
            );
        }
    }
    return {
        type: "loro-union" as const,
        discriminant,
        variants,
        options: options || ({} as O),
        getContainerType: () => "Map" as const,
    };
};
```
Export `isLoroUnionSchema` and the new types from `src/schema/index.ts`'s re-exports, following how `isLoroTreeSchema` and `LoroTreeSchema` are exported today.

- [ ] **Step 4: Run tests and typecheck**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-builder.test.ts tests/union-types.test-d.ts && pnpm --filter loro-mirror typecheck && pnpm --filter loro-mirror test`
Expected: PASS. If an exhaustive `switch` elsewhere in `src` now errors because `SchemaType` grew, add a `case "loro-union":` that mirrors the `"loro-map"` behavior only where Tasks 2–7 don't already cover it, or a `default` that keeps today's behavior. Note each one in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/tests/union-builder.test.ts packages/core/tests/union-types.test-d.ts
git commit -m "feat(core): add schema.Union builder and types"
```

---

### Task 2: Pure union helpers and validation

**Files:**
- Create: `packages/core/src/schema/union.ts`
- Modify: `packages/core/src/schema/validators.ts` (`validateSchema`), `packages/core/src/core/utils.ts` (`decodeNestedJsonValues`)
- Test: `packages/core/tests/union-validation.test.ts`

**Interfaces:**
- Consumes: Task 1 types and `isLoroUnionSchema`.
- Produces:
  - `resolveUnionVariant(union: AnyLoroUnionSchema, tag: unknown): UnionVariantSchema | undefined`
  - `unionTagOf(tag: unknown): string | null`
  - `isUnknownVariantPlaceholder(value: unknown): value is { $unknownVariant: UnknownVariantInfo }`

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/union-validation.test.ts`:
```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-validation.test.ts`
Expected: FAIL (module `../src/schema/union.js` not found).

- [ ] **Step 3: Implement**

`packages/core/src/schema/union.ts`:
```ts
import { UNKNOWN_VARIANT_KEY } from "../constants.js";
import type {
    AnyLoroUnionSchema,
    UnionVariantSchema,
    UnknownVariantInfo,
} from "./types.js";

/** The variant for `tag`, or undefined for an unknown, missing or non-string tag. */
export function resolveUnionVariant(
    union: AnyLoroUnionSchema,
    tag: unknown,
): UnionVariantSchema | undefined {
    if (typeof tag !== "string") return undefined;
    return Object.prototype.hasOwnProperty.call(union.variants, tag)
        ? union.variants[tag]
        : undefined;
}

/** A stored tag as the placeholder reports it: the string, or null. */
export function unionTagOf(tag: unknown): string | null {
    return typeof tag === "string" ? tag : null;
}

export function isUnknownVariantPlaceholder(
    value: unknown,
): value is { $unknownVariant: UnknownVariantInfo } {
    return (
        typeof value === "object" &&
        value !== null &&
        Object.prototype.hasOwnProperty.call(value, UNKNOWN_VARIANT_KEY)
    );
}
```

In `validateSchema` (validators.ts), add a case next to `"loro-map"`:
```ts
case "loro-union": {
    if (!isObject(value)) {
        errors.push("Value must be an object");
        break;
    }
    if (isUnknownVariantPlaceholder(value)) break;
    const union = schema as unknown as AnyLoroUnionSchema;
    const tag = value[union.discriminant];
    const variant = resolveUnionVariant(union, tag);
    if (!variant) {
        errors.push(
            `Unknown variant ${JSON.stringify(tag)} for discriminant "${union.discriminant}"`,
        );
        break;
    }
    const result = validateSchema(variant, value);
    if (!result.valid && result.errors) errors.push(...result.errors);
    break;
}
```
`getDefaultValue` already returns `options.defaultValue` before its switch and falls to `default: return undefined`, so it needs no change. The test pins this.

In `decodeNestedJsonValues` (core/utils.ts), add before `case "loro-text":`:
```ts
case "loro-union": {
    if (!isObject(json)) return json;
    const variant = resolveUnionVariant(schema, json[schema.discriminant]);
    return variant ? decodeNestedJsonValues(json, variant) : json;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-validation.test.ts && pnpm --filter loro-mirror typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/tests/union-validation.test.ts
git commit -m "feat(core): validate and decode union values"
```

---

### Task 3: Write path — creating union items and same-variant edits

**Files:**
- Create: `packages/core/tests/union-fixtures.ts`, `packages/core/tests/union-write.test.ts`
- Modify: `packages/core/src/core/mirror.ts`, `packages/core/src/core/diff.ts`

**Interfaces:**
- Consumes: `resolveUnionVariant`, `unionTagOf`, `isLoroUnionSchema`, `AnyLoroUnionSchema`.
- Produces:
  - **Registry.** `ContainerRegistry` entries gain `union?: AnyLoroUnionSchema` and `unionTag?: string | null`. For a union map, `schema` is the resolved variant, or `undefined` when the variant is unknown.
  - **Registration options.** `RegisterContainerOptions` gains `value?: unknown` (resolve from the pending value) and `force?: boolean` (overwrite an existing entry and re-scan nested containers with `force`).
  - **Mirror methods.**
    - `private resolveRegistration(container: Container, schema: ContainerSchemaType | undefined, value?: unknown): { schema: ContainerSchemaType | undefined; union?: AnyLoroUnionSchema; unionTag?: string | null }`
    - `registerNestedContainers(container, options?: { force?: boolean })`
  - **Diff.** `diffUnionMap(doc, oldState: ObjectLike, newState: ObjectLike, containerId: ContainerID, schema: AnyLoroUnionSchema, inferOptions?: InferContainerOptions): Change[]`, exported from `diff.ts`.

- [ ] **Step 1: Write the fixtures and failing tests**

`packages/core/tests/union-fixtures.ts`:
```ts
import { isContainer, LoroDoc, LoroList, LoroMap, LoroMovableList } from "loro-crdt";
import { InferType, Mirror, schema } from "../src/index.js";

export const waitForSync = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

export function syncDocs(a: LoroDoc, b: LoroDoc) {
    const ua = a.export({ mode: "update" });
    const ub = b.export({ mode: "update" });
    a.import(ub);
    b.import(ua);
}

/**
 * Placeholders carry no top-level `id` (only `$unknownVariant.data.id`), so an
 * idSelector over a union must read through them. Otherwise replacing a
 * placeholder in an idSelector list becomes delete + insert, not an in-place switch.
 */
export const idOf = (item: unknown): string => {
    if (item === null || typeof item !== "object") return "";
    const record = item as {
        id?: unknown;
        $unknownVariant?: { data: Record<string, unknown> };
    };
    const id = record.$unknownVariant ? record.$unknownVariant.data.id : record.id;
    return typeof id === "string" ? id : "";
};

export const frameSchema = schema.LoroMap({ id: schema.String(), alt: schema.LoroText() });

/**
 * circle.r is a number and ring.r a LoroList: the same key with a different
 * kind. circle/label/slides share `notes` (LoroText): same key, same kind.
 */
const shapeVariants = () => ({
    circle: schema.LoroMap({ id: schema.String(), r: schema.Number(), notes: schema.LoroText() }),
    label: schema.LoroMap({
        id: schema.String(),
        text: schema.LoroText(),
        notes: schema.LoroText(),
        tags: schema.LoroMovableList(schema.String(), (s) => s),
        caption: schema.String({ required: false }),
    }),
    slides: schema.LoroMap({
        id: schema.String(),
        frames: schema.LoroMovableList(frameSchema, idOf),
        notes: schema.LoroText(),
    }),
    ring: schema.LoroMap({ id: schema.String(), r: schema.LoroList(schema.Number()) }),
});

export const makeRoot = () =>
    schema({
        root: schema.LoroMap({
            field: schema.Union("kind", shapeVariants(), { required: false }),
            record: schema.LoroMapRecord(schema.Union("kind", shapeVariants())),
            list: schema.LoroList(schema.Union("kind", shapeVariants())),
            mlist: schema.LoroMovableList(schema.Union("kind", shapeVariants()), idOf),
        }),
    });
export type RootState = InferType<ReturnType<typeof makeRoot>>;

export const PLACEMENTS = ["field", "record", "list", "mlist"] as const;
export type Placement = (typeof PLACEMENTS)[number];
export const MERGEABLE = [false, true] as const;

export function makeMirror(doc: LoroDoc, mergeable: boolean) {
    return new Mirror({
        doc,
        schema: makeRoot(),
        inferOptions: { mergeableMapChildContainers: mergeable },
        checkStateConsistency: true,
    });
}

export function putItem(draft: RootState, placement: Placement, item: Record<string, unknown>) {
    const root = draft.root as unknown as Record<string, unknown> & {
        record: Record<string, unknown>;
        list: unknown[];
        mlist: unknown[];
    };
    if (placement === "field") root.field = item;
    else if (placement === "record") root.record.a = item;
    else root[placement][0] = item;
}

export function itemState(state: RootState, placement: Placement): Record<string, unknown> | undefined {
    const root = state.root as unknown as Record<string, unknown> & {
        record: Record<string, unknown>;
        list: unknown[];
        mlist: unknown[];
    };
    const v =
        placement === "field" ? root.field : placement === "record" ? root.record.a : root[placement][0];
    return v as Record<string, unknown> | undefined;
}

export function itemMap(doc: LoroDoc, placement: Placement): LoroMap {
    const root = doc.getMap("root");
    const slot =
        placement === "field"
            ? root.get("field")
            : placement === "record"
              ? (root.get("record") as LoroMap).get("a")
              : (root.get(placement) as LoroList | LoroMovableList).get(0);
    if (!isContainer(slot) || slot.kind() !== "Map") throw new Error(`no union map at ${placement}`);
    return slot as LoroMap;
}

export const circle = (id = "a", r = 1) => ({ kind: "circle", id, r, notes: "" });
export const slides = (id = "a") => ({
    frames: [
        { id: "f1", alt: "one" },
        { id: "f2", alt: "two" },
    ],
    notes: "",
    id,
    kind: "slides", // deliberately last: child kinds must not depend on key order
});
```

`packages/core/tests/union-write.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isContainer, LoroDoc, LoroMap, LoroMovableList } from "loro-crdt";
import {
    circle,
    itemMap,
    itemState,
    makeMirror,
    MERGEABLE,
    PLACEMENTS,
    putItem,
    slides,
    syncDocs,
    waitForSync,
} from "./union-fixtures.js";

describe.each(MERGEABLE)("union write path (mergeable=%s)", (mergeable) => {
    describe.each(PLACEMENTS)("placement %s", (placement) => {
        it("creates a known variant", () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            mirror.setState((d) => putItem(d, placement, circle()));
            expect(itemMap(doc, placement).toJSON()).toEqual(circle());
            const state = itemState(mirror.getState(), placement)!;
            expect(state).toEqual(circle());
            expect(state.$cid).toBe(itemMap(doc, placement).id);
        });

        it("creates child containers of the variant's kinds even when the tag comes last", () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            mirror.setState((d) => putItem(d, placement, slides()));
            const frames = itemMap(doc, placement).get("frames");
            expect(isContainer(frames) && frames.kind()).toBe("MovableList");
            const first = (frames as LoroMovableList).get(0) as LoroMap;
            expect(isContainer(first.get("alt")) && (first.get("alt") as LoroMap).kind()).toBe("Text");
        });

        it("edits a same-variant item in place", () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            mirror.setState((d) => putItem(d, placement, circle()));
            const cid = itemMap(doc, placement).id;
            mirror.setState((d) => {
                (itemState(d, placement) as { r: number }).r = 2;
            });
            expect(itemMap(doc, placement).id).toBe(cid);
            expect(itemMap(doc, placement).get("r")).toBe(2);
        });

        it("merges a concurrent reorder with a concurrent edit inside a variant", async () => {
            const docA = new LoroDoc();
            const mirrorA = makeMirror(docA, mergeable);
            mirrorA.setState((d) => putItem(d, placement, slides()));
            const docB = new LoroDoc();
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            await waitForSync();

            mirrorA.setState((d) => {
                const frames = (itemState(d, placement) as { frames: unknown[] }).frames;
                frames.reverse();
            });
            mirrorB.setState((d) => {
                const frames = (itemState(d, placement) as { frames: { id: string; alt: string }[] }).frames;
                frames[0]!.alt = "edited";
            });
            syncDocs(docA, docB);
            await waitForSync();

            for (const doc of [docA, docB]) {
                const frames = itemMap(doc, placement).toJSON().frames as { id: string; alt: string }[];
                expect(frames.map((f) => f.id)).toEqual(["f2", "f1"]);
                expect(frames.find((f) => f.id === "f1")!.alt).toBe("edited");
            }
            expect(mirrorA.getState()).toEqual(mirrorB.getState());
        });
    });

    it("re-adding a deleted record entry with another tag leaves no old keys", () => {
        const doc = new LoroDoc();
        const mirror = makeMirror(doc, mergeable);
        mirror.setState((d) => putItem(d, "record", circle()));
        mirror.setState((d) => {
            delete (d.root.record as Record<string, unknown>).a;
        });
        mirror.setState((d) =>
            putItem(d, "record", { kind: "ring", id: "a", r: [1, 2] }),
        );
        expect(itemMap(doc, "record").toJSON()).toEqual({ kind: "ring", id: "a", r: [1, 2] });
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-write.test.ts`
Expected: FAIL. On `main` plus Tasks 1–2, a union child is created schema-less, so `frames` is inferred as a `List`. Same-variant diffs also go schema-less.

- [ ] **Step 3: Implement registration that resolves unions**

In `mirror.ts`:

1. Extend the registry entry type and `RegisterContainerOptions`:
```ts
type ContainerRegistry = Map<
    ContainerID,
    {
        schema: ContainerSchemaType | undefined;
        registered: boolean;
        /** Set when the container is a union map; `schema` is then its resolved variant. */
        union?: AnyLoroUnionSchema;
        /** The tag `schema` was resolved from (null: missing or non-string). */
        unionTag?: string | null;
    }
>;
```
Add `value?: unknown` (resolve a union from this pending value instead of the doc) and `force?: boolean` (replace an existing entry and re-scan nested containers with `force`) to `RegisterContainerOptions`.

2. Add the resolver and use it in `registerContainerHandle`:
```ts
/**
 * Registry entry for `container` under `schema`. A union resolves to its
 * variant: from `value` on the write path (the pending value is
 * authoritative), otherwise from the doc's stored tag.
 */
private resolveRegistration(
    container: Container,
    schema: ContainerSchemaType | undefined,
    value?: unknown,
): { schema: ContainerSchemaType | undefined; union?: AnyLoroUnionSchema; unionTag?: string | null } {
    if (!schema || !isLoroUnionSchema(schema)) return { schema };
    const tag =
        value !== undefined
            ? isObject(value)
                ? value[schema.discriminant]
                : undefined
            : container.kind() === "Map"
              ? (container as LoroMap).get(schema.discriminant)
              : undefined;
    return {
        schema: resolveUnionVariant(schema, tag),
        union: schema,
        unionTag: unionTagOf(tag),
    };
}

private registerContainerHandle(
    container: Container,
    schemaType: ContainerSchemaType | undefined,
    options: RegisterContainerOptions = {},
) {
    const containerId = container.id;
    const shouldScanNested = options.scanNested !== false;
    const resolved = this.resolveRegistration(container, schemaType, options.value);

    const existing = this.containerRegistry.get(containerId);
    if (existing && !options.force) {
        if (!existing.schema && !existing.union && (resolved.schema || resolved.union)) {
            Object.assign(existing, resolved);
            if (shouldScanNested) this.registerNestedContainers(container);
        }
        return;
    }

    this.containerRegistry.set(containerId, { ...resolved, registered: true });
    if (shouldScanNested) {
        this.registerNestedContainers(container, { force: options.force });
    }
}
```
`registerNestedContainers(container, options: { force?: boolean } = {})` passes `{ force: options.force }` as the `options` argument of every `registerChildContainer(...)` call it makes, and as the third argument of the tree branch's `registerContainerHandle` calls.

3. Pass the pending value wherever a container is created and registered:
   - `insertContainerIntoMap`: `this.registerContainerHandle(insertedContainer, schema, { value });`
   - `insertContainerIntoList`: the same.
   - The `MovableList` `set-container` branch of `applyContainerChanges`: the same.

4. `initializeContainer` must initialize a union map with its variant. At the top of the method:
```ts
if (schema && isLoroUnionSchema(schema)) {
    const resolved = this.getContainerSchema(container.id);
    if (!resolved) {
        throw new Error(`Cannot initialize unknown union variant in ${container.id}`);
    }
    schema = resolved;
}
```
(Make the `schema` parameter non-`const`.) The tag key has no field schema in the variant, so the existing map branch writes it as a primitive. `updateMapContainer` already reads `this.getContainerSchema(map.id)`, which is now the variant, so the mergeable path (`insertMergeableContainerIntoMap` → `updateTopLevelContainer`) needs no change.

- [ ] **Step 4: Implement same-variant diffing**

In `diff.ts`, export:
```ts
/**
 * Diff a union map. Same known tag: an ordinary map diff against that variant.
 * A variant change is handled in Task 5; until then it throws.
 */
export function diffUnionMap(
    doc: LoroDoc,
    oldState: ObjectLike,
    newState: ObjectLike,
    containerId: ContainerID,
    schema: AnyLoroUnionSchema,
    inferOptions?: InferContainerOptions,
): Change[] {
    const newTag = (newState as Record<string, unknown>)[schema.discriminant];
    const oldTag = (oldState as Record<string, unknown>)[schema.discriminant];
    const variant = resolveUnionVariant(schema, newTag);
    if (variant && oldTag === newTag) {
        return diffMap(doc, oldState, newState, containerId, variant, inferOptions);
    }
    throw new Error("union variant switch is not implemented yet");
}
```
In `diffContainer`'s `case "Map":`, before `const mapSchema = ...`:
```ts
if (isLoroUnionSchema(schema)) {
    return diffUnionMap(doc, oldState, newState, containerId as ContainerID, schema, effectiveInferOptions);
}
```
`diffMap`'s `schema` parameter accepts `LoroMapSchema<...>`. Widen it to also accept `LoroMapSchemaWithCatchall<...>` if a catchall variant does not typecheck, since `getMapFieldSchema` already handles both.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-write.test.ts && pnpm --filter loro-mirror test && pnpm --filter loro-mirror typecheck`
Expected: PASS, with the whole existing suite still green.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/tests/union-fixtures.ts packages/core/tests/union-write.test.ts
git commit -m "feat(core): create and edit union items under their resolved variant"
```

---

### Task 4: Read projection, placeholders, fault tolerance

**Files:**
- Create: `packages/core/src/core/union.ts`, `packages/core/tests/union-read.test.ts`
- Modify: `packages/core/src/core/mirror.ts`

**Interfaces:**
- Consumes: registry `union`/`unionTag` (Task 3), `isUnknownVariantPlaceholder`, `UNKNOWN_VARIANT_KEY`.
- Produces:
  - `makeUnknownVariantPlaceholder(cid: ContainerID, tag: unknown, data: Record<string, unknown>): Record<string, unknown>`
  - `deepFreeze<T>(value: T): T`
  - `private unionSlotIsReadable(entry: { union: AnyLoroUnionSchema; schema: ContainerSchemaType | undefined }, key: string, value: unknown): boolean`

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/union-read.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { LoroDoc, LoroList, LoroMap } from "loro-crdt";
import { Mirror } from "../src/index.js";
import {
    circle,
    itemMap,
    itemState,
    makeMirror,
    makeRoot,
    MERGEABLE,
    PLACEMENTS,
    putItem,
} from "./union-fixtures.js";

function seed(placement: (typeof PLACEMENTS)[number], mergeable: boolean, mutate: (m: LoroMap) => void) {
    const docA = new LoroDoc();
    makeMirror(docA, mergeable).setState((d) => putItem(d, placement, circle()));
    mutate(itemMap(docA, placement));
    docA.commit();
    const docB = new LoroDoc();
    docB.import(docA.export({ mode: "snapshot" }));
    return { docB, mirrorB: makeMirror(docB, mergeable) };
}

describe.each(MERGEABLE)("union read path (mergeable=%s)", (mergeable) => {
    describe.each(PLACEMENTS)("placement %s", (placement) => {
        it("reads an unknown tag as a frozen placeholder without the discriminant", () => {
            const { mirrorB } = seed(placement, mergeable, (m) => {
                m.set("kind", "video");
                m.set("codec", "h264");
            });
            const item = itemState(mirrorB.getState(), placement)!;
            expect(item.kind).toBeUndefined();
            expect(item).toEqual({
                $unknownVariant: {
                    tag: "video",
                    data: { kind: "video", id: "a", r: 1, notes: "", codec: "h264" },
                },
            });
            expect(Object.isFrozen(item.$unknownVariant)).toBe(true);
            mirrorB.checkStateConsistency();
        });

        it("reads a missing tag as a placeholder with tag null", () => {
            const { mirrorB } = seed(placement, mergeable, (m) => m.delete("kind"));
            const item = itemState(mirrorB.getState(), placement)!;
            expect((item.$unknownVariant as { tag: unknown }).tag).toBeNull();
        });

        it("keeps unrelated setState working while a placeholder is present", () => {
            const { mirrorB } = seed(placement, mergeable, (m) => m.set("kind", "video"));
            expect(() =>
                mirrorB.setState((d) => {
                    (d.root.record as Record<string, unknown>).b = circle("b");
                }),
            ).not.toThrow();
        });

        it("hides keys the variant does not declare", () => {
            const { docB, mirrorB } = seed(placement, mergeable, (m) => m.set("codec", "h264"));
            expect(itemState(mirrorB.getState(), placement)).toEqual(circle());
            expect(itemMap(docB, placement).get("codec")).toBe("h264");
        });

        it("reads a slot of the wrong kind as absent, and recreates it on write", () => {
            const { docB, mirrorB } = seed(placement, mergeable, (m) => {
                m.setContainer("r", new LoroList()); // ring's shape on a circle
            });
            expect(itemState(mirrorB.getState(), placement)!.r).toBeUndefined();
            mirrorB.setState((d) => {
                (itemState(d, placement) as { r: number }).r = 5;
            });
            expect(itemMap(docB, placement).get("r")).toBe(5);
        });
    });
});

describe("initialState", () => {
    it("an initialState union hint neither throws nor writes", () => {
        const doc = new LoroDoc();
        expect(
            () =>
                new Mirror({
                    doc,
                    schema: makeRoot(),
                    initialState: { root: { field: circle() } } as never,
                }),
        ).not.toThrow();
        expect(doc.getMap("root").get("field")).toBeUndefined();
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-read.test.ts`
Expected: FAIL. State shows raw keys (`kind: "video"`, `codec`, the wrong-kind `r`).

- [ ] **Step 3: Implement**

`packages/core/src/core/union.ts`:
```ts
import type { ContainerID } from "loro-crdt";
import { UNKNOWN_VARIANT_KEY } from "../constants.js";
import { unionTagOf } from "../schema/union.js";
import { defineCidProperty } from "./utils.js";

export function deepFreeze<T>(value: T): T {
    if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    }
    return value;
}

/** State placeholder for a union map whose tag this schema does not know. */
export function makeUnknownVariantPlaceholder(
    cid: ContainerID,
    tag: unknown,
    data: Record<string, unknown>,
): Record<string, unknown> {
    const placeholder: Record<string, unknown> = {
        [UNKNOWN_VARIANT_KEY]: deepFreeze({ tag: unionTagOf(tag), data }),
    };
    defineCidProperty(placeholder, cid);
    return placeholder;
}
```

In `mirror.ts`:

1. Add the slot check:
```ts
/**
 * Whether `key` of a known-variant union map is part of its projection: the
 * tag, or a declared (or catchall) non-Ignore field whose stored value matches
 * the declared kind. Anything else is a stray from a concurrent switch, or a
 * newer peer's field, and stays in the doc unseen.
 */
private unionSlotIsReadable(
    entry: { union: AnyLoroUnionSchema; schema: ContainerSchemaType | undefined },
    key: string,
    value: unknown,
): boolean {
    if (key === entry.union.discriminant) return true;
    if (!entry.schema || !isLoroMapSchema(entry.schema)) return false;
    const fieldSchema = getMapFieldSchema(entry.schema, key);
    if (!fieldSchema || fieldSchema.type === "ignore") return false;
    if (fieldSchema.type === "any") return true;
    const kind = schemaToContainerType(fieldSchema);
    return kind ? isContainer(value) && value.kind() === kind : !isContainer(value);
}
```

2. In `containerToMirrorState`'s `kind === "Map"` branch, before building `obj`:
```ts
const unionEntry = this.containerRegistry.get(c.id);
if (unionEntry?.union && !unionEntry.schema) {
    if (options.registerContainers) this.registerNestedContainers(c);
    return makeUnknownVariantPlaceholder(
        c.id,
        m.get(unionEntry.union.discriminant),
        normalizeContainerForJson(m) as Record<string, unknown>,
    ) as MirrorState;
}
```
Inside the key loop, as the first statement:
```ts
if (
    unionEntry?.union &&
    !this.unionSlotIsReadable(
        { union: unionEntry.union, schema: unionEntry.schema },
        k,
        v,
    )
) {
    continue;
}
```
(`v` must be read before the check; move `const v = m.get(k);` above it.)

3. Never register a wrong-kind child under its declared schema. In `registerChildContainer`'s `Map` branch, after `nestedSchema` is chosen, and in `registerContainersFromLoroEvent`'s `map` branch, after `containerSchema` is chosen:
```ts
if (
    nestedSchema &&
    this.containerRegistry.get(parent.id)?.union &&
    schemaToContainerType(nestedSchema) !== child.kind()
) {
    nestedSchema = undefined;
}
```
(For the event branch, use `event.target`, `change` and `containerSchema` for the names.) Ignore fields declared in a variant are already skipped by `unionSlotIsReadable`, so doc writes into them never surface.

4. `mergeInitialIntoBaseWithSchema` needs no change. It has no `"loro-union"` branch, so a union hint is skipped. The `initialState` test pins this.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-read.test.ts tests/union-write.test.ts && pnpm --filter loro-mirror test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/tests/union-read.test.ts
git commit -m "feat(core): project union maps on read and surface unknown variants as placeholders"
```

---

### Task 5: Local variant switch

**Files:**
- Modify: `packages/core/src/core/diff.ts` (`diffUnionMap`), `packages/core/src/core/mirror.ts` (`ChangeKinds`, `applyContainerChanges`, `applyUnionSwitch`)
- Test: `packages/core/tests/union-switch.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4.
- Produces:
  - Change kind `ChangeKinds["unionSwitch"] = { container: ContainerID; value: Record<string, unknown>; kind: "union-switch" }`, included in `Change`.
  - `private applyUnionSwitch(map: LoroMap, value: Record<string, unknown>): void`

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/union-switch.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { isContainer, LoroDoc, LoroMap, LoroText } from "loro-crdt";
import {
    circle,
    itemMap,
    itemState,
    makeMirror,
    MERGEABLE,
    PLACEMENTS,
    putItem,
    RootState,
} from "./union-fixtures.js";

const label = (id = "a") => ({ kind: "label", id, text: "hello", notes: "kept", tags: ["x"] });

describe.each(MERGEABLE)("union switch (mergeable=%s)", (mergeable) => {
    describe.each(PLACEMENTS)("placement %s", (placement) => {
        const setup = () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            mirror.setState((d) => putItem(d, placement, { ...circle(), notes: "orig" }));
            return { doc, mirror, cid: itemMap(doc, placement).id };
        };

        it("switches by replacing the object, in place", () => {
            const { doc, mirror, cid } = setup();
            mirror.setState((d) => putItem(d, placement, label()));
            expect(itemMap(doc, placement).id).toBe(cid);
            expect(itemMap(doc, placement).toJSON()).toEqual(label());
            expect(itemState(mirror.getState(), placement)!.$cid).toBe(cid);
        });

        it("switches by assigning the tag", () => {
            const { doc, mirror, cid } = setup();
            mirror.setState((d) => {
                const item = itemState(d, placement) as Record<string, unknown>;
                item.kind = "label";
                delete item.r;
                item.text = "hello";
                item.notes = "kept";
                item.tags = ["x"];
            });
            expect(itemMap(doc, placement).id).toBe(cid);
            expect(itemMap(doc, placement).toJSON()).toEqual(label());
        });

        it("keeps a same-kind child container and reconciles it", () => {
            const { doc, mirror } = setup();
            const notesBefore = (itemMap(doc, placement).get("notes") as LoroText).id;
            mirror.setState((d) => putItem(d, placement, label()));
            const notesAfter = itemMap(doc, placement).get("notes") as LoroText;
            expect(notesAfter.id).toBe(notesBefore);
            expect(notesAfter.toString()).toBe("kept");
        });

        it("recreates a child whose kind changes", () => {
            const { doc, mirror } = setup();
            mirror.setState((d) => putItem(d, placement, { kind: "ring", id: "a", r: [1, 2] }));
            const r = itemMap(doc, placement).get("r");
            expect(isContainer(r) && r.kind()).toBe("List");
            expect(itemMap(doc, placement).toJSON()).toEqual({ kind: "ring", id: "a", r: [1, 2] });
        });

        it("deletes stray doc keys the state never showed", () => {
            const { doc, mirror } = setup();
            itemMap(doc, placement).set("codec", "h264");
            doc.commit();
            mirror.setState((d) => putItem(d, placement, label()));
            expect(itemMap(doc, placement).get("codec")).toBeUndefined();
        });

        it("an explicit undefined in a switch value writes no key", () => {
            const { doc, mirror } = setup();
            mirror.setState((d) => putItem(d, placement, { ...label(), caption: undefined }));
            expect(itemMap(doc, placement).toJSON()).not.toHaveProperty("caption");
        });

        it("rejects a user-written unknown tag", () => {
            const { mirror } = setup();
            expect(() => mirror.setState((d) => putItem(d, placement, { kind: "video", id: "a" }))).toThrow(
                /Unknown variant "video"/,
            );
        });

        describe("placeholders", () => {
            const withPlaceholder = () => {
                const ctx = setup();
                itemMap(ctx.doc, placement).set("kind", "video");
                ctx.doc.commit();
                // Rebuild a mirror over the doc so the item reads as a placeholder.
                return { ...ctx, mirror: makeMirror(ctx.doc, mergeable) };
            };

            it("replaces a placeholder with a known variant in place", () => {
                const { doc, mirror, cid } = withPlaceholder();
                mirror.setState((d) => putItem(d, placement, label()));
                expect(itemMap(doc, placement).id).toBe(cid);
                expect(itemMap(doc, placement).toJSON()).toEqual(label());
            });

            it("refuses edits inside a placeholder and changes nothing", () => {
                const { doc, mirror } = withPlaceholder();
                const before = doc.oplogVersion().toJSON();
                const stateBefore = mirror.getState();
                expect(() =>
                    mirror.setState((d) => {
                        const item = itemState(d, placement) as {
                            $unknownVariant: { data: Record<string, unknown> };
                        };
                        item.$unknownVariant.data.codec = "x";
                    }),
                ).toThrow(/unknown union variant/);
                expect(doc.oplogVersion().toJSON()).toEqual(before);
                expect(mirror.getState()).toBe(stateBefore);
            });
        });
    });

    it("deletes a placeholder", () => {
        const doc = new LoroDoc();
        makeMirror(doc, mergeable).setState((d) => putItem(d, "record", circle()));
        itemMap(doc, "record").set("kind", "video");
        doc.commit();
        const mirror = makeMirror(doc, mergeable);
        mirror.setState((d) => {
            delete (d.root.record as Record<string, unknown>).a;
        });
        expect((doc.getMap("root").get("record") as LoroMap).get("a")).toBeUndefined();
    });

    it("moves and switches one item in a single setState", () => {
        const doc = new LoroDoc();
        const mirror = makeMirror(doc, mergeable);
        mirror.setState((d: RootState) => {
            (d.root.mlist as unknown[]).push(circle("a"), circle("b"));
        });
        const list = doc.getMap("root").get("mlist") as unknown as { get(i: number): LoroMap };
        const cidA = list.get(0).id;
        mirror.setState((d: RootState) => {
            (d.root as unknown as { mlist: unknown[] }).mlist = [circle("b"), label("a")];
        });
        expect(list.get(1).id).toBe(cidA);
        expect(list.get(1).toJSON()).toEqual(label("a"));
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-switch.test.ts`
Expected: FAIL with `union variant switch is not implemented yet`.

- [ ] **Step 3: Implement the diff**

Replace `diffUnionMap`'s body in `diff.ts`:
```ts
export function diffUnionMap(
    doc: LoroDoc,
    oldState: ObjectLike,
    newState: ObjectLike,
    containerId: ContainerID,
    schema: AnyLoroUnionSchema,
    inferOptions?: InferContainerOptions,
): Change[] {
    if (isUnknownVariantPlaceholder(newState)) {
        if (oldState === newState) return [];
        // Thrown during the diff, before any Loro op is applied: this setState
        // fails as a whole and the mirror stays usable.
        throw new Error(
            `Cannot modify an unknown union variant in place (${containerId}); delete or replace the whole item`,
        );
    }
    const next = newState as Record<string, unknown>;
    const newTag = next[schema.discriminant];
    const variant = resolveUnionVariant(schema, newTag);
    if (!variant) {
        throw new Error(
            `Unknown variant ${JSON.stringify(newTag)} for discriminant "${schema.discriminant}"`,
        );
    }
    if (
        !isUnknownVariantPlaceholder(oldState) &&
        (oldState as Record<string, unknown>)[schema.discriminant] === newTag
    ) {
        return diffMap(doc, oldState, newState, containerId, variant, inferOptions);
    }
    return [{ container: containerId, value: next, kind: "union-switch" }];
}
```
Note: `diffMap` emits a plain `delete` when a whole item disappears and a plain `insert-container` when one appears. Both reach a placeholder unchanged, so deleting a placeholder needs no union code.

- [ ] **Step 4: Implement the applier**

In `mirror.ts`, add to `ChangeKinds`:
```ts
unionSwitch: {
    container: ContainerID;
    value: Record<string, unknown>;
    kind: "union-switch";
};
```
Audit every consumer of `Change` for the new key-less kind: `hasKeyProp`, the ephemeral `isEligible` (it already returns false for any kind but `set`/`insert`), `applyRootChanges`, and any `switch (change.kind)` with a throwing `default`. Make each one either ignore the kind or route it here.

In `applyContainerChanges`' `case "Map":` loop, as the first statement:
```ts
if (change.kind === "union-switch") {
    this.applyUnionSwitch(map, change.value);
    continue;
}
```
Add:
```ts
/**
 * Switch a union map to another variant in place (same container, same $cid):
 * re-register under the variant resolved from the pending value, write the
 * tag, delete every doc key the new value lacks (including strays the state
 * never showed), then write each key under the new variant. A same-kind child
 * is kept and reconciled; a different-kind child is recreated. A re-ensured
 * mergeable child revives its old contents, so every write is a full
 * reconcile.
 */
private applyUnionSwitch(map: LoroMap, value: Record<string, unknown>) {
    const union = this.containerRegistry.get(map.id)?.union;
    if (!union) {
        throw new Error(`union-switch on a container not registered as a union: ${map.id}`);
    }
    this.registerContainerHandle(map, union, { value, force: true, scanNested: false });
    const variant = this.getContainerSchema(map.id);
    if (!variant || !isLoroMapSchema(variant)) {
        throw new Error(`union-switch to an unknown variant in ${map.id}`);
    }

    map.set(union.discriminant, value[union.discriminant] as Value);
    for (const key of map.keys()) {
        if (key === union.discriminant) continue;
        if (value[key] === undefined) map.delete(key);
    }
    for (const [key, val] of Object.entries(value)) {
        if (key === CID_KEY || key === union.discriminant || val === undefined) continue;
        const fieldSchema = getMapFieldSchema(variant, key);
        const existing = map.get(key);
        const kind = fieldSchema && isContainerSchema(fieldSchema) ? schemaToContainerType(fieldSchema) : undefined;
        if (kind && isContainer(existing) && existing.kind() === kind && isValueOfContainerType(kind, val)) {
            this.registerContainerHandle(existing, fieldSchema as ContainerSchemaType, { value: val, force: true });
            this.updateTopLevelContainer(existing, val);
            continue;
        }
        this.updateMapEntry(map, key, val, variant);
    }
    defineCidProperty(value, map.id);
}
```
(Import `Value` from `loro-crdt` as a type if it isn't already imported, along with `isValueOfContainerType`/`schemaToContainerType`/`defineCidProperty` from `./utils.js`, `getMapFieldSchema` from `../schema/resolver.js`, and `isUnknownVariantPlaceholder`/`resolveUnionVariant` where `diff.ts` needs them.)

- [ ] **Step 5: Run tests**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-switch.test.ts tests/union-write.test.ts tests/union-read.test.ts && pnpm --filter loro-mirror test && pnpm --filter loro-mirror typecheck`
Expected: PASS. `checkStateConsistency: true` in the fixture mirror proves state equals the doc projection after every switch.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/tests/union-switch.test.ts
git commit -m "feat(core): switch union variants in place"
```

---

### Task 6: Remote switches and incremental re-projection

**Files:**
- Modify: `packages/core/src/core/mirror.ts`, `packages/core/src/core/loroEventApply.ts`, `packages/core/src/schema/validators.ts` (`schemaContainsUnion`)
- Test: `packages/core/tests/union-remote.test.ts`

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces:
  - **`schemaContainsUnion(schema: SchemaType | undefined): boolean`** in validators.ts.
  - **New option on `applyEventBatchToState`:**
    ```ts
    reproject?: {
        ids: ContainerID[];
        getPath: (id: ContainerID) => (string | number)[] | undefined;
        project: (id: ContainerID, previous: unknown) => MirrorState | undefined;
    }
    ```
  - **Mirror members:**
    - `private hasUnionSchemas: boolean`
    - `private routeUnionEvents(batch: LoroEventBatch): { batch: LoroEventBatch; reproject: ContainerID[] }`
    - `private reresolveUnionOnTagChange(target: ContainerID, updated: Record<string, unknown>): void`
    - `private reprojectUnionMap(id: ContainerID, previous: unknown): MirrorState | undefined`

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/union-remote.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { EphemeralStore, isContainer, LoroDoc, LoroText } from "loro-crdt";
import { Mirror } from "../src/index.js";
import {
    circle,
    itemMap,
    itemState,
    makeMirror,
    makeRoot,
    MERGEABLE,
    PLACEMENTS,
    putItem,
    slides,
    syncDocs,
    waitForSync,
} from "./union-fixtures.js";

describe.each(MERGEABLE)("remote union changes (mergeable=%s)", (mergeable) => {
    describe.each(PLACEMENTS)("placement %s", (placement) => {
        const pair = async () => {
            const docA = new LoroDoc();
            const mirrorA = makeMirror(docA, mergeable);
            mirrorA.setState((d) => putItem(d, placement, circle()));
            const docB = new LoroDoc();
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            await waitForSync();
            return { docA, mirrorA, docB, mirrorB };
        };

        it("re-registers and re-projects after a remote switch", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => putItem(d, placement, slides()));
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorB.getState(), placement)).toEqual(itemState(mirrorA.getState(), placement));
            // B's next local edit must use the new variant's schemas: a reorder stays a move.
            mirrorB.setState((d) => {
                (itemState(d, placement) as { frames: unknown[] }).frames.reverse();
            });
            const frames = itemMap(docB, placement).get("frames");
            expect(isContainer(frames) && frames.kind()).toBe("MovableList");
            mirrorB.checkStateConsistency();
        });

        it("hides a remote stray key on a known variant", async () => {
            const { docA, docB, mirrorB } = await pair();
            itemMap(docA, placement).set("codec", "h264");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorB.getState(), placement)).toEqual(circle());
            mirrorB.checkStateConsistency();
        });

        it("turns a remote unknown tag into a placeholder and back", async () => {
            const { docA, docB, mirrorB } = await pair();
            itemMap(docA, placement).set("kind", "video");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorB.getState(), placement)!.kind).toBeUndefined();
            expect(itemState(mirrorB.getState(), placement)!.$unknownVariant).toBeDefined();

            itemMap(docA, placement).set("kind", "circle");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorB.getState(), placement)).toEqual(circle());
            mirrorB.checkStateConsistency();
        });

        it("re-projects a placeholder when a container inside it changes", async () => {
            const { docA, docB, mirrorB } = await pair();
            const m = itemMap(docA, placement);
            m.set("kind", "video");
            m.setContainer("subtitle", new LoroText()).insert(0, "hi");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            (itemMap(docA, placement).get("subtitle") as LoroText).insert(2, "!");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            const info = itemState(mirrorB.getState(), placement)!.$unknownVariant as {
                data: Record<string, unknown>;
            };
            expect(info.data.subtitle).toBe("hi!");
            mirrorB.checkStateConsistency();
        });
    });

    it("switches through an ephemeral-store mirror", () => {
        const doc = new LoroDoc();
        const mirror = new Mirror({
            doc,
            schema: makeRoot(),
            inferOptions: { mergeableMapChildContainers: mergeable },
            ephemeralStore: new EphemeralStore(),
        });
        mirror.setState((d) => putItem(d, "record", circle()));
        mirror.setState((d) => putItem(d, "record", slides()));
        mirror.finalizeEphemeralPatches();
        expect(itemState(mirror.getState(), "record")).toEqual(itemMap(doc, "record").toJSON());
        mirror.checkStateConsistency();
    });
});
```
If the `EphemeralStore` constructor takes arguments in the installed loro-crdt, mirror how `tests/ephemeral-patch.test.ts` constructs one.

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-remote.test.ts`
Expected: FAIL. After a remote switch, B shows a mixture of both variants (stale registration plus per-key event application). Stray keys and the placeholder transitions also fail.

- [ ] **Step 3: Implement tag-change re-registration**

In `validators.ts`, next to `schemaContainsIgnoreField`:
```ts
/** Whether a schema subtree contains a union (recursive schemas tolerated). */
export function schemaContainsUnion(schema: SchemaType | undefined): boolean {
    const visited = new Set<SchemaType>();
    const walk = (s: SchemaType | undefined): boolean => {
        if (!s || visited.has(s)) return false;
        visited.add(s);
        switch (s.type) {
            case "loro-union":
                return true;
            case "schema":
            case "loro-map": {
                const r = s as { definition: Record<string, SchemaType>; catchallType?: SchemaType };
                return Object.values(r.definition).some(walk) || walk(r.catchallType);
            }
            case "loro-list":
            case "loro-movable-list":
                return walk(s.itemSchema);
            case "loro-tree":
                return walk(s.nodeSchema);
            default:
                return false;
        }
    };
    return walk(schema);
}
```
In the `Mirror` constructor, next to the Ignore caching: `this.hasUnionSchemas = schemaContainsUnion(this.schema);` (declare `private hasUnionSchemas = false;`).

In `mirror.ts`:
```ts
/** A remote write changed a union map's tag: re-resolve it and its subtree. */
private reresolveUnionOnTagChange(target: ContainerID, updated: Record<string, unknown>) {
    const entry = this.containerRegistry.get(target);
    if (!entry?.union) return;
    if (!Object.prototype.hasOwnProperty.call(updated, entry.union.discriminant)) return;
    const map = this.doc.getContainerById(target);
    if (!map || map.kind() !== "Map") return;
    if (unionTagOf((map as LoroMap).get(entry.union.discriminant)) === entry.unionTag) return;
    this.registerContainerHandle(map, entry.union, { force: true });
}
```
Call it as the first statement of the `else if (event.diff.type === "map")` branch of `registerContainersFromLoroEvent`, before `parentSchema` is read: `this.reresolveUnionOnTagChange(event.target, event.diff.updated);`. The method is idempotent, so the second `registerContainersFromLoroEvent` call in `handleLoroEvent`'s `finally` is a no-op.

- [ ] **Step 4: Implement event routing and re-projection**

In `loroEventApply.ts`, add the `reproject` option to `applyEventBatchToState`'s object-options type. Inside its `produce` callback, after the `for (const e of event.events)` loop:
```ts
if (opts.reproject) {
    for (const id of opts.reproject.ids) {
        const path = opts.reproject.getPath(id);
        if (!path || path.length === 0) continue;
        let parent: unknown = draft;
        for (let i = 0; i < path.length - 1; i++) {
            if (parent === null || typeof parent !== "object") break;
            parent = getAt(parent as MirrorStateObject | MirrorState[], path[i]!);
        }
        if (parent === null || typeof parent !== "object") continue;
        const last = path[path.length - 1]!;
        const previous = getAt(parent as MirrorStateObject | MirrorState[], last);
        const projected = opts.reproject.project(id, previous);
        if (projected !== undefined) {
            setAt(parent as MirrorStateObject | MirrorState[], last, projected);
        }
    }
}
```
The single-text fast path (`applySingleTextEvent`) must be skipped when `opts.reproject?.ids.length` is non-zero. Guard the early return accordingly.

In `mirror.ts`:
```ts
/**
 * Events under an unknown-variant placeholder are dropped and the placeholder
 * re-projected; a map event on a known union map re-projects that map (the
 * tag may have changed, or a stray key arrived).
 */
private routeUnionEvents(batch: LoroEventBatch): { batch: LoroEventBatch; reproject: ContainerID[] } {
    if (!this.hasUnionSchemas) return { batch, reproject: [] };
    const reproject = new Set<ContainerID>();
    const events = batch.events.filter((e) => {
        let cur = this.doc.getContainerById(e.target);
        while (cur) {
            const entry = this.containerRegistry.get(cur.id);
            if (entry?.union && !entry.schema) {
                reproject.add(cur.id);
                return false;
            }
            cur = cur.parent() ?? undefined;
        }
        if (e.diff.type === "map" && this.containerRegistry.get(e.target)?.union) {
            reproject.add(e.target);
        }
        return true;
    });
    return {
        batch: events.length === batch.events.length ? batch : ({ ...batch, events } as LoroEventBatch),
        reproject: [...reproject],
    };
}

/** Fresh projection of a union map, keeping its variant's memory-only Ignore values. */
private reprojectUnionMap(id: ContainerID, previous: unknown): MirrorState | undefined {
    const c = this.doc.getContainerById(id);
    if (!c || c.isDeleted()) return undefined;
    const projected = this.containerToMirrorState(c) as MirrorStateObject;
    const variant = this.containerRegistry.get(id)?.schema;
    if (variant && isLoroMapSchema(variant) && isObject(previous) && !isUnknownVariantPlaceholder(previous)) {
        for (const [key, fieldSchema] of Object.entries(variant.definition)) {
            if (fieldSchema.type === "ignore" && key in previous) {
                projected[key] = previous[key] as MirrorState;
            }
        }
    }
    return projected;
}
```
(If `isDeleted` is not on the installed `Container` type, check `doc.getPathToContainer(id)` for `undefined` instead.)

Thread it through both event paths. Change `applyNormalizedLoroEventToState(currentState, event)` to take a third parameter `reproject: ContainerID[] = []`, and pass to `applyEventBatchToState`:
```ts
reproject: reproject.length
    ? {
          ids: reproject,
          getPath: (id) => this.doc.getPathToContainer(id) ?? undefined,
          project: (id, previous) => this.reprojectUnionMap(id, previous),
      }
    : undefined,
```
In `handleLoroEvent`, after `this.registerContainersFromLoroEvent(filtered);`:
```ts
const routed = this.routeUnionEvents(filtered);
const normalized = this.normalizeLoroEventBatch(routed.batch);
this.baseState = this.applyNormalizedLoroEventToState(this.baseState, normalized, routed.reproject);
```
Apply the same three lines in `applyLocalLoroChanges`, for both its `baseState` and `state` applications. The early `filtered.events.length === 0` checks stay where they are, since they concern Ignore filtering. After routing, an empty `events` list with a non-empty `reproject` must still be applied.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-*.test.ts && pnpm --filter loro-mirror test && pnpm --filter loro-mirror typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/tests/union-remote.test.ts
git commit -m "feat(core): re-resolve and re-project union maps on doc events"
```

---

### Task 7: Path walks through unions (#97, #99)

**Files:**
- Modify: `packages/core/src/core/mirror.ts` (`pathResolvesToIgnore`, `isIgnoredEvent`), `packages/core/src/schema/validators.ts` (`schemaContainsIgnoreField`)
- Test: `packages/core/tests/union-paths.test.ts`

**Interfaces:**
- Consumes: registry `union` entries.
- Produces: `private pathResolvesToIgnore(path: (string | number)[], target: ContainerID): boolean` (new `target` parameter); `private containerChainOf(target: ContainerID): Container[]` (root first).

- [ ] **Step 1: Write the failing tests**

`packages/core/tests/union-paths.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { LoroDoc, LoroList, LoroMap, LoroText } from "loro-crdt";
import { Mirror, schema } from "../src/index.js";
import { syncDocs, waitForSync } from "./union-fixtures.js";

const makeSchema = () =>
    schema({
        root: schema.LoroMap({
            items: schema.LoroMapRecord(
                schema.Union("kind", {
                    note: schema.LoroMap({
                        body: schema.LoroText(),
                        cache: schema.Ignore<{ hits: number }>(),
                    }),
                    other: schema.LoroMap({ n: schema.Number() }),
                }),
            ),
            sibling: schema.LoroMap({ x: schema.Number() }),
        }),
    });

describe.each([false, true])("union path walks (mergeable=%s)", (mergeable) => {
    const make = (doc: LoroDoc) =>
        new Mirror({ doc, schema: makeSchema(), inferOptions: { mergeableMapChildContainers: mergeable }, checkStateConsistency: true });

    it("drops doc writes into an Ignore field inside a variant and keeps the memory value", async () => {
        const docA = new LoroDoc();
        const mirrorA = make(docA);
        mirrorA.setState((d) => {
            d.root.items.a = { kind: "note", body: "x", cache: { hits: 1 } } as never;
        });
        const docB = new LoroDoc();
        docB.import(docA.export({ mode: "snapshot" }));
        const mirrorB = make(docB);
        mirrorB.setState((d) => {
            (d.root.items.a as { cache: unknown }).cache = { hits: 7 };
        });
        const item = (docA.getMap("root").get("items") as LoroMap).get("a") as LoroMap;
        const cache = item.setContainer("cache", new LoroList());
        cache.push(1);
        (item.get("body") as LoroText).insert(1, "y");
        docA.commit();
        syncDocs(docA, docB);
        await waitForSync();
        const stateItem = mirrorB.getState().root.items.a as { body: string; cache: unknown };
        expect(stateItem.body).toBe("xy");
        expect(stateItem.cache).toEqual({ hits: 7 });
        expect(mirrorB.getContainerIds()).not.toContain(cache.id);
    });

    it("applies a single remote text event inside a variant without touching siblings", async () => {
        const docA = new LoroDoc();
        const mirrorA = make(docA);
        mirrorA.setState((d) => {
            d.root.items.a = { kind: "note", body: "x" } as never;
            d.root.sibling.x = 1;
        });
        const docB = new LoroDoc();
        docB.import(docA.export({ mode: "snapshot" }));
        const mirrorB = make(docB);
        const siblingBefore = mirrorB.getState().root.sibling;
        (((docA.getMap("root").get("items") as LoroMap).get("a") as LoroMap).get("body") as LoroText).insert(1, "!");
        docA.commit();
        syncDocs(docA, docB);
        await waitForSync();
        expect((mirrorB.getState().root.items.a as { body: string }).body).toBe("x!");
        expect(mirrorB.getState().root.sibling).toBe(siblingBefore);
    });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-paths.test.ts`
Expected: FAIL. The Ignore test fails: `schemaContainsIgnoreField` doesn't descend into variants, so `hasNestedIgnoreFields` is false and the `cache` event is applied and registered.

- [ ] **Step 3: Implement**

In `schemaContainsIgnoreField`'s `walk`, add:
```ts
case "loro-union":
    return Object.values(
        (s as unknown as AnyLoroUnionSchema).variants,
    ).some(walk);
```
In `mirror.ts`:
```ts
/** The container chain from the root container down to `target`. */
private containerChainOf(target: ContainerID): Container[] {
    const chain: Container[] = [];
    let cur = this.doc.getContainerById(target);
    while (cur) {
        chain.push(cur);
        cur = cur.parent() ?? undefined;
    }
    return chain.reverse();
}
```
Change `pathResolvesToIgnore(path)` to `pathResolvesToIgnore(path, target)` and resolve unions at each hop through the registry:
```ts
private pathResolvesToIgnore(path: (string | number)[], target: ContainerID): boolean {
    if (!this.schema || this.schema.type !== "schema") return false;
    let current: SchemaType | undefined = (
        this.schema.definition as Record<string, SchemaType>
    )[String(path[0])];
    let chain: Container[] | undefined;
    for (let i = 1; i < path.length && current; i++) {
        if ((current as { type: string }).type === "ignore") return true;
        if (isLoroUnionSchema(current)) {
            // The union map sits at path[0..i-1]; use its resolved variant.
            chain ??= this.containerChainOf(target);
            const hop = chain[i - 1];
            current = hop ? this.getContainerSchema(hop.id) : undefined;
            if (!current) return false;
        }
        current = getChildSchema(current, path[i]);
    }
    return !!current && (current as { type: string }).type === "ignore";
}
```
Update its call in `isIgnoredEvent` to pass `e.target`. The single-text fast path needs no change. The second test pins that it still works inside a variant.

- [ ] **Step 4: Run tests**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-*.test.ts tests/ignore-*.test.ts && pnpm --filter loro-mirror test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/tests/union-paths.test.ts
git commit -m "fix(core): resolve unions in Ignore path walks"
```

---

### Task 8: Concurrency semantics and docs

**Files:**
- Test: `packages/core/tests/union-concurrency.test.ts`
- Modify: `packages/core/README.md`, `README.md` (only if it lists schema builders), `api.md`, `AGENTS.md`

**Interfaces:**
- Consumes: everything above. No new production code is expected. If a test here fails, fix the owning task's code and say so in the commit message.

- [ ] **Step 1: Write the tests**

`packages/core/tests/union-concurrency.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { LoroDoc, LoroText } from "loro-crdt";
import {
    circle,
    itemMap,
    itemState,
    makeMirror,
    MERGEABLE,
    PLACEMENTS,
    putItem,
    slides,
    syncDocs,
    waitForSync,
} from "./union-fixtures.js";

const label = () => ({ kind: "label", id: "a", text: "t", notes: "n", tags: [] });
const ring = () => ({ kind: "ring", id: "a", r: [1] });

describe.each(MERGEABLE)("union concurrency (mergeable=%s)", (mergeable) => {
    describe.each(PLACEMENTS)("placement %s", (placement) => {
        const pair = async () => {
            const docA = new LoroDoc();
            docA.setPeerId(1);
            const mirrorA = makeMirror(docA, mergeable);
            mirrorA.setState((d) => putItem(d, placement, { ...circle(), notes: "base" }));
            const docB = new LoroDoc();
            docB.setPeerId(2);
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            await waitForSync();
            return { docA, mirrorA, docB, mirrorB };
        };

        it("concurrent switches converge on the winning tag and show only its keys", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => putItem(d, placement, label()));
            mirrorB.setState((d) => putItem(d, placement, ring()));
            syncDocs(docA, docB);
            await waitForSync();
            const a = itemState(mirrorA.getState(), placement);
            expect(a).toEqual(itemState(mirrorB.getState(), placement));
            expect([label(), ring()]).toContainEqual(a);
            mirrorA.checkStateConsistency();
            mirrorB.checkStateConsistency();

            // The next local switch clears the losing variant's strays from the doc.
            mirrorA.setState((d) => putItem(d, placement, circle()));
            expect(itemMap(docA, placement).toJSON()).toEqual(circle());
        });

        it("a switch beats a concurrent edit to a key it deleted", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => putItem(d, placement, ring()));
            mirrorB.setState((d) => {
                (itemState(d, placement) as { r: number }).r = 9;
            });
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorA.getState(), placement)).toEqual(itemState(mirrorB.getState(), placement));
            mirrorA.checkStateConsistency();
            mirrorB.checkStateConsistency();
        });

        it("a same-name, same-kind key keeps concurrent edits across a switch", async () => {
            const { docA, mirrorA, docB } = await pair();
            mirrorA.setState((d) => putItem(d, placement, { ...slides(), notes: "base" }));
            (itemMap(docB, placement).get("notes") as LoroText).insert(4, "!");
            docB.commit();
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemMap(docA, placement).get("kind")).toBe("slides");
            expect((itemMap(docA, placement).get("notes") as LoroText).toString()).toBe("base!");
        });

        it("switching back after a concurrent switch revives no stale contents", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => putItem(d, placement, slides()));
            mirrorB.setState((d) => putItem(d, placement, label()));
            syncDocs(docA, docB);
            await waitForSync();
            mirrorA.setState((d) => putItem(d, placement, { ...slides(), frames: [] }));
            expect(itemMap(docA, placement).toJSON()).toEqual({ ...slides(), frames: [] });
            mirrorA.checkStateConsistency();
        });
    });
});
```

- [ ] **Step 2: Run them**

Run: `pnpm --filter loro-mirror exec vitest run tests/union-concurrency.test.ts`
Expected: PASS. If anything fails, the defect belongs to Task 5 or 6: fix it there, re-run all `tests/union-*`, and commit the fix separately as `fix(core): ...`, naming the scenario.

- [ ] **Step 3: Document**

- **`packages/core/README.md`:** in the Schema Builder section, add `schema.Union(discriminant, variants, options?)`, then a "Discriminated unions" subsection covering:
  - Where a union may appear, and where it may not.
  - Variants are `LoroMap`s and must not declare the discriminant.
  - Switch semantics:
    1. In place, same `$cid`.
    2. The tag is written first.
    3. Doc keys absent from the new value are deleted.
    4. A same-kind child is kept, a different-kind child recreated.
  - Concurrency:
    - The tag is last-writer-wins; the losing variant's keys stay in the doc, hidden, until the next switch.
    - A switch beats a concurrent edit to a key it deleted.
    - A same-name, same-kind key survives.
  - The unknown-variant placeholder:
    - Its shape and `tag: null`.
    - The `case undefined` narrowing.
    - Read-only: replace or delete the whole item; editing inside fails only that `setState`.
  - Projection hides undeclared keys on known variants; this differs from plain `LoroMap`, which shows them.
  - A catchall variant shows strays as catchall entries.
  - `initialState` does not hint union values.
  - `$unknownVariant` is reserved.
- **`api.md`:** the same API line, plus `isLoroUnionSchema` and `LoroUnionSchema` in the guards and types lists.
- **`AGENTS.md`:** add `.Union(discriminant, variants, options?)` to the builders, `isLoroUnionSchema` to the guards, `LoroUnionSchema` to the re-exported types, and mention `$unknownVariant` next to `$cid`.

- [ ] **Step 4: Full gate**

Run from the repo root: `pnpm build && pnpm test && pnpm lint && pnpm typecheck`
Expected: all pass. Fix lint findings only in lines this branch touched.

- [ ] **Step 5: Commit**

```bash
git add packages/core/tests/union-concurrency.test.ts packages/core/README.md README.md api.md AGENTS.md
git commit -m "docs(core): document schema.Union and pin its concurrency semantics"
```

---

## After the plan

Report back with the branch's commit list and gate output. Opening the upstream PR, closing #76, and publishing `@synapdeck/loro-mirror` all wait for the user. Publishing belongs to sub-project 2.
