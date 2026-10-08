import { describe, expect, it } from "vitest";
import { isContainer, LoroDoc, LoroMap, LoroText } from "loro-crdt";
import { Mirror, schema } from "../src/index.js";
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

const label = (id = "a") => ({
    kind: "label",
    id,
    text: "hello",
    notes: "kept",
    tags: ["x"],
});

describe.each(MERGEABLE)("union switch (mergeable=%s)", (mergeable) => {
    describe.each(PLACEMENTS)("placement %s", (placement) => {
        const setup = () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            mirror.setState((d) =>
                putItem(d, placement, { ...circle(), notes: "orig" }),
            );
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
            const notesBefore = (
                itemMap(doc, placement).get("notes") as LoroText
            ).id;
            mirror.setState((d) => putItem(d, placement, label()));
            const notesAfter = itemMap(doc, placement).get("notes") as LoroText;
            expect(notesAfter.id).toBe(notesBefore);
            expect(notesAfter.toString()).toBe("kept");
        });

        it("recreates a child whose kind changes", () => {
            const { doc, mirror } = setup();
            mirror.setState((d) =>
                putItem(d, placement, { kind: "ring", id: "a", r: [1, 2] }),
            );
            const r = itemMap(doc, placement).get("r");
            expect(isContainer(r) && r.kind()).toBe("List");
            expect(itemMap(doc, placement).toJSON()).toEqual({
                kind: "ring",
                id: "a",
                r: [1, 2],
            });
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
            mirror.setState((d) =>
                putItem(d, placement, { ...label(), caption: undefined }),
            );
            expect(itemMap(doc, placement).toJSON()).not.toHaveProperty(
                "caption",
            );
        });

        it("rejects a user-written unknown tag", () => {
            const { mirror } = setup();
            expect(() =>
                mirror.setState((d) =>
                    putItem(d, placement, { kind: "video", id: "a" }),
                ),
            ).toThrow(/Unknown variant "video"/);
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
        makeMirror(doc, mergeable).setState((d) =>
            putItem(d, "record", circle()),
        );
        itemMap(doc, "record").set("kind", "video");
        doc.commit();
        const mirror = makeMirror(doc, mergeable);
        mirror.setState((d) => {
            delete (d.root.record as Record<string, unknown>).a;
        });
        expect(
            (doc.getMap("root").get("record") as LoroMap).get("a"),
        ).toBeUndefined();
    });

    it("moves and switches one item in a single setState", () => {
        const doc = new LoroDoc();
        const mirror = makeMirror(doc, mergeable);
        mirror.setState((d: RootState) => {
            ((d.root as unknown as { mlist: unknown[] }).mlist ??= []).push(
                circle("a"),
                circle("b"),
            );
        });
        const list = doc.getMap("root").get("mlist") as unknown as {
            get(i: number): LoroMap;
        };
        const cidA = list.get(0).id;
        mirror.setState((d: RootState) => {
            // Reuse the existing state object for "b": a fresh object in a
            // moved movable-list slot never gets its $cid (true for plain maps too).
            const items = (d.root as unknown as { mlist: unknown[] }).mlist;
            items.splice(0, 2, items[1], label("a"));
        });
        expect(list.get(1).id).toBe(cidA);
        expect(list.get(1).toJSON()).toEqual(label("a"));
        expect(list.get(0).toJSON()).toEqual(circle("b"));
    });
});

describe.each(MERGEABLE)(
    "union switch Ignore fields (mergeable=%s)",
    (mergeable) => {
        it("deletes stale doc data under a key the new variant ignores", () => {
            const sch = schema({
                root: schema.LoroMap({
                    item: schema.Union(
                        "kind",
                        {
                            a: schema.LoroMap({
                                id: schema.String(),
                                ig: schema.Ignore(),
                            }),
                            b: schema.LoroMap({
                                id: schema.String(),
                                ig: schema.String(),
                            }),
                        },
                        { required: false },
                    ),
                }),
            });
            const doc = new LoroDoc();
            const mirror = new Mirror({
                doc,
                schema: sch,
                inferOptions: { mergeableMapChildContainers: mergeable },
                checkStateConsistency: true,
            });
            mirror.setState((d) => {
                (d.root as unknown as { item: unknown }).item = {
                    kind: "b",
                    id: "x",
                    ig: "docval",
                };
            });
            const map = () => doc.getMap("root").get("item") as LoroMap;
            const cid = map().id;
            expect(map().get("ig")).toBe("docval");
            mirror.setState((d) => {
                (d.root as unknown as { item: unknown }).item = {
                    kind: "a",
                    id: "x",
                    ig: "memval",
                };
            });
            expect(map().id).toBe(cid);
            expect(map().get("ig")).toBeUndefined();
            expect(map().toJSON()).toEqual({ kind: "a", id: "x" });
            expect(
                (mirror.getState().root as unknown as { item: { ig: string } })
                    .item.ig,
            ).toBe("memval");
            expect(() => mirror.checkStateConsistency()).not.toThrow();
        });
    },
);
