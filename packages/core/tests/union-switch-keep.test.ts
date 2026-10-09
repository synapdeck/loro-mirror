import { describe, expect, it } from "vitest";
import {
    EphemeralStore,
    LoroDoc,
    LoroList,
    LoroMap,
    LoroMovableList,
} from "loro-crdt";
import { Mirror, schema } from "../src/index.js";
import { diffContainer } from "../src/core/diff.js";
import { idOf, MERGEABLE, syncDocs, waitForSync } from "./union-fixtures.js";

const inner = () =>
    schema.Union("t", {
        k: schema.LoroMap({ id: schema.String(), v: schema.Number() }),
    });

const makeSchema = () =>
    schema({
        root: schema.LoroMap({
            field: schema.Union(
                "kind",
                {
                    g: schema.LoroMap({
                        kids: schema.LoroMovableList(inner(), idOf),
                    }),
                    h: schema.LoroMap({
                        kids: schema.LoroMovableList(inner(), idOf),
                        label: schema.String({ required: false }),
                    }),
                    // Same key as g's kids, different container kind.
                    m: schema.LoroMap({
                        kids: schema.LoroList(schema.Number()),
                    }),
                },
                { required: false },
            ),
            items: schema.LoroMovableList(inner(), idOf),
        }),
    });

type Item = Record<string, unknown> & { v?: number; $cid?: string };
type Field = Record<string, unknown> & { kids: Item[] };
type Root = { field?: Field; items?: Item[] };
type Draft = { root: unknown };
const rootOf = (d: Draft) => d.root as Root;

const q = (id: string, v: number) => ({ t: "k", id, v });

function makeMirror(doc: LoroDoc, mergeable: boolean, ephemeral = false) {
    return new Mirror({
        doc,
        schema: makeSchema(),
        inferOptions: { mergeableMapChildContainers: mergeable },
        checkStateConsistency: true,
        ...(ephemeral ? { ephemeralStore: new EphemeralStore() } : {}),
    });
}

const fieldMap = (doc: LoroDoc) => doc.getMap("root").get("field") as LoroMap;
const kidsOf = (doc: LoroDoc) => fieldMap(doc).get("kids") as LoroMovableList;
const kidIds = (doc: LoroDoc) =>
    kidsOf(doc)
        .toArray()
        .map((c) => (c as LoroMap).id);
const fieldState = (m: { getState(): unknown }) =>
    rootOf(m.getState() as Draft).field!;

function seedG(doc: LoroDoc, mirror: ReturnType<typeof makeMirror>) {
    mirror.setState((d) => {
        rootOf(d).field = { kind: "g", kids: [q("q1", 1), q("q2", 2)] };
    });
    void doc;
}

describe.each(MERGEABLE)(
    "union switch keeps same-kind children (mergeable=%s)",
    (mergeable) => {
        it("keeps a kept list's item containers and their $cid", () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            seedG(doc, mirror);
            const before = kidIds(doc);
            const cidsBefore = fieldState(mirror).kids.map((k) => k.$cid);
            expect(cidsBefore).toEqual(before);

            mirror.setState((d) => {
                const root = rootOf(d);
                root.field = { kind: "h", kids: root.field!.kids, label: "x" };
            });

            expect(kidIds(doc)).toEqual(before);
            const field = fieldState(mirror);
            expect(field.kids.map((k) => k.$cid)).toEqual(before);
            expect(field).toEqual({
                kind: "h",
                label: "x",
                kids: [q("q1", 1), q("q2", 2)],
            });
            expect(fieldMap(doc).toJSON()).toEqual(field);
            mirror.checkStateConsistency();
        });

        it("emits union-switch with keep before the kept child's nested changes", () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            seedG(doc, mirror);
            const old = mirror.getState() as unknown as { root: Root };
            const oldKids = old.root.field!.kids;
            const next = {
                ...old,
                root: {
                    ...old.root,
                    field: {
                        kind: "h",
                        label: "x",
                        kids: [{ ...oldKids[0], v: 5 }],
                    },
                },
            };
            const changes = diffContainer(doc, old, next, "", makeSchema());
            expect(changes[0]).toMatchObject({
                container: fieldMap(doc).id,
                kind: "union-switch",
                keep: ["kids"],
            });
            const rest = changes.slice(1);
            expect(rest.length).toBeGreaterThan(0);
            expect(rest.every((c) => c.container !== fieldMap(doc).id)).toBe(
                true,
            );
            expect(rest.some((c) => c.container === kidsOf(doc).id)).toBe(true);
        });

        it("keeps a peer's concurrent edit inside a kept list item (sequence 2)", async () => {
            const docA = new LoroDoc();
            docA.setPeerId(1);
            const mirrorA = makeMirror(docA, mergeable);
            seedG(docA, mirrorA);
            const docB = new LoroDoc();
            docB.setPeerId(2);
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            await waitForSync();

            mirrorA.setState((d) => {
                const root = rootOf(d);
                root.field = { kind: "h", kids: root.field!.kids, label: "x" };
            });
            mirrorB.setState((d) => {
                rootOf(d).field!.kids[0].v = 99;
            });
            syncDocs(docA, docB);
            await waitForSync();

            const expected = {
                kind: "h",
                label: "x",
                kids: [q("q1", 99), q("q2", 2)],
            };
            for (const [doc, mirror] of [
                [docA, mirrorA],
                [docB, mirrorB],
            ] as const) {
                expect(fieldMap(doc).toJSON()).toEqual(expected);
                expect(fieldState(mirror)).toEqual(expected);
                mirror.checkStateConsistency();
            }
        });

        it("keeps kept-child edits when the switching mirror has an ephemeral store", async () => {
            const docA = new LoroDoc();
            docA.setPeerId(1);
            const mirrorA = makeMirror(docA, mergeable, true);
            seedG(docA, mirrorA);
            mirrorA.finalizeEphemeralPatches();
            const docB = new LoroDoc();
            docB.setPeerId(2);
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            await waitForSync();
            const before = kidIds(docA);

            // The kept item's primitive edit is ephemeral-eligible; the switch is not.
            mirrorA.setState((d) => {
                const root = rootOf(d);
                const kids = root.field!.kids;
                kids[1].v = 7;
                root.field = { kind: "h", kids, label: "x" };
            });
            expect(fieldState(mirrorA).kids[1].v).toBe(7);
            mirrorA.finalizeEphemeralPatches();
            expect(kidIds(docA)).toEqual(before);
            expect(fieldState(mirrorA).kids.map((k) => k.$cid)).toEqual(before);
            expect((kidsOf(docA).get(1) as LoroMap).get("v")).toBe(7);

            mirrorB.setState((d) => {
                rootOf(d).field!.kids[0].v = 99;
            });
            syncDocs(docA, docB);
            await waitForSync();

            const expected = {
                kind: "h",
                label: "x",
                kids: [q("q1", 99), q("q2", 7)],
            };
            expect(fieldMap(docA).toJSON()).toEqual(expected);
            expect(fieldState(mirrorA)).toEqual(expected);
            expect(fieldMap(docB).toJSON()).toEqual(expected);
            expect(fieldState(mirrorB)).toEqual(expected);
            mirrorA.checkStateConsistency();
            mirrorB.checkStateConsistency();
        });

        it("keeps a placeholder inside a kept list in place (sequence 1)", async () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            mirror.setState((d) => {
                rootOf(d).field = { kind: "g", kids: [q("q1", 1)] };
            });
            const p = kidsOf(doc).pushContainer(new LoroMap());
            p.set("t", "video");
            p.set("id", "p1");
            p.set("codec", "h264");
            doc.commit();
            await waitForSync();
            expect(fieldState(mirror).kids[1].$unknownVariant).toBeDefined();

            mirror.setState((d) => {
                const root = rootOf(d);
                root.field = { kind: "h", kids: root.field!.kids };
            });

            expect(fieldMap(doc).get("kind")).toBe("h");
            expect((kidsOf(doc).get(1) as LoroMap).toJSON()).toEqual({
                t: "video",
                id: "p1",
                codec: "h264",
            });
            const kids = fieldState(mirror).kids;
            expect(kids[0]).toEqual(q("q1", 1));
            expect(kids[1].$unknownVariant).toBeDefined();
            mirror.checkStateConsistency();
        });

        it("applies only the edits when a kept list is edited in the same setState", () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            seedG(doc, mirror);
            const [q1Id] = kidIds(doc);

            mirror.setState((d) => {
                const root = rootOf(d);
                const kids = root.field!.kids;
                kids[0].v = 5;
                kids.splice(1, 1);
                root.field = { kind: "h", kids, label: "x" };
            });

            expect(kidIds(doc)).toEqual([q1Id]);
            expect((kidsOf(doc).get(0) as LoroMap).get("v")).toBe(5);
            const expected = { kind: "h", label: "x", kids: [q("q1", 5)] };
            expect(fieldMap(doc).toJSON()).toEqual(expected);
            expect(fieldState(mirror)).toEqual(expected);
            expect(fieldState(mirror).kids[0].$cid).toBe(q1Id);
            mirror.checkStateConsistency();
        });

        it("refuses a placeholder copied into a key the switch recreates", async () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            mirror.setState((d) => {
                const root = rootOf(d);
                root.field = { kind: "m", kids: [1, 2] as never };
                root.items = [];
            });
            const items = doc.getMap("root").get("items") as LoroMovableList;
            const p = items.pushContainer(new LoroMap());
            p.set("t", "video");
            p.set("id", "p1");
            doc.commit();
            await waitForSync();
            expect(
                rootOf(mirror.getState() as Draft).items![0].$unknownVariant,
            ).toBeDefined();

            const json = JSON.stringify(doc.toJSON());
            const state = mirror.getState();
            expect(() => {
                mirror.setState((d) => {
                    const root = rootOf(d);
                    root.field = { kind: "h", kids: [root.items![0]] };
                });
            }).toThrow(/Cannot insert an unknown union variant/);
            expect(JSON.stringify(doc.toJSON())).toBe(json);
            expect(mirror.getState()).toBe(state);
            mirror.checkStateConsistency();
        });

        it("recreates a child whose container kind differs between variants", () => {
            const doc = new LoroDoc();
            const mirror = makeMirror(doc, mergeable);
            mirror.setState((d) => {
                rootOf(d).field = { kind: "g", kids: [q("q1", 1)] };
            });

            mirror.setState((d) => {
                rootOf(d).field = { kind: "m", kids: [1, 2] as never };
            });

            const kids = fieldMap(doc).get("kids");
            expect(kids).toBeInstanceOf(LoroList);
            expect((kids as LoroList).toJSON()).toEqual([1, 2]);
            expect(fieldState(mirror)).toEqual({ kind: "m", kids: [1, 2] });
            mirror.checkStateConsistency();
        });
    },
);
