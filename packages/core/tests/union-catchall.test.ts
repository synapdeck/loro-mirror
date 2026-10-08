import { describe, expect, it } from "vitest";
import { isContainer, LoroDoc } from "loro-crdt";
import { Mirror, schema } from "../src/index.js";
import {
    idOf,
    itemMap,
    itemState,
    MERGEABLE,
    PLACEMENTS,
    type Placement,
    putItem,
    waitForSync,
} from "./union-fixtures.js";

/** `note` stores every undeclared key as LoroText, so a string tag fits its catchall. */
const variants = () => ({
    circle: schema.LoroMap({ id: schema.String(), r: schema.Number() }),
    note: schema.LoroMap({ id: schema.String() }).catchall(schema.LoroText()),
    /** A transformed catchall must neither encode nor decode the tag. */
    scaled: schema.LoroMap({ id: schema.String() }).catchall(
        schema.Number().transform({
            decode: (n: number) => n / 100,
            encode: (n: number) => n * 100,
        }),
    ),
});

const makeSchema = () =>
    schema({
        root: schema.LoroMap({
            field: schema.Union("kind", variants(), { required: false }),
            record: schema.LoroMapRecord(schema.Union("kind", variants())),
            list: schema.LoroList(schema.Union("kind", variants())),
            mlist: schema.LoroMovableList(
                schema.Union("kind", variants()),
                idOf,
            ),
        }),
    });

const make = (doc: LoroDoc, mergeable: boolean) =>
    new Mirror({
        doc,
        schema: makeSchema(),
        inferOptions: { mergeableMapChildContainers: mergeable },
        checkStateConsistency: true,
    });

const note = { kind: "note", id: "a", body: "hello" };

function expectStringTag(doc: LoroDoc, placement: Placement) {
    const map = itemMap(doc, placement);
    expect(map.get("kind")).toBe("note");
    const body = map.get("body");
    expect(isContainer(body) && body.kind()).toBe("Text");
}

/** A fresh mirror over a snapshot, and a live mirror fed by an update import. */
async function expectPeersRead(
    docA: LoroDoc,
    placement: Placement,
    mergeable: boolean,
    expected: Record<string, unknown>,
) {
    const docB = new LoroDoc();
    docB.import(docA.export({ mode: "snapshot" }));
    const reloaded = make(docB, mergeable);
    expect(itemState(reloaded.getState(), placement)).toEqual(expected);
    reloaded.checkStateConsistency();

    const docC = new LoroDoc();
    const live = make(docC, mergeable);
    docC.import(docA.export({ mode: "update" }));
    await waitForSync();
    expect(itemState(live.getState(), placement)).toEqual(expected);
    live.checkStateConsistency();
}

describe.each(MERGEABLE)("union catchall variant (mergeable=%s)", (mergeable) => {
    describe.each(PLACEMENTS)("placement %s", (placement) => {
        it("creates it with a string tag that peers and reloads read back", async () => {
            const docA = new LoroDoc();
            const mirrorA = make(docA, mergeable);
            mirrorA.setState((d) => {
                putItem(d, placement, { ...note });
            });
            expectStringTag(docA, placement);
            expect(itemState(mirrorA.getState(), placement)).toEqual(note);
            await expectPeersRead(docA, placement, mergeable, note);
        });

        it("switches into it with a string tag", async () => {
            const docA = new LoroDoc();
            const mirrorA = make(docA, mergeable);
            mirrorA.setState((d) => {
                putItem(d, placement, { kind: "circle", id: "a", r: 1 });
            });
            mirrorA.setState((d) => {
                putItem(d, placement, { ...note });
            });
            expectStringTag(docA, placement);
            await expectPeersRead(docA, placement, mergeable, note);
        });

        it("neither encodes nor decodes the tag through a transformed catchall", async () => {
            const scaled = { kind: "scaled", id: "a", w: 1.5 };
            const docA = new LoroDoc();
            const mirrorA = make(docA, mergeable);
            mirrorA.setState((d) => {
                putItem(d, placement, { ...scaled });
            });
            const map = itemMap(docA, placement);
            expect(map.get("kind")).toBe("scaled");
            expect(map.get("w")).toBe(150);
            expect(itemState(mirrorA.getState(), placement)).toEqual(scaled);
            await expectPeersRead(docA, placement, mergeable, scaled);
        });

        it("keeps the tag a string across same-variant catchall edits", async () => {
            const docA = new LoroDoc();
            const mirrorA = make(docA, mergeable);
            mirrorA.setState((d) => {
                putItem(d, placement, { ...note });
            });
            mirrorA.setState((d) => {
                (itemState(d, placement) as Record<string, unknown>).more =
                    "more";
            });
            expectStringTag(docA, placement);
            await expectPeersRead(docA, placement, mergeable, {
                ...note,
                more: "more",
            });
        });
    });
});
