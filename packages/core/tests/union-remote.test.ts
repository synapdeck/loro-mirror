import { afterEach, describe, expect, it, vi } from "vitest";
import {
    ContainerID,
    EphemeralStore,
    isContainer,
    LoroDoc,
    LoroList,
    LoroMap,
    LoroText,
} from "loro-crdt";
import { Mirror, schema } from "../src/index.js";
import {
    circle,
    itemMap,
    itemState,
    makeMirror,
    makeRoot,
    MERGEABLE,
    PLACEMENTS,
    putItem,
    slides,
    syncDocs,
    waitForSync,
} from "./union-fixtures.js";

/** Reads the private registry: the public API exposes ids, not schemas. */
const registeredSchemaOf = (mirror: Mirror<never>, id: ContainerID) =>
    (
        mirror as unknown as {
            containerRegistry: Map<ContainerID, { schema?: unknown }>;
        }
    ).containerRegistry.get(id)?.schema;

describe.each(MERGEABLE)("remote union changes (mergeable=%s)", (mergeable) => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe.each(PLACEMENTS)("placement %s", (placement) => {
        const pair = async () => {
            const docA = new LoroDoc();
            const mirrorA = makeMirror(docA, mergeable);
            mirrorA.setState((d) => {
                putItem(d, placement, circle());
            });
            const docB = new LoroDoc();
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            await waitForSync();
            return { docA, mirrorA, docB, mirrorB };
        };

        it("re-registers and re-projects after a remote switch", async () => {
            const { docA, mirrorA, docB, mirrorB } = await pair();
            const cid = itemMap(docB, placement).id;
            mirrorA.setState((d) => {
                putItem(d, placement, slides());
            });
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorB.getState(), placement)).toEqual(
                itemState(mirrorA.getState(), placement),
            );
            expect(itemState(mirrorB.getState(), placement)!.$cid).toBe(cid);
            // B's next local edit must use the new variant's schemas: a reorder stays a move.
            mirrorB.setState((d) => {
                (
                    itemState(d, placement) as { frames: unknown[] }
                ).frames.reverse();
            });
            const frames = itemMap(docB, placement).get("frames");
            expect(isContainer(frames) && frames.kind()).toBe("MovableList");
            expect(
                (
                    itemState(mirrorB.getState(), placement) as {
                        frames: { id: string }[];
                    }
                ).frames.map((f) => f.id),
            ).toEqual(["f2", "f1"]);
            mirrorB.checkStateConsistency();
        });

        it("hides a remote stray key on a known variant", async () => {
            const { docA, docB, mirrorB } = await pair();
            itemMap(docA, placement).set("codec", "h264");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorB.getState(), placement)).toEqual(circle());
            mirrorB.checkStateConsistency();
        });

        it("turns a remote unknown tag into a placeholder and back", async () => {
            const { docA, docB, mirrorB } = await pair();
            itemMap(docA, placement).set("kind", "video");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            expect(
                itemState(mirrorB.getState(), placement)!.kind,
            ).toBeUndefined();
            expect(
                itemState(mirrorB.getState(), placement)!.$unknownVariant,
            ).toBeDefined();

            itemMap(docA, placement).set("kind", "circle");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorB.getState(), placement)).toEqual(circle());
            mirrorB.checkStateConsistency();
        });

        it("re-projects a placeholder when a container inside it changes", async () => {
            const { docA, docB, mirrorB } = await pair();
            const m = itemMap(docA, placement);
            m.set("kind", "video");
            m.setContainer("subtitle", new LoroText()).insert(0, "hi");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            (itemMap(docA, placement).get("subtitle") as LoroText).insert(
                2,
                "!",
            );
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            const info = itemState(mirrorB.getState(), placement)!
                .$unknownVariant as {
                data: Record<string, unknown>;
            };
            expect(info.data.subtitle).toBe("hi!");
            mirrorB.checkStateConsistency();
        });

        it("hides a live-imported wrong-kind slot and leaves it schemaless", async () => {
            const { docA, docB, mirrorB } = await pair();
            const warn = vi.spyOn(console, "warn");
            const list = itemMap(docA, placement).setContainer(
                "r",
                new LoroList(),
            );
            list.push(3);
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();

            const r = itemMap(docB, placement).get("r");
            expect(isContainer(r) && r.kind()).toBe("List");
            const rid = (r as LoroList).id;
            // The list replaced the number, so `r` simply disappears.
            const { r: _r, ...hiddenR } = circle();
            expect(itemState(mirrorB.getState(), placement)).toEqual(hiddenR);
            expect("r" in itemState(mirrorB.getState(), placement)!).toBe(
                false,
            );
            mirrorB.checkStateConsistency();

            // A later edit inside the hidden child must stay hidden too.
            list.push(4);
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            expect(itemState(mirrorB.getState(), placement)).toEqual(hiddenR);
            mirrorB.checkStateConsistency();

            expect(
                warn.mock.calls.some((args) =>
                    String(args[0]).includes("Container schema not found"),
                ),
            ).toBe(false);
            // The event path registers the child (visible via the public id
            // list) but without circle's Number schema or any other.
            expect(mirrorB.getContainerIds()).toContain(rid);
            expect(
                registeredSchemaOf(mirrorB as Mirror<never>, rid),
            ).toBeUndefined();
        });
    });

    describe.each(PLACEMENTS)("placement %s", (placement) => {
        it("keeps unchanged children's identity on a remote scalar edit", async () => {
            const docA = new LoroDoc();
            const mirrorA = makeMirror(docA, mergeable);
            mirrorA.setState((d) => {
                putItem(d, placement, slides());
            });
            const docB = new LoroDoc();
            docB.import(docA.export({ mode: "snapshot" }));
            const mirrorB = makeMirror(docB, mergeable);
            await waitForSync();
            const framesBefore = itemState(
                mirrorB.getState(),
                placement,
            )!.frames;
            expect(framesBefore).toHaveLength(2);

            itemMap(docA, placement).set("id", "b");
            docA.commit();
            syncDocs(docA, docB);
            await waitForSync();
            const after = itemState(mirrorB.getState(), placement)!;
            expect(after.id).toBe("b");
            expect(after.frames).toBe(framesBefore);
            mirrorB.checkStateConsistency();
        });
    });

    it("does not carry an old real field into a new variant's Ignore slot", async () => {
        const makeIgnoreRoot = () =>
            schema({
                root: schema.LoroMap({
                    field: schema.Union(
                        "kind",
                        {
                            a: schema.LoroMap({
                                id: schema.String(),
                                k: schema.Number(),
                            }),
                            b: schema.LoroMap({
                                id: schema.String(),
                                k: schema.Ignore(),
                            }),
                        },
                        { required: false },
                    ),
                }),
            });
        const make = (doc: LoroDoc) =>
            new Mirror({
                doc,
                schema: makeIgnoreRoot(),
                inferOptions: { mergeableMapChildContainers: mergeable },
                checkStateConsistency: true,
            });
        const docA = new LoroDoc();
        const mirrorA = make(docA);
        mirrorA.setState((d) => {
            (d.root as Record<string, unknown>).field = {
                kind: "a",
                id: "x",
                k: 5,
            };
        });
        const docB = new LoroDoc();
        docB.import(docA.export({ mode: "snapshot" }));
        const mirrorB = make(docB);
        await waitForSync();
        expect(
            (mirrorB.getState().root as Record<string, unknown>).field,
        ).toEqual({ kind: "a", id: "x", k: 5 });

        // A raw tag write leaves `k: 5` in the doc; under `b` it is an Ignore key.
        (docA.getMap("root").get("field") as LoroMap).set("kind", "b");
        docA.commit();
        syncDocs(docA, docB);
        await waitForSync();
        const field = (mirrorB.getState().root as Record<string, unknown>)
            .field as Record<string, unknown>;
        expect(field.kind).toBe("b");
        expect("k" in field).toBe(false);
        mirrorB.checkStateConsistency();
    });

    it("replaces a placeholder locally through an ephemeral-store mirror", async () => {
        const docA = new LoroDoc();
        const mirrorA = makeMirror(docA, mergeable);
        mirrorA.setState((d) => {
            putItem(d, "record", circle());
        });
        const docB = new LoroDoc();
        docB.import(docA.export({ mode: "snapshot" }));
        const mirrorB = new Mirror({
            doc: docB,
            schema: makeRoot(),
            inferOptions: { mergeableMapChildContainers: mergeable },
            ephemeralStore: new EphemeralStore(),
        });
        itemMap(docA, "record").set("kind", "video");
        docA.commit();
        syncDocs(docA, docB);
        await waitForSync();
        expect(
            itemState(mirrorB.getState(), "record")!.$unknownVariant,
        ).toBeDefined();

        const cid = itemMap(docB, "record").id;
        mirrorB.setState((d) => {
            putItem(d, "record", slides());
        });
        mirrorB.finalizeEphemeralPatches();
        expect(itemMap(docB, "record").id).toBe(cid);
        expect(itemState(mirrorB.getState(), "record")).toEqual(slides());
        expect(itemState(mirrorB.getState(), "record")!.$cid).toBe(cid);
        const frames = itemMap(docB, "record").get("frames");
        expect(isContainer(frames) && frames.kind()).toBe("MovableList");
        mirrorB.checkStateConsistency();
    });

    it("switches through an ephemeral-store mirror", () => {
        const doc = new LoroDoc();
        const mirror = new Mirror({
            doc,
            schema: makeRoot(),
            inferOptions: { mergeableMapChildContainers: mergeable },
            ephemeralStore: new EphemeralStore(),
        });
        mirror.setState((d) => {
            putItem(d, "record", circle());
        });
        mirror.setState((d) => {
            putItem(d, "record", slides());
        });
        mirror.finalizeEphemeralPatches();
        expect(itemState(mirror.getState(), "record")).toEqual(
            itemMap(doc, "record").toJSON(),
        );
        mirror.checkStateConsistency();
    });
});
