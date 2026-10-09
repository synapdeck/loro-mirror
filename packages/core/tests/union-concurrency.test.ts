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
        const pair = async (peerA = 1, peerB = 2) => {
            const docA = new LoroDoc();
            docA.setPeerId(peerA);
            const mirrorA = makeMirror(docA, mergeable);
            mirrorA.setState((d) => {
                putItem(d, placement, { ...circle(), notes: "base" });
            });
            const docB = new LoroDoc();
            docB.setPeerId(peerB);
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            await waitForSync();
            return { docA, mirrorA, docB, mirrorB };
        };

        // Equal lamports: the higher peer id wins the tag. A (circle→label)
        // keeps `notes` in place; B (circle→ring) deletes it.
        it.each([
            { peerA: 1, peerB: 2, winner: "ring" },
            { peerA: 2, peerB: 1, winner: "label" },
        ])(
            "concurrent switches converge on the winning tag and show only its keys (peers $peerA, $peerB)",
            async ({ peerA, peerB, winner }) => {
                const { docA, mirrorA, docB, mirrorB } = await pair(
                    peerA,
                    peerB,
                );
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
                expect(itemMap(docA, placement).toJSON()).toEqual(
                    itemMap(docB, placement).toJSON(),
                );
                expect(itemMap(docA, placement).get("kind")).toBe(winner);
                if (winner === "ring") {
                    expect(a).toEqual(ring());
                } else {
                    // Documented behavior, not a bug: B's switch deleted `notes`,
                    // and A's switch kept it in place without rewriting the key,
                    // so the delete stands. The winning label lacks its required
                    // `notes` in both the doc and state.
                    const { notes: _notes, ...labelWithoutNotes } = label();
                    expect(a).toEqual(labelWithoutNotes);
                    expect(
                        itemMap(docA, placement).get("notes"),
                    ).toBeUndefined();
                }
                mirrorA.checkStateConsistency();
                mirrorB.checkStateConsistency();

                // The next local switch clears the losing variant's strays from the doc.
                mirrorA.setState((d) => {
                    putItem(d, placement, circle());
                });
                expect(itemMap(docA, placement).toJSON()).toEqual(circle());
            },
        );

        it("a switch beats a concurrent edit to a key it deleted", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            // circle has `notes` (LoroText, "base"); ring does not, so the switch deletes it.
            mirrorA.setState((d) => {
                putItem(d, placement, ring());
            });
            (itemMap(docB, placement).get("notes") as LoroText).insert(4, "!");
            docB.commit();
            syncDocs(docA, docB);
            await waitForSync();
            for (const doc of [docA, docB]) {
                expect(itemMap(doc, placement).get("notes")).toBeUndefined();
                expect(itemMap(doc, placement).toJSON()).toEqual(ring());
            }
            expect(itemState(mirrorA.getState(), placement)).toEqual(ring());
            expect(itemState(mirrorB.getState(), placement)).toEqual(ring());
            mirrorA.checkStateConsistency();
            mirrorB.checkStateConsistency();
        });

        it("a concurrent overwrite of a re-kinded key converges", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => {
                putItem(d, placement, ring());
            });
            mirrorB.setState((d) => {
                (itemState(d, placement) as { r: number }).r = 9;
            });
            syncDocs(docA, docB);
            await waitForSync();
            // Which side wins `r` depends on op order, so only convergence is pinned.
            expect(itemState(mirrorA.getState(), placement)).toEqual(
                itemState(mirrorB.getState(), placement),
            );
            expect(itemMap(docA, placement).toJSON()).toEqual(
                itemMap(docB, placement).toJSON(),
            );
            mirrorA.checkStateConsistency();
            mirrorB.checkStateConsistency();
        });

        it("a same-name, same-kind key keeps concurrent edits across a switch", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => {
                putItem(d, placement, { ...slides(), notes: "base" });
            });
            (itemMap(docB, placement).get("notes") as LoroText).insert(4, "!");
            docB.commit();
            syncDocs(docA, docB);
            await waitForSync();
            for (const doc of [docA, docB]) {
                expect(itemMap(doc, placement).get("kind")).toBe("slides");
                expect(
                    (
                        itemMap(doc, placement).get("notes") as LoroText
                    ).toString(),
                ).toBe("base!");
            }
            expect(itemState(mirrorA.getState(), placement)).toEqual(
                itemState(mirrorB.getState(), placement),
            );
            mirrorA.checkStateConsistency();
            mirrorB.checkStateConsistency();
        });

        it("switching back to the losing variant revives no stale contents", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            mirrorA.setState((d) => {
                putItem(d, placement, slides());
            });
            mirrorB.setState((d) => {
                putItem(d, placement, label());
            });
            syncDocs(docA, docB);
            await waitForSync();
            const winner = itemMap(docA, placement).get("kind");
            expect(["slides", "label"]).toContain(winner);
            expect(itemMap(docB, placement).get("kind")).toBe(winner);
            // Switch to the loser, whose keys are still hidden in the doc.
            const next =
                winner === "slides" ? label() : { ...slides(), frames: [] };
            mirrorA.setState((d) => {
                putItem(d, placement, next);
            });
            expect(itemMap(docA, placement).toJSON()).toEqual(next);
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemMap(docB, placement).toJSON()).toEqual(next);
            expect(itemState(mirrorB.getState(), placement)).toEqual(next);
            mirrorA.checkStateConsistency();
            mirrorB.checkStateConsistency();
        });
    });
});
