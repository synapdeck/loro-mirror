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

function seed(
    placement: (typeof PLACEMENTS)[number],
    mergeable: boolean,
    mutate: (m: LoroMap) => void,
) {
    const docA = new LoroDoc();
    makeMirror(docA, mergeable).setState((d) =>
        putItem(d, placement, circle()),
    );
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
                    data: {
                        kind: "video",
                        id: "a",
                        r: 1,
                        notes: "",
                        codec: "h264",
                    },
                },
            });
            expect(Object.isFrozen(item.$unknownVariant)).toBe(true);
            mirrorB.checkStateConsistency();
        });

        it("reads a missing tag as a placeholder with tag null", () => {
            const { mirrorB } = seed(placement, mergeable, (m) =>
                m.delete("kind"),
            );
            const item = itemState(mirrorB.getState(), placement)!;
            expect((item.$unknownVariant as { tag: unknown }).tag).toBeNull();
        });

        it("keeps unrelated setState working while a placeholder is present", () => {
            const { mirrorB } = seed(placement, mergeable, (m) =>
                m.set("kind", "video"),
            );
            expect(() =>
                mirrorB.setState((d) => {
                    ((d.root.record ??= {}) as Record<string, unknown>).b =
                        circle("b");
                }),
            ).not.toThrow();
        });

        it("hides keys the variant does not declare", () => {
            const { docB, mirrorB } = seed(placement, mergeable, (m) =>
                m.set("codec", "h264"),
            );
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
