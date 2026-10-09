import { describe, expect, it } from "vitest";
import { isContainer, LoroDoc, LoroMap } from "loro-crdt";
import { Mirror, schema } from "../src/index.js";
import { MERGEABLE } from "./union-fixtures.js";

type Registry = Map<string, object>;
const registryOf = (mirror: unknown) =>
    (mirror as { containerRegistry: Registry }).containerRegistry;

describe("container registration on insert", () => {
    it("does not re-register a plain map child that mergeable re-adding revives", () => {
        const doc = new LoroDoc();
        const mirror = new Mirror({
            doc,
            schema: schema({
                root: schema.LoroMap({
                    rec: schema.LoroMapRecord(
                        schema.LoroMap({ x: schema.Number() }),
                    ),
                }),
            }),
            inferOptions: { mergeableMapChildContainers: true },
            checkStateConsistency: true,
        });
        mirror.setState((d) => {
            d.root.rec = { a: { x: 1 } } as never;
        });
        const cid = (doc.getMap("root").get("rec") as LoroMap).get(
            "a",
        ) as LoroMap;
        const entry = registryOf(mirror).get(cid.id);
        expect(entry).toBeDefined();
        mirror.setState((d) => {
            delete (d.root.rec as Record<string, unknown>).a;
        });
        mirror.setState((d) => {
            (d.root.rec as Record<string, unknown>).a = { x: 2 };
        });
        const revived = (doc.getMap("root").get("rec") as LoroMap).get(
            "a",
        ) as LoroMap;
        expect(revived.id).toBe(cid.id);
        // Only union registrations are forced; a plain entry is left as is.
        expect(registryOf(mirror).get(cid.id)).toBe(entry);
    });
});

describe.each(MERGEABLE)(
    "union child registration across switches (mergeable=%s)",
    (mergeable) => {
        it("registers a re-created child under the new variant's schema", () => {
            const doc = new LoroDoc();
            const mirror = new Mirror({
                doc,
                schema: schema({
                    root: schema.LoroMap({
                        item: schema.Union(
                            "kind",
                            {
                                a: schema.LoroMap({
                                    meta: schema.LoroMap({
                                        x: schema.Number(),
                                    }),
                                }),
                                c: schema.LoroMap({}),
                                b: schema.LoroMap({
                                    meta: schema.LoroMap({
                                        y: schema.LoroText(),
                                    }),
                                }),
                            },
                            { required: false },
                        ),
                    }),
                }),
                inferOptions: { mergeableMapChildContainers: mergeable },
                checkStateConsistency: true,
            });
            mirror.setState((d) => {
                d.root.item = { kind: "a", meta: { x: 1 } } as never;
            });
            mirror.setState((d) => {
                d.root.item = { kind: "c" } as never;
            });
            mirror.setState((d) => {
                d.root.item = { kind: "b", meta: { y: "hi" } } as never;
            });
            const meta = (doc.getMap("root").get("item") as LoroMap).get(
                "meta",
            ) as LoroMap;
            const y = meta.get("y");
            expect(isContainer(y) && y.kind()).toBe("Text");
            expect(mirror.getState().root.item).toEqual({
                kind: "b",
                meta: { y: "hi" },
            });
        });

        it("registers a re-created grandchild under the new variant's schema", () => {
            const doc = new LoroDoc();
            const mirror = new Mirror({
                doc,
                schema: schema({
                    root: schema.LoroMap({
                        item: schema.Union(
                            "kind",
                            {
                                a: schema.LoroMap({
                                    meta: schema.LoroMap({
                                        inner: schema.LoroMap(
                                            { x: schema.Number() },
                                            { required: false },
                                        ),
                                    }),
                                }),
                                c: schema.LoroMap({}),
                                b: schema.LoroMap({
                                    meta: schema.LoroMap({
                                        inner: schema.LoroMap({
                                            y: schema.LoroText(),
                                        }),
                                    }),
                                }),
                            },
                            { required: false },
                        ),
                    }),
                }),
                inferOptions: { mergeableMapChildContainers: mergeable },
                checkStateConsistency: true,
            });
            mirror.setState((d) => {
                d.root.item = { kind: "a", meta: { inner: { x: 1 } } } as never;
            });
            // Delete `inner` outright so a later re-ensure does not revive it.
            mirror.setState((d) => {
                d.root.item = { kind: "a", meta: {} } as never;
            });
            mirror.setState((d) => {
                d.root.item = { kind: "c" } as never;
            });
            mirror.setState((d) => {
                d.root.item = {
                    kind: "b",
                    meta: { inner: { y: "hi" } },
                } as never;
            });
            const meta = (doc.getMap("root").get("item") as LoroMap).get(
                "meta",
            ) as LoroMap;
            const y = (meta.get("inner") as LoroMap).get("y");
            expect(isContainer(y) && y.kind()).toBe("Text");
        });
    },
);
