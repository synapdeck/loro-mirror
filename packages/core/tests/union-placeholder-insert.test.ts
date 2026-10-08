import { describe, expect, it } from "vitest";
import { LoroDoc, LoroList, LoroMap } from "loro-crdt";
import { Mirror, schema } from "../src/index.js";
import {
    circle,
    idOf,
    itemMap,
    itemState,
    makeMirror,
    MERGEABLE,
    PLACEMENTS,
    type Placement,
    putItem,
} from "./union-fixtures.js";

const INSERT_ERROR =
    /Cannot insert an unknown union variant; it can only be kept in place, moved within a LoroMovableList, or deleted/;

/** A mirror over a doc whose item at `placement` carries an unknown tag. */
function seedPlaceholder(placement: Placement, mergeable: boolean) {
    const docA = new LoroDoc();
    makeMirror(docA, mergeable).setState((d) => {
        putItem(d, placement, circle());
    });
    itemMap(docA, placement).set("kind", "video");
    docA.commit();
    const docB = new LoroDoc();
    docB.import(docA.export({ mode: "snapshot" }));
    return { docB, mirrorB: makeMirror(docB, mergeable) };
}

function expectRejected(
    doc: LoroDoc,
    mirror: { getState(): unknown; checkStateConsistency(): void },
    update: () => void,
) {
    const version = doc.oplogVersion().toJSON();
    const before = mirror.getState();
    const json = JSON.stringify(doc.toJSON());
    expect(update).toThrow(INSERT_ERROR);
    expect(doc.oplogVersion().toJSON()).toEqual(version);
    expect(JSON.stringify(doc.toJSON())).toBe(json);
    expect(mirror.getState()).toBe(before);
    mirror.checkStateConsistency();
}

describe.each(MERGEABLE)(
    "inserting an unknown-variant placeholder (mergeable=%s)",
    (mergeable) => {
        describe.each(PLACEMENTS)("placeholder at %s", (placement) => {
            it("refuses a copy into another record key", () => {
                const { docB, mirrorB } = seedPlaceholder(placement, mergeable);
                expectRejected(docB, mirrorB, () => {
                    mirrorB.setState((d) => {
                        const record = (d.root.record ??= {}) as Record<
                            string,
                            unknown
                        >;
                        record.b = itemState(d, placement);
                    });
                });
            });

            it("refuses a copy into a list", () => {
                const { docB, mirrorB } = seedPlaceholder(placement, mergeable);
                expectRejected(docB, mirrorB, () => {
                    mirrorB.setState((d) => {
                        const list = (d.root.list ??= []) as unknown[];
                        list.push(itemState(d, placement));
                    });
                });
            });
        });

        it("refuses a by-index LoroList reorder that moves a placeholder", () => {
            const docA = new LoroDoc();
            makeMirror(docA, mergeable).setState((d) => {
                d.root.list = [circle("p"), circle("b")] as never;
            });
            (
                (docA.getMap("root").get("list") as LoroList).get(0) as LoroMap
            ).set("kind", "video");
            docA.commit();
            const docB = new LoroDoc();
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            const version = docB.oplogVersion().toJSON();
            const before = mirrorB.getState();
            expect(() =>
                mirrorB.setState((d) => {
                    d.root.list.reverse();
                }),
            ).toThrow(/unknown union variant/);
            expect(docB.oplogVersion().toJSON()).toEqual(version);
            expect(mirrorB.getState()).toBe(before);
            mirrorB.checkStateConsistency();
        });

        it("refuses a LoroList-with-idSelector reorder that re-inserts a placeholder", () => {
            const variants = {
                circle: schema.LoroMap({
                    id: schema.String(),
                    r: schema.Number(),
                }),
            };
            const makeSchema = () =>
                schema({
                    root: schema.LoroMap({
                        items: schema.LoroList(
                            schema.Union("kind", variants),
                            idOf,
                        ),
                    }),
                });
            const make = (doc: LoroDoc) =>
                new Mirror({
                    doc,
                    schema: makeSchema(),
                    inferOptions: { mergeableMapChildContainers: mergeable },
                    checkStateConsistency: true,
                });
            const docA = new LoroDoc();
            make(docA).setState((d) => {
                d.root.items = [
                    { kind: "circle", id: "p", r: 0 },
                    { kind: "circle", id: "b", r: 1 },
                    { kind: "circle", id: "c", r: 2 },
                ];
            });
            const items = docA.getMap("root").get("items") as LoroList;
            (items.get(0) as LoroMap).set("kind", "video");
            docA.commit();
            const docB = new LoroDoc();
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = make(docB);
            expect(
                (
                    mirrorB.getState().root.items[0] as {
                        $unknownVariant?: unknown;
                    }
                ).$unknownVariant,
            ).toBeDefined();
            expectRejected(docB, mirrorB, () => {
                mirrorB.setState((d) => {
                    const list = d.root.items;
                    list.push(list.shift()!);
                });
            });
        });
    },
);
