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
            expect(
                isContainer(first.get("alt")) &&
                    (first.get("alt") as LoroMap).kind(),
            ).toBe("Text");
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
                const frames = (
                    itemState(d, placement) as { frames: unknown[] }
                ).frames;
                frames.reverse();
            });
            mirrorB.setState((d) => {
                const frames = (
                    itemState(d, placement) as {
                        frames: { id: string; alt: string }[];
                    }
                ).frames;
                frames[0]!.alt = "edited";
            });
            syncDocs(docA, docB);
            await waitForSync();

            for (const doc of [docA, docB]) {
                const frames = itemMap(doc, placement).toJSON().frames as {
                    id: string;
                    alt: string;
                }[];
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
        expect(itemMap(doc, "record").toJSON()).toEqual({
            kind: "ring",
            id: "a",
            r: [1, 2],
        });
    });
});
