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
        new Mirror({
            doc,
            schema: makeSchema(),
            inferOptions: { mergeableMapChildContainers: mergeable },
            checkStateConsistency: true,
        });

    it("drops doc writes into an Ignore field inside a variant and keeps the memory value", async () => {
        const docA = new LoroDoc();
        const mirrorA = make(docA);
        mirrorA.setState((d) => {
            (d.root.items ??= {}).a = {
                kind: "note",
                body: "x",
                cache: { hits: 1 },
            } as never;
        });
        const docB = new LoroDoc();
        docB.import(docA.export({ mode: "snapshot" }));
        const mirrorB = make(docB);
        mirrorB.setState((d) => {
            (d.root.items.a as { cache: unknown }).cache = { hits: 7 };
        });
        const item = (docA.getMap("root").get("items") as LoroMap).get(
            "a",
        ) as LoroMap;
        const cache = item.setContainer("cache", new LoroList());
        cache.push(1);
        (item.get("body") as LoroText).insert(1, "y");
        docA.commit();
        syncDocs(docA, docB);
        await waitForSync();
        const stateItem = mirrorB.getState().root.items.a as {
            body: string;
            cache: unknown;
        };
        expect(stateItem.body).toBe("xy");
        expect(stateItem.cache).toEqual({ hits: 7 });
    });

    it("applies a single remote text event inside a variant without touching siblings", async () => {
        const docA = new LoroDoc();
        const mirrorA = make(docA);
        mirrorA.setState((d) => {
            (d.root.items ??= {}).a = { kind: "note", body: "x" } as never;
            (d.root.sibling ??= { x: 0 }).x = 1;
        });
        const docB = new LoroDoc();
        docB.import(docA.export({ mode: "snapshot" }));
        const mirrorB = make(docB);
        const siblingBefore = mirrorB.getState().root.sibling;
        (
            (
                (docA.getMap("root").get("items") as LoroMap).get(
                    "a",
                ) as LoroMap
            ).get("body") as LoroText
        ).insert(1, "!");
        docA.commit();
        syncDocs(docA, docB);
        await waitForSync();
        expect((mirrorB.getState().root.items.a as { body: string }).body).toBe(
            "x!",
        );
        expect(mirrorB.getState().root.sibling).toBe(siblingBefore);
    });
});
