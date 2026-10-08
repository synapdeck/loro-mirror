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

const label = () => ({
    kind: "label",
    id: "a",
    text: "t",
    notes: "n",
    tags: [],
});
const ring = () => ({ kind: "ring", id: "a", r: [1] });

describe.each(MERGEABLE)("union concurrency (mergeable=%s)", (mergeable) => {
    describe.each(PLACEMENTS)("placement %s", (placement) => {
        const pair = async () => {
            const docA = new LoroDoc();
            docA.setPeerId(1);
            const mirrorA = makeMirror(docA, mergeable);
            mirrorA.setState((d) => {
                putItem(d, placement, { ...circle(), notes: "base" });
            });
            const docB = new LoroDoc();
            docB.setPeerId(2);
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            await waitForSync();
            return { docA, mirrorA, docB, mirrorB };
        };

        it("concurrent switches converge on the winning tag and show only its keys", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => {
                putItem(d, placement, label());
            });
            mirrorB.setState((d) => {
                putItem(d, placement, ring());
            });
            syncDocs(docA, docB);
            await waitForSync();
            const a = itemState(mirrorA.getState(), placement);
            expect(a).toEqual(itemState(mirrorB.getState(), placement));
            expect([label(), ring()]).toContainEqual(a);
            mirrorA.checkStateConsistency();
            mirrorB.checkStateConsistency();

            // The next local switch clears the losing variant's strays from the doc.
            mirrorA.setState((d) => {
                putItem(d, placement, circle());
            });
            expect(itemMap(docA, placement).toJSON()).toEqual(circle());
        });

        it("a switch beats a concurrent edit to a key it deleted", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => {
                putItem(d, placement, ring());
            });
            mirrorB.setState((d) => {
                (itemState(d, placement) as { r: number }).r = 9;
            });
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorA.getState(), placement)).toEqual(
                itemState(mirrorB.getState(), placement),
            );
            mirrorA.checkStateConsistency();
            mirrorB.checkStateConsistency();
        });

        it("a same-name, same-kind key keeps concurrent edits across a switch", async () => {
            const { docA, mirrorA, docB } = await pair();
            mirrorA.setState((d) => {
                putItem(d, placement, { ...slides(), notes: "base" });
            });
            (itemMap(docB, placement).get("notes") as LoroText).insert(4, "!");
            docB.commit();
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemMap(docA, placement).get("kind")).toBe("slides");
            expect(
                (itemMap(docA, placement).get("notes") as LoroText).toString(),
            ).toBe("base!");
        });

        it("switching back after a concurrent switch revives no stale contents", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => {
                putItem(d, placement, slides());
            });
            mirrorB.setState((d) => {
                putItem(d, placement, label());
            });
            syncDocs(docA, docB);
            await waitForSync();
            mirrorA.setState((d) => {
                putItem(d, placement, { ...slides(), frames: [] });
            });
            expect(itemMap(docA, placement).toJSON()).toEqual({
                ...slides(),
                frames: [],
            });
            mirrorA.checkStateConsistency();
        });
    });
});
