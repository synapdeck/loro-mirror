import {
    isContainer,
    LoroDoc,
    LoroList,
    LoroMap,
    LoroMovableList,
} from "loro-crdt";
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
    const id = record.$unknownVariant
        ? record.$unknownVariant.data.id
        : record.id;
    return typeof id === "string" ? id : "";
};

export const frameSchema = schema.LoroMap({
    id: schema.String(),
    alt: schema.LoroText(),
});

/**
 * circle.r is a number and ring.r a LoroList: the same key with a different
 * kind. circle/label/slides share `notes` (LoroText): same key, same kind.
 */
const shapeVariants = () => ({
    circle: schema.LoroMap({
        id: schema.String(),
        r: schema.Number(),
        notes: schema.LoroText(),
    }),
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
    ring: schema.LoroMap({
        id: schema.String(),
        r: schema.LoroList(schema.Number()),
    }),
});

export const makeRoot = () =>
    schema({
        root: schema.LoroMap({
            field: schema.Union("kind", shapeVariants(), { required: false }),
            record: schema.LoroMapRecord(schema.Union("kind", shapeVariants())),
            list: schema.LoroList(schema.Union("kind", shapeVariants())),
            mlist: schema.LoroMovableList(
                schema.Union("kind", shapeVariants()),
                idOf,
            ),
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

export function putItem(
    draft: { root: unknown },
    placement: Placement,
    item: Record<string, unknown>,
) {
    const root = draft.root as unknown as Record<string, unknown> & {
        record: Record<string, unknown>;
        list: unknown[];
        mlist: unknown[];
    };
    // Nested containers are not defaulted in the initial state, so create them on demand.
    if (placement === "field") root.field = item;
    else if (placement === "record") (root.record ??= {}).a = item;
    else (root[placement] ??= [])[0] = item;
}

export function itemState(
    state: { root: unknown },
    placement: Placement,
): Record<string, unknown> | undefined {
    const root = state.root as unknown as Record<string, unknown> & {
        record: Record<string, unknown>;
        list: unknown[];
        mlist: unknown[];
    };
    const v =
        placement === "field"
            ? root.field
            : placement === "record"
              ? root.record.a
              : root[placement][0];
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
    if (!isContainer(slot) || slot.kind() !== "Map")
        throw new Error(`no union map at ${placement}`);
    return slot as LoroMap;
}

export const circle = (id = "a", r = 1) => ({
    kind: "circle",
    id,
    r,
    notes: "",
});
export const slides = (id = "a") => ({
    frames: [
        { id: "f1", alt: "one" },
        { id: "f2", alt: "two" },
    ],
    notes: "",
    id,
    kind: "slides", // deliberately last: child kinds must not depend on key order
});
