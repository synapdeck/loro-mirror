/**
 * Mirror core functionality for bidirectional sync between app state and Loro CRDT
 */
import { setAutoFreeze } from "immer";
import { produce } from "./immer-instance.js";
// Mirror mutates the pending state in place while applying changes (see `stampCid`),
// so nothing it produces may be frozen. The private instance in `./immer-instance.js`
// already disables freezing for our own `produce` calls; this global call additionally
// covers values the host application builds with its own `produce` and hands to
// `setState`, which Mirror would otherwise be unable to stamp.
setAutoFreeze(false);
import {
    Container,
    ContainerID,
    ContainerType,
    EphemeralStore,
    isContainer,
    LoroDoc,
    LoroEventBatch,
    LoroList,
    LoroMap,
    LoroMovableList,
    LoroText,
    LoroTree,
    TreeID,
    type Value,
} from "loro-crdt";
import {
    EphemeralPatchManager,
    type EphemeralEligibleChange,
    type EphemeralPatchDelta,
    type EphemeralStoreChangeEvent,
    type PathResolverContext,
} from "./ephemeral.js";
import type {
    AnyLoroUnionSchema,
    InferContainerOptions,
} from "../schema/types.js";
export type { InferContainerOptions } from "../schema/types.js";

import { applyEventBatchToState } from "./loroEventApply.js";
import { normalizeTreeJson } from "./tree-utils.js";
import {
    ContainerSchemaType,
    getDefaultValue,
    InferInputType,
    InferType,
    isContainerSchema,
    isListLikeSchema,
    isLoroListSchema,
    isLoroMapSchema,
    isLoroMovableListSchema,
    isLoroTreeSchema,
    isLoroUnionSchema,
    LoroListSchema,
    LoroMapSchema,
    RootContainerSchemaType,
    RootSchemaType,
    SchemaType,
    schemaContainsIgnoreField,
    validateSchema,
} from "../schema/index.js";
import {
    isUnknownVariantPlaceholder,
    resolveUnionVariant,
    schemaContainsUnion,
    unionTagOf,
} from "../schema/union.js";
import {
    getChildContainerSchema,
    getChildSchema,
    getMapFieldSchema,
} from "../schema/resolver.js";
import {
    deepEqual,
    inferContainerTypeFromValue,
    isObject,
    isValueOfContainerType,
    applySchemaToInferOptions,
    schemaToContainerType,
    tryInferContainerType,
    getRootContainerByType,
    defineCidProperty,
    hardenCidDescriptors,
    stripUndefined,
    applyDecode,
    applyEncode,
    decodeNestedJsonValues,
    safeStringify,
    cidsEqual,
} from "./utils.js";
import { diffContainer, diffTree } from "./diff.js";
import { CID_KEY } from "../constants.js";
import { makeUnknownVariantPlaceholder } from "./union.js";

// Plain JSON-like value used for state snapshots
type MirrorStatePrimitive = string | number | boolean | null | undefined | {};
type MirrorState = MirrorStatePrimitive | MirrorStateObject | MirrorState[];
interface MirrorStateObject {
    [k: string]: MirrorState;
}

type RootSnapshotOptions = {
    registerContainers?: boolean;
};

type RegisterContainerOptions = {
    scanNested?: boolean;
    /** Resolve a union from this pending value instead of the doc. */
    value?: unknown;
    /** Replace an existing entry and re-scan nested containers with `force`. */
    force?: boolean;
};

type ChildRegistrationContext = {
    parentSchema: ContainerSchemaType | undefined;
    parentLocalInfer: InferContainerOptions | undefined;
};

/**
 * Values allowed for root-level keys of `initialState`. LoroDoc only stores
 * container types at the root, so primitives (bare `number`/`boolean`) are
 * disallowed. A root-level `string` is permitted because it maps to a root
 * `LoroText` container.
 */
export type RootInitialValue =
    | string
    | ReadonlyArray<unknown>
    | { readonly [key: string]: unknown }
    | null
    | undefined;

function hasKeyProp(c: Change): c is Extract<Change, { key: string | number }> {
    return (c as { key?: unknown }).key !== undefined;
}

/**
 * Source channel that caused this state update.
 */
export enum UpdateSource {
    /**
     * Changes coming from Loro to application state.
     */
    LORO = "LORO",

    /**
     * Local state changes initiated through Mirror APIs.
     */
    MIRROR = "MIRROR",

    /**
     * State recomposed due to an EphemeralStore change.
     */
    EPHEMERAL = "EPHEMERAL",
}

/**
 * Configuration options for the Mirror
 */
export interface MirrorOptions<S extends SchemaType> {
    /**
     * The Loro document to sync with
     */
    doc: LoroDoc;

    /**
     * The schema definition for the state
     */
    schema?: S;

    /**
     * Initial state (optional).
     *
     * LoroDoc can only hold container values at the root (Map, List,
     * MovableList, Text, Tree), so root entries must be container-shaped:
     * objects, arrays, strings, or `null`/`undefined`. Bare numbers and
     * booleans are rejected at the type level (and at runtime).
     */
    initialState?: Partial<import("../schema/index.js").InferInputType<S>> & {
        [key: string]: RootInitialValue;
    };

    /**
     * Whether to validate state updates against the schema
     * @default true
     */
    validateUpdates?: boolean;

    /**
     * Tolerate doc properties the schema does not declare — typically written
     * by peers running a newer schema version (forward compatibility).
     *
     * When enabled:
     * - Root keys missing from `schema.definition` are mirrored into state
     *   from every read path (initial snapshot and incremental events), just
     *   like the incremental event path already does by default. Unknown
     *   child keys of declared maps were always mirrored; that is unchanged.
     * - `validateUpdates` no longer rejects state with `Unknown property`
     *   errors for undeclared properties.
     *
     * State remains the source of truth for write-backs: an unknown key is
     * written back to the doc as long as it stays in state, and is deleted
     * from the doc if an update removes it from state — the same semantics
     * as any other key. No special preservation is applied.
     *
     * @default false
     */
    ignoreUnknownProperties?: boolean;

    /**
     * Debug mode - logs operations
     * @default false
     */
    debug?: boolean;

    /**
     * When enabled, performs an internal consistency check after setState
     * to ensure in-memory state equals the normalized LoroDoc JSON.
     * This throws on divergence but does not emit the verbose debug logs.
     * @default false
     */
    checkStateConsistency?: boolean;

    /**
     * Default values for new containers
     */
    inferOptions?: InferContainerOptions;

    /**
     * Optional `EphemeralStore` (from `loro-crdt`) for syncing temporary state
     * without polluting LoroDoc editing history.
     *
     * **Setting this changes how {@link Mirror.setState} works:** when
     * present, `setState` automatically classifies each change and routes
     * eligible ones (primitive values on existing Map keys) to the
     * EphemeralStore instead of LoroDoc. Structural changes (new keys,
     * containers, list/text/tree ops) still go to LoroDoc as usual.
     *
     * State returned by {@link Mirror.getState} is always the composed
     * result: `LoroDoc state + EphemeralStore overlay`. Callers don't need
     * to be aware of where each value lives.
     *
     * Ephemeral values are committed to LoroDoc when the
     * {@link SetStateOptions.finalizeTimeout | finalizeTimeout} expires
     * (default 50 000 ms) or when {@link Mirror.finalizeEphemeralPatches}
     * is called manually (e.g. on `mouseup`).
     *
     * Network sync of the EphemeralStore is the caller's responsibility:
     * ```ts
     * eph.subscribeLocalUpdates((bytes) => channel.send(bytes));
     * channel.on("ephemeral", (bytes) => eph.apply(bytes));
     * ```
     *
     * @see {@link Mirror.setState} for routing rules and examples
     * @see {@link Mirror.finalizeEphemeralPatches} for committing ephemeral values
     */
    ephemeralStore?: EphemeralStore;
}

export type ChangeKinds = {
    set: {
        container: ContainerID | "";
        key: string | number;
        value: unknown;
        kind: "set";
        childContainerType?: ContainerType;
    };
    setContainer: {
        container: ContainerID | "";
        key: string | number;
        value: unknown;
        kind: "set-container";
        childContainerType?: ContainerType;
    };
    insert: {
        container: ContainerID | "";
        key: string | number;
        value: unknown;
        kind: "insert";
    };
    insertContainer: {
        container: ContainerID | "";
        key: string | number;
        value: unknown;
        kind: "insert-container";
        childContainerType?: ContainerType;
    };
    delete: {
        container: ContainerID | "";
        key: string | number;
        value: unknown;
        kind: "delete";
    };
    move: {
        container: ContainerID;
        key: number;
        value: unknown;
        kind: "move";
        fromIndex: number;
        toIndex: number;
        childContainerType?: ContainerType;
    };
    treeCreate: {
        container: ContainerID;
        kind: "tree-create";
        parent?: TreeID;
        index: number;
        value?: unknown; // initial node.data
        // Called immediately after the node is created in Loro so we can:
        // 1) write the assigned TreeID back onto the newState node (users cannot know it ahead of time), and
        // 2) patch any queued child `tree-create` ops to point to this node as their `parent`.
        //
        // Note: this implies an ordering requirement when applying changes — tree creates must be
        // applied one-by-one and `onCreate` invoked right away to ensure children have the correct parent.
        onCreate(id: TreeID): void;
    };
    treeMove: {
        container: ContainerID;
        kind: "tree-move";
        target: TreeID;
        parent?: TreeID;
        index: number;
    };
    treeDelete: {
        container: ContainerID;
        kind: "tree-delete";
        target: TreeID;
    };
    unionSwitch: {
        container: ContainerID;
        value: Record<string, unknown>;
        kind: "union-switch";
    };
};

export type Change = ChangeKinds[keyof ChangeKinds];
export type MapChangeKinds =
    | ChangeKinds["insert"]
    | ChangeKinds["insertContainer"]
    | ChangeKinds["delete"];
export type ListChangeKinds =
    | ChangeKinds["insert"]
    | ChangeKinds["insertContainer"]
    | ChangeKinds["delete"];
export type MovableListChangeKinds =
    | ChangeKinds["insert"]
    | ChangeKinds["insertContainer"]
    | ChangeKinds["delete"]
    | ChangeKinds["move"]
    | ChangeKinds["set"]
    | ChangeKinds["setContainer"];
export type TreeChangeKinds =
    | ChangeKinds["treeCreate"]
    | ChangeKinds["treeMove"]
    | ChangeKinds["treeDelete"];
export type TextChangeKinds = ChangeKinds["insert"] | ChangeKinds["delete"];

/**
 * Options for setState and sync operations
 */
export interface SetStateOptions {
    /**
     * Tags to attach to this state update
     * Tags can be used for tracking the source of changes or grouping related changes
     */
    tags?: string[] | string;
    /**
     * Optional origin metadata forwarded to the underlying Loro commit.
     * Useful when callers need to tag commits with application-specific provenance.
     */
    origin?: string;
    /**
     * Optional timestamp forwarded to the underlying Loro commit metadata.
     */
    timestamp?: number;
    /**
     * Optional message forwarded to the underlying Loro commit metadata.
     */
    message?: string;
    /**
     * Debounce delay (in ms) before ephemeral values are automatically
     * committed to LoroDoc. The timer resets on every `setState` call that
     * produces ephemeral changes, so it only fires after the user stops
     * updating.
     *
     * Has no effect when no `ephemeralStore` is configured.
     *
     * Typical values:
     * - `1_000` (1 s) — drag/resize interactions where you want quick persistence
     * - `50_000` (50 s, default) — long-lived ephemeral state (e.g. cursor position)
     *
     * To commit immediately instead of waiting, call
     * {@link Mirror.finalizeEphemeralPatches}.
     *
     * @default 50_000
     */
    finalizeTimeout?: number;
}

type ContainerRegistry = Map<
    ContainerID,
    {
        schema: ContainerSchemaType | undefined;
        registered: boolean;
        /** Set when the container is a union map; `schema` is then its resolved variant. */
        union?: AnyLoroUnionSchema;
        /** The tag `schema` was resolved from (null: missing or non-string). */
        unionTag?: string | null;
    }
>;

/**
 * Additional metadata for state updates
 */
export interface UpdateMetadata {
    /**
     * Source channel that caused this update.
     */
    source: UpdateSource;

    /**
     * Tags associated with this update, if any
     */
    tags?: string[];
}

/**
 * Callback type for subscribers
 */
export type SubscriberCallback<T> = (
    state: T,
    metadata: UpdateMetadata,
) => void;

/**
 * Mirror class that provides bidirectional sync between application state and Loro
 */
export class Mirror<S extends SchemaType> {
    private doc: LoroDoc;
    private schema?: S;
    private state: InferType<S>;
    /** Pure LoroDoc state without ephemeral overlay */
    private baseState: InferType<S>;
    private subscribers: Set<SubscriberCallback<InferType<S>>> = new Set();
    private syncing = false;
    private options: MirrorOptions<S>;
    private containerRegistry: ContainerRegistry = new Map();
    private inferOptionsByContainerId: Map<ContainerID, InferContainerOptions> =
        new Map();
    private subscriptions: (() => void)[] = [];
    // Canonical root path (e.g., ["profile"]) per root container id
    private rootPathById: Map<ContainerID, string[]> = new Map();
    /** Root keys declared `schema.Ignore()` — memory-only; doc events for
     * them are dropped (see {@link filterIgnoredEvents}). */
    private ignoredRootKeys: Set<string> = new Set();
    /** Whether any nested (below-root) schema field is `schema.Ignore()`. */
    private hasNestedIgnoreFields = false;
    /** Whether the schema declares any union; gates union event routing. */
    private hasUnionSchemas = false;
    /**
     * Union maps whose tag changed in the batch being applied (re-registered by
     * {@link reresolveUnionOnTagChange} or a local {@link applyUnionSwitch}).
     * Cleared when a batch starts; read by routing and re-projection.
     */
    private retaggedUnionMaps: Set<ContainerID> = new Set();

    // Ephemeral patch manager (handles EphemeralStore, local tracking, path resolution, finalization)
    private ephemeralManager?: EphemeralPatchManager;
    private suppressLocalEphemeralEvents = 0;

    /**
     * Creates a new Mirror instance
     */
    constructor(options: MirrorOptions<S>) {
        this.doc = options.doc;
        this.schema = options.schema;

        // Cache Ignore fields up front: they are memory-only, so doc events
        // targeting them must be dropped before registration/application.
        if (this.schema && this.schema.type === "schema") {
            for (const [key, fieldSchema] of Object.entries(
                this.schema.definition,
            )) {
                if (fieldSchema.type === "ignore") {
                    this.ignoredRootKeys.add(key);
                } else if (schemaContainsIgnoreField(fieldSchema)) {
                    this.hasNestedIgnoreFields = true;
                }
            }
        }
        this.hasUnionSchemas = schemaContainsUnion(this.schema);

        // Set default options
        this.options = {
            doc: options.doc,
            schema: options.schema,
            initialState: options.initialState || {},
            validateUpdates: options.validateUpdates !== false,
            ignoreUnknownProperties: options.ignoreUnknownProperties || false,
            debug: options.debug || false,
            checkStateConsistency: options.checkStateConsistency || false,
            inferOptions: options.inferOptions || {},
        };

        // Pre-create root containers hinted by initialState (no-op in Loro for roots)
        // so that doc.toJSON() reflects empty shapes and matches normalized state.
        this.ensureRootContainersFromInitialState();

        // Initialize in-memory state without writing to LoroDoc:
        // 1) Start from schema defaults (if any)
        // 2) Fill any missing top-level keys hinted by initialState with a normalized empty shape
        //    (arrays -> [], strings -> '', objects -> {}), but do NOT override existing values
        //    from the doc/defaults. This keeps doc pristine while providing a predictable state shape.
        // 3) After container registration, initializeContainers overlays the current LoroDoc snapshot.
        const baseState: Record<string, unknown> = {};
        const defaults = (
            this.schema ? getDefaultValue(this.schema) : undefined
        ) as Record<string, unknown> | undefined;
        if (defaults && typeof defaults === "object") {
            Object.assign(baseState, defaults);
        }

        // Merge initialState with awareness of schema:
        // - Respect Ignore fields by keeping their values in memory only
        // - For container fields, fill missing base keys with normalized empties ([], "", {})
        // - For primitives, use provided initial values if doc/defaults do not provide them
        const initForMerge = (this.options.initialState || {}) as Record<
            string,
            unknown
        >;
        if (this.schema && this.schema.type === "schema") {
            mergeInitialIntoBaseWithSchema(
                baseState,
                initForMerge,
                this.schema as RootSchemaType<
                    Record<string, RootContainerSchemaType>
                >,
            );
        } else {
            const hinted = normalizeInitialShapeShallow(initForMerge);
            for (const [k, v] of Object.entries(hinted)) {
                if (!(k in baseState)) baseState[k] = v;
            }
        }

        this.baseState = baseState as InferType<S>;
        this.state = baseState as InferType<S>;

        // Initialize ephemeral manager if store provided
        if (options.ephemeralStore) {
            this.ephemeralManager = new EphemeralPatchManager(
                options.ephemeralStore,
            );
            this.subscriptions.push(
                this.ephemeralManager.subscribe(this.handleEphemeralEvent),
            );
        }

        // Initialize Loro containers and setup subscriptions
        this.initializeContainers();
        this.state = this.composeState(this.baseState);

        // Subscribe to the root doc for global updates
        this.subscriptions.push(this.doc.subscribe(this.handleLoroEvent));
    }

    /**
     * Ensure root containers exist for keys hinted by initialState.
     * Creating root containers is a no-op in Loro (no operations are recorded),
     * but it makes them visible in doc JSON, staying consistent with Mirror state.
     */
    private ensureRootContainersFromInitialState() {
        const init = (this.options?.initialState || {}) as Record<
            string,
            unknown
        >;
        const rootSchema =
            this.schema && this.schema.type === "schema"
                ? (this.schema as RootSchemaType<
                      Record<string, RootContainerSchemaType>
                  >)
                : undefined;
        for (const [key, value] of Object.entries(init)) {
            const fieldSchema = rootSchema?.definition[key];
            const containerType =
                (fieldSchema
                    ? schemaToContainerType(fieldSchema)
                    : undefined) ??
                this.inferRootContainerTypeFromInitialValue(value);
            if (!containerType) {
                // null/undefined are treated as "absent" and silently skipped.
                if (value == null) continue;
                // LoroDoc cannot store primitives at the document root — only
                // containers (Map, List, MovableList, Text, Tree). Silently
                // dropping the value would cause Mirror state to drift from
                // doc state on the next sync, so fail loudly instead.
                const fieldType = fieldSchema?.type;
                const observed = Array.isArray(value) ? "array" : typeof value;
                const detail = fieldType
                    ? `schema type "${fieldType}"`
                    : `value of type "${observed}"`;
                throw new Error(
                    `initialState["${key}"] is a primitive (${detail}), but LoroDoc only supports container types (Map, List, MovableList, Text, Tree) at the root. Wrap it under a root LoroMap (e.g. a "meta" map).`,
                );
            }

            const container = getRootContainerByType(
                this.doc,
                key,
                containerType,
            );
            this.rootPathById.set(container.id, [key]);
            this.registerContainerWithRegistry(container.id, undefined);
        }
    }

    private inferRootContainerTypeFromInitialValue(
        value: unknown,
    ): ContainerType | undefined {
        if (Array.isArray(value)) {
            return this.options.inferOptions?.defaultMovableList
                ? "MovableList"
                : "List";
        }
        if (typeof value === "string") {
            return "Text";
        }
        if (isObject(value)) {
            return "Map";
        }
        return undefined;
    }

    /**
     * Initialize containers based on schema
     */
    private initializeContainers() {
        if (this.schema && this.schema.type !== "schema") {
            throw new Error('Root schema must be of type "schema"');
        }

        // Register root containers first so registry is ready
        if (this.schema) {
            for (const key in this.schema.definition) {
                if (
                    Object.prototype.hasOwnProperty.call(
                        this.schema.definition,
                        key,
                    )
                ) {
                    const fieldSchema = this.schema.definition[key];

                    if (
                        [
                            "loro-map",
                            "loro-list",
                            "loro-text",
                            "loro-movable-list",
                            "loro-tree",
                        ].includes(fieldSchema.type)
                    ) {
                        const containerType =
                            schemaToContainerType(fieldSchema);
                        if (!containerType) {
                            continue;
                        }
                        const container = getRootContainerByType(
                            this.doc,
                            key,
                            containerType,
                        );
                        // Record canonical root path for this root container id
                        this.rootPathById.set(container.id, [key]);
                        this.registerContainerHandle(
                            container,
                            // narrowed by the type check above
                            fieldSchema as ContainerSchemaType,
                            {
                                scanNested: false,
                            },
                        );
                    }
                }
            }
        }

        // Build initial state snapshot from the current document
        const currentDocState = this.buildRootStateSnapshot(undefined, {
            registerContainers: true,
        });
        const newState = produce<InferType<S>>((draft) => {
            Object.assign(
                draft as unknown as Record<string, unknown>,
                currentDocState,
            );
        })(this.state);

        this.baseState = newState;
        this.state = this.composeState(newState);
    }

    /**
     * Registry entry for `container` under `schema`. A union resolves to its
     * variant: from `value` on the write path (the pending value is
     * authoritative), otherwise from the doc's stored tag.
     */
    private resolveRegistration(
        container: Container,
        schema: ContainerSchemaType | undefined,
        value?: unknown,
    ): {
        schema: ContainerSchemaType | undefined;
        union?: AnyLoroUnionSchema;
        unionTag?: string | null;
    } {
        if (!schema || !isLoroUnionSchema(schema)) return { schema };
        const tag =
            value !== undefined
                ? isObject(value)
                    ? value[schema.discriminant]
                    : undefined
                : container.kind() === "Map"
                  ? (container as LoroMap).get(schema.discriminant)
                  : undefined;
        return {
            schema: resolveUnionVariant(schema, tag),
            union: schema,
            unionTag: unionTagOf(tag),
        };
    }

    private registerContainerHandle(
        container: Container,
        schemaType: ContainerSchemaType | undefined,
        options: RegisterContainerOptions = {},
    ) {
        const containerId = container.id;
        const shouldScanNested = options.scanNested !== false;
        const resolved = this.resolveRegistration(
            container,
            schemaType,
            options.value,
        );

        // If already registered, optionally upgrade schema
        const existing = this.containerRegistry.get(containerId);
        if (existing && !options.force) {
            if (
                !existing.schema &&
                !existing.union &&
                (resolved.schema || resolved.union)
            ) {
                Object.assign(existing, resolved);
                // Schema was missing on initial registration (e.g. from
                // ensureRootContainersFromInitialState), so nested
                // containers were never scanned. Do it now.
                if (shouldScanNested) {
                    this.registerNestedContainers(container);
                }
            }
            return;
        }

        this.containerRegistry.set(containerId, {
            ...resolved,
            registered: true,
        });

        // Register nested containers
        if (shouldScanNested) {
            this.registerNestedContainers(container, { force: options.force });
        }
    }

    /**
     * Whether a freshly inserted container must replace its registry entry: a
     * union always (its variant comes from the pending value), and a reused
     * (mergeable) id whose entry was registered under another schema, such as
     * an earlier variant's field of the same name. A plain schema has one
     * schema object per position, so plain entries are never replaced.
     */
    private mustReregister(
        container: Container,
        schema: ContainerSchemaType | undefined,
    ): boolean {
        if (isLoroUnionSchema(schema)) return true;
        const existing = this.containerRegistry.get(container.id)?.schema;
        return !!existing && !!schema && existing !== schema;
    }

    private registerChildContainer(
        parent: Container,
        child: Container,
        childKey: string | number,
        context: ChildRegistrationContext,
        options: RegisterContainerOptions = {},
    ) {
        const { parentSchema, parentLocalInfer } = context;
        let nestedSchema: ContainerSchemaType | undefined;

        if (parent.kind() === "Map") {
            if (
                parentSchema &&
                isLoroMapSchema(parentSchema) &&
                typeof childKey === "string" &&
                !this.isUnionDiscriminant(parent.id, childKey)
            ) {
                const candidate = getMapFieldSchema(parentSchema, childKey);
                if (candidate?.type === "any") {
                    this.inferOptionsByContainerId.set(
                        child.id,
                        this.getInferOptionsForChild(parent.id, candidate),
                    );
                }
                if (candidate && isContainerSchema(candidate)) {
                    nestedSchema = candidate;
                }
            }
            if (
                nestedSchema &&
                this.containerRegistry.get(parent.id)?.union &&
                schemaToContainerType(nestedSchema) !== child.kind()
            ) {
                nestedSchema = undefined;
            }
        } else if (
            parent.kind() === "List" ||
            parent.kind() === "MovableList"
        ) {
            if (
                parentSchema &&
                (isLoroListSchema(parentSchema) ||
                    isLoroMovableListSchema(parentSchema))
            ) {
                const itemSchema = parentSchema.itemSchema;
                if (itemSchema?.type === "any") {
                    this.inferOptionsByContainerId.set(
                        child.id,
                        this.getInferOptionsForChild(parent.id, itemSchema),
                    );
                }
                if (isContainerSchema(itemSchema)) {
                    nestedSchema = itemSchema;
                }
            }
        }

        if (
            !parentSchema &&
            !nestedSchema &&
            parentLocalInfer &&
            !this.inferOptionsByContainerId.has(child.id)
        ) {
            this.inferOptionsByContainerId.set(child.id, parentLocalInfer);
        }

        this.registerContainerHandle(child, nestedSchema, options);
    }

    private getChildRegistrationContext(
        parent: Container,
    ): ChildRegistrationContext {
        return {
            parentSchema: this.getContainerSchema(parent.id),
            parentLocalInfer: this.inferOptionsByContainerId.get(parent.id),
        };
    }

    /**
     * Register nested containers within a container
     */
    private registerNestedContainers(
        container: Container,
        options: { force?: boolean } = {},
    ) {
        if (!container.isAttached) return;
        const childOptions: RegisterContainerOptions = {
            force: options.force,
        };

        try {
            if (container.kind() === "Map") {
                const map = container as LoroMap;
                const context = this.getChildRegistrationContext(container);
                for (const key of map.keys()) {
                    const value = map.get(key);
                    if (isContainer(value)) {
                        this.registerChildContainer(
                            container,
                            value,
                            key,
                            context,
                            childOptions,
                        );
                    }
                }
            } else if (
                container.kind() === "List" ||
                container.kind() === "MovableList"
            ) {
                const list = container as LoroList | LoroMovableList;
                const context = this.getChildRegistrationContext(container);
                const len = list.length;
                for (let i = 0; i < len; i++) {
                    const value = list.get(i);
                    if (isContainer(value)) {
                        this.registerChildContainer(
                            container,
                            value,
                            i,
                            context,
                            childOptions,
                        );
                    }
                }
            } else if (container.kind() === "Tree") {
                const tree = container as LoroTree;
                const { parentSchema, parentLocalInfer } =
                    this.getChildRegistrationContext(container);
                let nodeSchema: ContainerSchemaType | undefined;
                if (parentSchema && isLoroTreeSchema(parentSchema)) {
                    nodeSchema = parentSchema.nodeSchema as ContainerSchemaType;
                }
                if (nodeSchema) {
                    const nodes = tree.getNodes();
                    for (const node of nodes) {
                        // Register the node.data map and its nested containers
                        this.registerContainerHandle(
                            node.data,
                            nodeSchema,
                            childOptions,
                        );
                    }
                } else if (!parentSchema && parentLocalInfer) {
                    const nodes = tree.getNodes();
                    for (const node of nodes) {
                        if (!this.inferOptionsByContainerId.has(node.data.id)) {
                            this.inferOptionsByContainerId.set(
                                node.data.id,
                                parentLocalInfer,
                            );
                        }
                        this.registerContainerHandle(
                            node.data,
                            undefined,
                            childOptions,
                        );
                    }
                }
            }
        } catch (error) {
            if (this.options.debug) {
                console.warn(
                    `Error registering nested containers for ${container.id}:`,
                    error,
                );
            }
        }
    }

    /**
     * Handle events from the LoroDoc
     */
    private handleLoroEvent = (event: LoroEventBatch) => {
        if (this.syncing) return;
        // Drop events targeting Ignore fields before anything else: they must
        // not be registered, normalized, applied, or notified.
        const filtered = this.filterIgnoredEvents(event);
        if (filtered.events.length === 0) return;
        this.syncing = true;
        this.retaggedUnionMaps.clear();
        try {
            // Pre-register any containers referenced in this batch
            this.registerContainersFromLoroEvent(filtered);
            const routed = this.routeUnionEvents(filtered);
            const normalized = this.normalizeLoroEventBatch(routed.batch);
            // Incrementally update baseState using event deltas
            this.baseState = this.applyNormalizedLoroEventToState(
                this.baseState,
                normalized,
                routed.reproject,
            );
            // Compose state with ephemeral overlay
            this.state = this.composeState(this.baseState);
            // With canonicalized paths, applyEventBatchToState updates roots precisely.
            // No additional root refresh is required here.
            // Notify subscribers of the update
            this.notifySubscribers(UpdateSource.LORO);
        } finally {
            this.registerContainersFromLoroEvent(filtered);
            this.syncing = false;
        }
    };

    /**
     * Drop events that target `schema.Ignore()` fields — an ignored root key
     * (`event.path[0]`, or the event target's root container), or a nested
     * Ignore map field when the event path resolves to one.
     *
     * Ignored fields are memory-only: applying their deltas would materialize
     * state the schema asked to skip (e.g. rebuild a streaming list item by
     * item with wrong indices) and grow the container registry with
     * containers Mirror never reads.
     *
     * Returns the batch unchanged when the schema declares no Ignore fields
     * (fast path) or when nothing was filtered.
     */
    private filterIgnoredEvents(event: LoroEventBatch): LoroEventBatch {
        if (this.ignoredRootKeys.size === 0 && !this.hasNestedIgnoreFields) {
            return event;
        }
        // Inverted doc.getShallowValue(), built only when an event's path is
        // unusable and the target's root container must be resolved instead.
        let rootKeyByCid: Map<ContainerID, string> | undefined;
        const getRootKeyByCid = () => {
            if (!rootKeyByCid) {
                rootKeyByCid = new Map();
                for (const [key, cid] of Object.entries(
                    this.doc.getShallowValue(),
                )) {
                    rootKeyByCid.set(cid as ContainerID, key);
                }
            }
            return rootKeyByCid;
        };
        const events = event.events.filter(
            (e) => !this.isIgnoredEvent(e, getRootKeyByCid),
        );
        if (events.length === event.events.length) return event;
        return { ...event, events } as LoroEventBatch;
    }

    private isIgnoredEvent(
        e: LoroEventBatch["events"][number],
        getRootKeyByCid: () => Map<ContainerID, string>,
    ): boolean {
        const path = e.path;
        if (
            Array.isArray(path) &&
            path.length > 0 &&
            typeof path[0] === "string"
        ) {
            if (this.ignoredRootKeys.has(path[0])) return true;
            return (
                this.hasNestedIgnoreFields &&
                this.pathResolvesToIgnore(path, e.target)
            );
        }
        // Fallback for events without a usable root-anchored path: resolve
        // the target's root container and match it against ignored roots.
        const rootCid = this.rootContainerIdOf(e.target);
        if (!rootCid) return false;
        const rootKey = getRootKeyByCid().get(rootCid);
        return rootKey !== undefined && this.ignoredRootKeys.has(rootKey);
    }

    /**
     * Walk the schema along an event path; true when any position — most
     * usefully the last — resolves to an `ignore` field. Positions that leave
     * the schema (unknown keys, list indices under `any`, tree node ids)
     * resolve to `undefined` and are not ignored.
     */
    private pathResolvesToIgnore(
        path: (string | number)[],
        target: ContainerID,
    ): boolean {
        if (!this.schema || this.schema.type !== "schema") return false;
        let current: SchemaType | undefined = (
            this.schema.definition as Record<string, SchemaType>
        )[String(path[0])];
        let chain: Container[] | undefined;
        for (let i = 1; i < path.length && current; i++) {
            if ((current as { type: string }).type === "ignore") return true;
            if (isLoroUnionSchema(current)) {
                // The union map sits at path[0..i-1]; use its resolved variant.
                chain ??= this.containerChainOf(target);
                const hop = chain[i - 1];
                current = hop ? this.getContainerSchema(hop.id) : undefined;
                if (!current) return false;
            }
            current = getChildSchema(current, path[i]);
        }
        return !!current && (current as { type: string }).type === "ignore";
    }

    /** The container chain from the root container down to `target`. */
    private containerChainOf(target: ContainerID): Container[] {
        const chain: Container[] = [];
        let cur = this.doc.getContainerById(target);
        while (cur) {
            chain.push(cur);
            cur = cur.parent() ?? undefined;
        }
        return chain.reverse();
    }

    /** Root container id of the container `target` belongs to. */
    private rootContainerIdOf(target: ContainerID): ContainerID | undefined {
        let cur = this.doc.getContainerById(target);
        if (!cur) return undefined;
        let root = cur;
        let parent = root.parent() ?? undefined;
        while (parent) {
            root = parent;
            parent = root.parent() ?? undefined;
        }
        return root.id;
    }

    private normalizeLoroEventBatch(event: LoroEventBatch): LoroEventBatch {
        return {
            ...event,
            events: event.events.map((e) => {
                const canon = this.rootPathById.get(e.target);
                if (
                    canon &&
                    (!Array.isArray(e.path) || e.path[0] !== canon[0])
                ) {
                    return { ...e, path: canon } as typeof e;
                }
                return e;
            }),
        } as LoroEventBatch;
    }

    private applyNormalizedLoroEventToState(
        currentState: InferType<S>,
        event: LoroEventBatch,
        reproject: ContainerID[] = [],
    ): InferType<S> {
        const nextState = applyEventBatchToState(
            currentState as unknown as Record<string, unknown>,
            event,
            {
                getContainerById: (id) => this.doc.getContainerById(id),
                containerToMirrorState: (c) => this.containerToMirrorState(c),
                nodeDataWithCid: (treeId) => {
                    const schema = this.getContainerSchema(treeId);
                    return !!(schema && isLoroTreeSchema(schema));
                },
                getNodeDataCid: (treeId, nodeId) => {
                    try {
                        const node = this.doc
                            .getTree(treeId)
                            .getNodeByID(nodeId);
                        return node ? node.data.id : undefined;
                    } catch {
                        return undefined;
                    }
                },
                getSchemaForKey: (containerId, mapKey) => {
                    if (this.isUnionDiscriminant(containerId, mapKey)) {
                        return undefined;
                    }
                    return getChildSchema(
                        this.getContainerSchema(containerId),
                        mapKey,
                    );
                },
                reproject: reproject.length
                    ? {
                          ids: reproject,
                          getPath: (id) =>
                              this.doc.getPathToContainer(id) ?? undefined,
                          project: (id, previous) =>
                              this.reprojectUnionMap(id, previous),
                      }
                    : undefined,
            },
        ) as unknown as InferType<S>;
        this.stampCidForEventTargets(nextState, event);
        return nextState;
    }

    /**
     * Events under an unknown-variant placeholder are dropped and the
     * placeholder re-projected. A map event on a known union map re-projects
     * that map only when its tag changed in this batch or the event touches a
     * key the variant does not project (stray, wrong-kind, or Ignore);
     * otherwise it applies per key, keeping unchanged children's identity.
     * Events inside a container a known union map does not project (a stray
     * or wrong-kind slot) are dropped: that slot is not in state.
     */
    private routeUnionEvents(batch: LoroEventBatch): {
        batch: LoroEventBatch;
        reproject: ContainerID[];
    } {
        if (!this.hasUnionSchemas) return { batch, reproject: [] };
        const reproject = new Set<ContainerID>();
        const events = batch.events.flatMap((e) => {
            let child: Container | undefined;
            let cur: Container | undefined = this.doc.getContainerById(
                e.target,
            );
            while (cur) {
                const entry = this.containerRegistry.get(cur.id);
                if (entry?.union && !entry.schema) {
                    reproject.add(cur.id);
                    return [];
                }
                if (entry?.union && child && cur.kind() === "Map") {
                    const key = this.doc.getPathToContainer(child.id)?.at(-1);
                    if (
                        typeof key === "string" &&
                        !this.unionSlotIsReadable(
                            { union: entry.union, schema: entry.schema },
                            key,
                            (cur as LoroMap).get(key),
                        )
                    ) {
                        return [];
                    }
                }
                child = cur;
                cur = cur.parent() ?? undefined;
            }
            if (e.diff.type === "map") {
                const entry = this.containerRegistry.get(e.target);
                const union = entry?.union;
                if (
                    union &&
                    (this.retaggedUnionMaps.has(e.target) ||
                        Object.entries(e.diff.updated).some(
                            ([key, value]) =>
                                !this.unionKeyAppliesPerKey(
                                    { union, schema: entry.schema },
                                    key,
                                    value,
                                ),
                        ))
                ) {
                    reproject.add(e.target);
                    // Ignore keys are memory-only: keep doc writes to them out
                    // of the draft so the re-projection carries the memory value.
                    const variant = entry.schema;
                    const updated = Object.fromEntries(
                        Object.entries(e.diff.updated).filter(
                            ([key]) =>
                                !(
                                    variant &&
                                    isLoroMapSchema(variant) &&
                                    getMapFieldSchema(variant, key)?.type ===
                                        "ignore"
                                ),
                        ),
                    );
                    if (
                        Object.keys(updated).length ===
                        Object.keys(e.diff.updated).length
                    )
                        return [e];
                    if (Object.keys(updated).length === 0) return [];
                    return [{ ...e, diff: { ...e.diff, updated } } as typeof e];
                }
            }
            return [e];
        });
        return {
            batch:
                events.length === batch.events.length &&
                events.every((ev, i) => ev === batch.events[i])
                    ? batch
                    : ({ ...batch, events } as LoroEventBatch),
            reproject: [...reproject],
        };
    }

    /**
     * Whether a map-event write of `key` on a known union map can be applied
     * per key. A deletion can, unless it hits an Ignore key (whose memory-only
     * value must survive); a set can when the slot is readable.
     */
    private unionKeyAppliesPerKey(
        entry: {
            union: AnyLoroUnionSchema;
            schema: ContainerSchemaType | undefined;
        },
        key: string,
        value: unknown,
    ): boolean {
        if (value === undefined) {
            return !(
                entry.schema &&
                isLoroMapSchema(entry.schema) &&
                getMapFieldSchema(entry.schema, key)?.type === "ignore"
            );
        }
        return this.unionSlotIsReadable(entry, key, value);
    }

    /**
     * Fresh projection of a union map, keeping its variant's memory-only Ignore
     * values — only when the variant is unchanged, so a switch never carries
     * the old variant's real field into the new variant's Ignore slot.
     */
    private reprojectUnionMap(
        id: ContainerID,
        previous: unknown,
    ): MirrorState | undefined {
        const c = this.doc.getContainerById(id);
        // `isDeleted` is not on the `Container` union (LoroCounter lacks it).
        if (!c || this.doc.getPathToContainer(id) === undefined)
            return undefined;
        const projected = this.containerToMirrorState(c) as MirrorStateObject;
        const entry = this.containerRegistry.get(id);
        const variant = entry?.schema;
        if (
            entry?.union &&
            variant &&
            isLoroMapSchema(variant) &&
            isObject(previous) &&
            !isUnknownVariantPlaceholder(previous) &&
            !this.retaggedUnionMaps.has(id) &&
            previous[entry.union.discriminant] === entry.unionTag
        ) {
            for (const [key, fieldSchema] of Object.entries(
                variant.definition,
            )) {
                if (fieldSchema.type === "ignore" && key in previous) {
                    projected[key] = previous[key] as MirrorState;
                }
            }
        }
        return projected;
    }

    /** A remote write changed a union map's tag: re-resolve it and its subtree. */
    private reresolveUnionOnTagChange(
        target: ContainerID,
        updated: Record<string, unknown>,
    ) {
        const entry = this.containerRegistry.get(target);
        if (!entry?.union) return;
        if (
            !Object.prototype.hasOwnProperty.call(
                updated,
                entry.union.discriminant,
            )
        )
            return;
        const map = this.doc.getContainerById(target);
        if (!map || map.kind() !== "Map") return;
        if (
            unionTagOf((map as LoroMap).get(entry.union.discriminant)) ===
            entry.unionTag
        )
            return;
        this.registerContainerHandle(map, entry.union, { force: true });
        this.retaggedUnionMaps.add(target);
    }

    private captureLocalDocEvent(
        callback: () => void,
    ): LoroEventBatch | undefined {
        let captured: LoroEventBatch | undefined;
        const unsubscribe = this.doc.subscribe((event) => {
            if (event.by === "local") {
                captured = event;
            }
        });
        try {
            callback();
        } finally {
            unsubscribe();
        }
        return captured;
    }

    private stampCidForEventTargets(
        state: InferType<S>,
        event: LoroEventBatch,
    ): void {
        const visited = new Set<ContainerID>();
        for (const item of event.events) {
            if (visited.has(item.target)) continue;
            visited.add(item.target);

            const container = this.doc.getContainerById(item.target);
            if (!container || container.kind() !== "Map") {
                continue;
            }

            const path = this.doc.getPathToContainer(container.id);
            if (!path || path.length === 0) continue;

            let target: unknown = state;
            for (const segment of path) {
                if (!target || typeof target !== "object") {
                    target = undefined;
                    break;
                }
                target = (target as Record<string | number, unknown>)[segment];
            }

            if (target && typeof target === "object") {
                defineCidProperty(target, container.id);
            }
        }
    }

    /**
     * Processes container additions/removals from the LoroDoc
     * and ensures the containers are reflected in the container registry.
     *
     * TODO: need to handle removing containers from the registry on import
     * right now the Diff Delta only returns the number of items removed
     * not the container IDs , of those that were removed.
     */
    private registerContainersFromLoroEvent(batch: LoroEventBatch) {
        for (const event of batch.events) {
            if (event.diff.type === "list") {
                const diff = event.diff.diff;

                const schema = this.getContainerSchema(event.target);
                const itemSchema =
                    schema && isListLikeSchema(schema)
                        ? schema.itemSchema
                        : undefined;
                const parentLocalInfer = this.inferOptionsByContainerId.get(
                    event.target,
                );

                for (const change of diff) {
                    if (!change.insert) continue;
                    for (const item of change.insert) {
                        if (isContainer(item)) {
                            const container = item;

                            let containerSchema:
                                | ContainerSchemaType
                                | undefined;

                            if (itemSchema?.type === "any") {
                                this.inferOptionsByContainerId.set(
                                    container.id,
                                    this.getInferOptionsForChild(
                                        event.target,
                                        itemSchema,
                                    ),
                                );
                            } else if (isContainerSchema(itemSchema)) {
                                containerSchema = itemSchema;
                            } else if (
                                !schema &&
                                parentLocalInfer &&
                                !this.inferOptionsByContainerId.has(
                                    container.id,
                                )
                            ) {
                                this.inferOptionsByContainerId.set(
                                    container.id,
                                    parentLocalInfer,
                                );
                            }

                            this.registerContainerHandle(
                                container,
                                containerSchema,
                            );

                            if (
                                schema &&
                                itemSchema &&
                                itemSchema.type !== "any" &&
                                !containerSchema
                            ) {
                                console.warn(
                                    `Container schema not found for key  in list ${event.target}`,
                                );
                            }
                        }
                    }
                }
            } else if (event.diff.type === "map") {
                this.reresolveUnionOnTagChange(
                    event.target,
                    event.diff.updated,
                );
                const diff = event.diff.updated;
                const parentSchema = this.getContainerSchema(event.target);
                const parentLocalInfer = this.inferOptionsByContainerId.get(
                    event.target,
                );

                for (const [key, change] of Object.entries(diff)) {
                    const schema = this.getSchemaForChild(event.target, key);
                    if (isContainer(change)) {
                        let containerSchema = isContainerSchema(schema)
                            ? schema
                            : undefined;
                        if (
                            containerSchema &&
                            this.containerRegistry.get(event.target)?.union &&
                            schemaToContainerType(containerSchema) !==
                                change.kind()
                        ) {
                            containerSchema = undefined;
                        }
                        if (schema?.type === "any") {
                            this.inferOptionsByContainerId.set(
                                change.id,
                                this.getInferOptionsForChild(
                                    event.target,
                                    schema,
                                ),
                            );
                        } else if (
                            !parentSchema &&
                            parentLocalInfer &&
                            !this.inferOptionsByContainerId.has(change.id)
                        ) {
                            this.inferOptionsByContainerId.set(
                                change.id,
                                parentLocalInfer,
                            );
                        }
                        this.registerContainerHandle(change, containerSchema);

                        if (
                            parentSchema &&
                            !containerSchema &&
                            schema?.type !== "any" &&
                            !this.containerRegistry.get(event.target)?.union
                        ) {
                            console.warn(
                                `Container schema not found for key ${key} in map ${event.target}`,
                            );
                        }
                    }
                }
            } else if (event.diff.type === "tree") {
                const tree = this.doc.getTree(event.target);
                const schema = this.getContainerSchema(event.target);
                let nodeSchema: ContainerSchemaType | undefined;
                if (schema && isLoroTreeSchema(schema)) {
                    nodeSchema = schema.nodeSchema as ContainerSchemaType;
                }
                if (!nodeSchema) continue;

                for (const item of event.diff.diff) {
                    if (item.action === "create") {
                        const node = tree.getNodeByID(item.target);
                        if (node) {
                            this.registerContainerHandle(node.data, nodeSchema);
                        }
                    }
                }
            }
        }
    }

    // Tree node $cid injection happens during event application

    /**
     * Update Loro based on state changes
     */
    private updateLoro(newState: InferType<S>, options?: SetStateOptions) {
        if (this.syncing) return;

        this.syncing = true;
        try {
            // Diff against the composed state (not baseState) so that remote
            // ephemeral overlay values are not treated as local changes.
            const currentDocState = this.state;

            const changes = diffContainer(
                this.doc,
                currentDocState,
                newState,
                "",
                this.schema,
                this.options?.inferOptions,
            );
            // Apply the changes to the Loro document (and stamp any pending-state metadata like $cid)
            this.applyChangesToLoro(changes, newState, options);
        } finally {
            this.syncing = false;
        }
    }

    /**
     * Apply a set of changes to the Loro document
     */
    private applyChangesToLoro(
        changes: Change[],
        pendingState?: InferType<S>,
        options?: SetStateOptions,
    ) {
        // Group changes by container for batch processing
        const changesByContainer = new Map<ContainerID | "", Change[]>();

        for (const change of changes) {
            if (!changesByContainer.has(change.container)) {
                changesByContainer.set(change.container, []);
            }
            changesByContainer.get(change.container)!.push(change);
        }

        // Process changes by container
        for (const [
            containerId,
            containerChanges,
        ] of changesByContainer.entries()) {
            if (containerId === "") {
                // Handle root level changes
                this.applyRootChanges(containerChanges, pendingState);
            } else {
                // Handle container-specific changes
                const container = this.doc.getContainerById(containerId);
                if (container) {
                    this.applyContainerChanges(
                        container,
                        containerChanges,
                        pendingState,
                    );
                } else {
                    throw new Error(
                        `Container not found for ID: ${containerId}.
                        This is likely due to a stale reference or a synchronization issue.`,
                    );
                }
            }
        }
        // Only commit if we actually applied any changes
        if (changes.length > 0) {
            let commitOptions: Parameters<LoroDoc["commit"]>[0];
            if (options) {
                const commitMeta: {
                    origin?: string;
                    timestamp?: number;
                    message?: string;
                } = {};
                if (options.origin !== undefined) {
                    commitMeta.origin = options.origin;
                }
                if (options.timestamp !== undefined) {
                    commitMeta.timestamp = options.timestamp;
                }
                if (options.message !== undefined) {
                    commitMeta.message = options.message;
                }
                if (
                    commitMeta.origin !== undefined ||
                    commitMeta.timestamp !== undefined ||
                    commitMeta.message !== undefined
                ) {
                    commitOptions = commitMeta;
                }
            }
            this.doc.commit(commitOptions);
        }
    }

    /**
     * Update root-level fields
     */
    private applyRootChanges(changes: Change[], pendingState?: InferType<S>) {
        for (const change of changes) {
            if (!hasKeyProp(change)) continue;
            const { key, value } = change;
            const keyStr = key.toString();

            const fieldSchema = (
                this.schema as RootSchemaType<
                    Record<string, RootContainerSchemaType>
                >
            )?.definition?.[keyStr];
            const type =
                fieldSchema?.type ||
                inferContainerTypeFromValue(value, this.options?.inferOptions);
            let container: Container | null = null;

            // Create or get the container based on the schema type
            if (type === "loro-map") {
                container = this.doc.getMap(keyStr);
            } else if (type === "loro-list") {
                container = this.doc.getList(keyStr);
            } else if (type === "loro-text") {
                container = this.doc.getText(keyStr);
            } else if (type === "loro-movable-list") {
                container = this.doc.getMovableList(keyStr);
            } else if (type === "loro-tree") {
                container = this.doc.getTree(keyStr);
            } else {
                throw new Error();
            }

            this.registerContainerWithRegistry(container.id, fieldSchema);

            // Inject $cid for root maps into pending state immediately
            if (pendingState && container.kind() === "Map") {
                const rootObj = pendingState as Record<string, unknown>;
                const child = rootObj[keyStr];
                this.stampCid(child, container.id);
            }

            // Apply direct changes to the container
            this.updateTopLevelContainer(container, value);
        }
    }

    /**
     * Apply multiple changes to a container
     */
    private applyContainerChanges(
        container: Container,
        changes: Change[],
        _pendingState?: InferType<S>,
    ) {
        // Apply changes in bulk by container type
        switch (container.kind()) {
            case "Map": {
                const map = container as LoroMap;

                for (const change of changes) {
                    if (change.kind === "union-switch") {
                        this.applyUnionSwitch(map, change.value);
                        continue;
                    }
                    const { key, value, kind } = change as MapChangeKinds;
                    if (key === "") {
                        continue; // Skip empty key
                    }
                    // If schema marks this key as Ignore, skip writing to Loro
                    const fieldSchema = this.getSchemaForChild(
                        container.id,
                        key,
                    );
                    if (fieldSchema && fieldSchema.type === "ignore") {
                        continue;
                    }
                    if (kind === "insert") {
                        map.set(key as string, value);
                    } else if (kind === "insert-container") {
                        const schema = this.getSchemaForChildContainer(
                            container.id,
                            key,
                        );
                        const childInfer =
                            fieldSchema?.type === "any"
                                ? this.getInferOptionsForChild(
                                      container.id,
                                      fieldSchema,
                                  )
                                : undefined;
                        const inserted = this.insertContainerIntoMap(
                            map,
                            schema,
                            key as string,
                            value,
                            childInfer,
                        );
                        // Stamp $cid into the pendingState value for child maps
                        this.stampCid(value, inserted.id);
                    } else if (kind === "delete") {
                        map.delete(key as string);
                    } else {
                        throw new Error("Unsupported change kind for map");
                    }
                }
                break;
            }
            case "List": {
                const list = container as LoroList;
                // Process other changes (add/remove/replace)
                for (const change of changes) {
                    const { key, value, kind } = change as ListChangeKinds;
                    if (typeof key !== "number") {
                        throw new Error(`Invalid list index: ${key}`);
                    }

                    const index = key;
                    if (index < 0) {
                        console.warn(`Invalid list index: ${index}`);
                        continue;
                    }

                    if (kind === "delete") {
                        list.delete(index, 1);
                    } else if (kind === "insert") {
                        list.insert(index, value);
                    } else if (kind === "insert-container") {
                        const fieldSchema = this.getSchemaForChild(
                            container.id,
                            key,
                        );
                        const schema = this.getSchemaForChildContainer(
                            container.id,
                            key,
                        );
                        this.insertContainerIntoList(
                            list,
                            schema,
                            index,
                            value,
                            fieldSchema?.type === "any"
                                ? this.getInferOptionsForChild(
                                      container.id,
                                      fieldSchema,
                                  )
                                : undefined,
                        );
                    } else {
                        throw new Error("Unsupported change kind for list");
                    }
                }
                break;
            }
            case "MovableList": {
                const list = container as LoroMovableList;

                for (const change of changes) {
                    const { key, value, kind } =
                        change as MovableListChangeKinds;
                    if (typeof key !== "number") {
                        throw new Error(`Invalid list index: ${key}`);
                    }

                    const index = key;
                    if (index < 0) {
                        console.warn(`Invalid list index: ${index}`);
                        continue;
                    }

                    if (kind === "delete") {
                        list.delete(index, 1);
                    } else if (kind === "insert") {
                        list.insert(index, value);
                    } else if (kind === "insert-container") {
                        const fieldSchema = this.getSchemaForChild(
                            container.id,
                            key,
                        );
                        const schema = this.getSchemaForChildContainer(
                            container.id,
                            key,
                        );
                        this.insertContainerIntoList(
                            list,
                            schema,
                            index,
                            value,
                            fieldSchema?.type === "any"
                                ? this.getInferOptionsForChild(
                                      container.id,
                                      fieldSchema,
                                  )
                                : undefined,
                        );
                    } else if (kind === "move") {
                        const c = change as ChangeKinds["move"];
                        const fromIndex = c.fromIndex;
                        const toIndex = c.toIndex;
                        list.move(fromIndex, toIndex);
                    } else if (kind === "set") {
                        list.set(index, value);
                    } else if (kind === "set-container") {
                        const fieldSchema = this.getSchemaForChild(
                            container.id,
                            key,
                        );
                        const schema = this.getSchemaForChildContainer(
                            container.id,
                            key,
                        );
                        const infer =
                            fieldSchema?.type === "any"
                                ? this.getInferOptionsForChild(
                                      container.id,
                                      fieldSchema,
                                  )
                                : !schema
                                  ? this.getInferOptionsForContainer(
                                        container.id,
                                    )
                                  : undefined;
                        const [detachedContainer, _containerType] =
                            this.createContainerFromSchema(
                                schema,
                                value,
                                infer,
                            );
                        const newContainer = list.setContainer(
                            index,
                            detachedContainer,
                        );

                        if (!schema && infer) {
                            this.inferOptionsByContainerId.set(
                                newContainer.id,
                                infer,
                            );
                        }
                        this.registerContainerHandle(newContainer, schema, {
                            value,
                            force: this.mustReregister(newContainer, schema),
                        });
                        this.initializeContainer(newContainer, schema, value);
                        // Stamp $cid into pending state when replacing with a map container
                        this.stampCid(value, newContainer.id);
                    } else {
                        throw new Error();
                    }
                }

                break;
            }
            case "Text": {
                const text = container as LoroText;
                // Text containers only support direct value updates
                for (const change of changes) {
                    if (!("value" in change)) continue;
                    const v = (change as TextChangeKinds).value;
                    if (typeof v === "string") {
                        text.update(v);
                    } else {
                        // ignore
                    }
                }
                break;
            }
            case "Tree": {
                const tree = container as LoroTree;
                // Determine node schema for initializing new nodes
                let nodeSchema: ContainerSchemaType | undefined;
                const parentSchema = this.getContainerSchema(tree.id);
                if (parentSchema && isLoroTreeSchema(parentSchema)) {
                    nodeSchema = parentSchema.nodeSchema as ContainerSchemaType;
                }

                for (const change of changes) {
                    if (change.kind === "tree-create") {
                        const newNode = tree.createNode(
                            change.parent,
                            change.index,
                        );
                        // Propagate the concrete TreeID back into the in-memory newState and
                        // fix up any pending child creates that depend on this parent's ID.
                        change.onCreate(newNode.id);
                        if (nodeSchema) {
                            this.registerContainerHandle(
                                newNode.data,
                                nodeSchema,
                            );
                            this.initializeContainer(
                                newNode.data,
                                nodeSchema,
                                change.value,
                            );
                            // Stamp $cid into node.data in pending state
                            if (
                                isLoroMapSchema(nodeSchema) &&
                                isObject(change.value)
                            ) {
                                defineCidProperty(
                                    change.value,
                                    newNode.data.id,
                                );
                            }
                        }
                    } else if (change.kind === "tree-move") {
                        tree.move(change.target, change.parent, change.index);
                    } else if (change.kind === "tree-delete") {
                        tree.delete(change.target);
                    } else {
                        // ignore non-tree changes for tree container
                    }
                }
                break;
            }
            default:
                console.warn(`Unsupported container type: ${container.kind()}`);
        }
    }

    /**
     * Update a top-level container directly with a new value
     */
    private updateTopLevelContainer(container: Container, value: unknown) {
        const kind = container.kind();

        switch (kind) {
            case "Text":
                this.updateTextContainer(container as LoroText, value);
                break;
            case "List":
                this.updateListContainer(container as LoroList, value);
                break;
            case "Map":
                this.updateMapContainer(container as LoroMap, value);
                break;
            case "MovableList":
                this.updateListContainer(container as LoroMovableList, value);
                break;
            case "Tree":
                this.updateTreeContainer(container as LoroTree, value);
                break;
            default:
                throw new Error(
                    `Unknown container kind for top-level update: ${kind}.
                    This is likely a programming error or unsupported container type.`,
                );
        }
    }

    /**
     * Update a Text container
     */
    private updateTextContainer(text: LoroText, value: unknown) {
        if (typeof value !== "string") {
            throw new Error("Text value must be a string");
        }
        text.update(value);
    }

    /**
     * Update a List container
     */
    private updateListContainer(
        list: LoroList | LoroMovableList,
        value: unknown,
    ) {
        // Replace entire list
        if (Array.isArray(value)) {
            // Find the schema for this container path
            const schema = this.getContainerSchema(list.id);

            if (
                schema &&
                !isLoroListSchema(schema) &&
                !isLoroMovableListSchema(schema)
            ) {
                throw new Error(
                    `Invalid schema for list: ${schema.type}. Expected LoroListSchema`,
                );
            }

            // Get the idSelector function from the schema
            const idSelector = schema?.idSelector;
            const itemSchema = schema?.itemSchema;

            // Clear out the list first to avoid duplicate items
            // Instead of clearing the entire list, which can leave it empty if there's an error,
            // we'll replace items one by one and only remove items that aren't in the new list
            if (idSelector) {
                // If we have an ID selector, we can use it for more intelligent updates
                this.updateListWithIdSelector(
                    list,
                    value,
                    idSelector,
                    itemSchema!,
                );
            } else {
                this.updateListByIndex(list, value, itemSchema);
            }
        } else {
            throw new Error("List value must be an array");
        }
    }

    /**
     * Update a list using ID selector for efficient updates
     */
    private updateListWithIdSelector(
        list: LoroList | LoroMovableList,
        newItems: unknown[],
        idSelector: (item: unknown) => string | null,
        itemSchema: SchemaType,
    ) {
        // First, map current items by ID
        const currentItemsById = new Map<
            string,
            { item: unknown; index: number }
        >();
        const currentLength = list.length;

        for (let i = 0; i < currentLength; i++) {
            const item = list.get(i);
            try {
                if (item) {
                    const id = idSelector(item);
                    if (id) {
                        currentItemsById.set(id, { item, index: i });
                    }
                }
            } catch (e) {
                if (this.options.debug) {
                    console.warn(`Error getting ID for current list item:`, e);
                }
            }
        }

        // Then map new items by ID
        const newItemsById = new Map<
            string,
            { item: unknown; index: number }
        >();

        // Helper function to get ID from either LoroMap or plain object
        const getIdFromItem = (item: unknown) => {
            if (!item) return null;

            try {
                // First try using the idSelector directly (for LoroMap objects)
                const id = idSelector(item);
                if (id) return id;
            } catch (e) {
                // If that fails, try to extract ID from plain object
                if (this.options.debug) {
                    console.warn(`Error using ID selector directly:`, e);
                }

                // If idSelector tries to call .get("id"), we can try to access .id directly
                const idProp = (item as { id?: unknown }).id;
                if (typeof idProp === "string") {
                    return idProp;
                }
            }
            return null;
        };

        newItems.forEach((item, index) => {
            try {
                const id = getIdFromItem(item);
                if (id) {
                    newItemsById.set(id, { item, index });
                } else {
                    throw new Error(`Item at index ${index} has no ID`);
                }
            } catch (e) {
                if (this.options.debug) {
                    console.warn(
                        `Error getting ID for new list item at index ${index}:`,
                        e,
                    );
                }
            }
        });

        // Find items to remove (in current but not in new)
        const itemsToRemove: number[] = [];
        for (const [id, { index }] of currentItemsById.entries()) {
            if (!newItemsById.has(id)) {
                itemsToRemove.push(index);
            }
        }

        // Sort in reverse order to remove higher indices first (to avoid index shifting issues)
        itemsToRemove.sort((a, b) => b - a);

        // Remove items that aren't in the new list
        for (const index of itemsToRemove) {
            list.delete(index, 1);
        }

        // Now go through the new list and add or update items
        let currentIndex = 0;

        for (let i = 0; i < newItems.length; i++) {
            const newItem = newItems[i];
            let id: string | null = null;

            try {
                id = getIdFromItem(newItem);
            } catch (e) {
                console.warn(`Error getting ID for new item at index ${i}:`, e);
                continue;
            }

            if (!id) continue;

            const currentEntry = currentItemsById.get(id);

            if (currentEntry) {
                // Item exists, update if needed
                const currentItem = list.get(currentIndex);
                if (!deepEqual(currentItem, newItem)) {
                    // Only update if different
                    list.delete(currentIndex, 1);
                    this.insertItemIntoList(
                        list,
                        currentIndex,
                        newItem,
                        itemSchema,
                    );
                }
            } else {
                // New item, insert at current position
                this.insertItemIntoList(
                    list,
                    currentIndex,
                    newItem,
                    itemSchema,
                );
            }

            currentIndex++;
        }

        // Truncate any remaining items if the new list is shorter
        if (currentIndex < list.length) {
            list.delete(currentIndex, list.length - currentIndex);
        }
    }

    /**
     * Update a list by index (for lists without an ID selector)
     */
    private updateListByIndex(
        list: LoroList | LoroMovableList,
        newItems: unknown[],
        itemSchema: SchemaType | undefined,
    ) {
        // First, clear the list
        const oldLength = list.length;

        // Instead of clearing everything and re-adding, update existing items and add/remove as needed
        const maxLength = Math.max(oldLength, newItems.length);

        for (let i = 0; i < maxLength; i++) {
            if (i >= oldLength) {
                // Add new item
                this.insertItemIntoList(list, i, newItems[i], itemSchema);
            } else if (i >= newItems.length) {
                // Remove excess items, starting from the end
                list.delete(newItems.length, oldLength - newItems.length);
                break;
            } else {
                // Update existing item
                const oldItem = list.get(i);
                const newItem = newItems[i];

                if (!deepEqual(oldItem, newItem)) {
                    list.delete(i, 1);
                    this.insertItemIntoList(list, i, newItem, itemSchema);
                }
            }
        }
    }

    /**
     * Helper to insert an item into a list, handling containers appropriately
     */
    private insertItemIntoList(
        list: LoroList | LoroMovableList,
        index: number,
        item: unknown,
        itemSchema: SchemaType | undefined,
    ) {
        const baseInfer = this.getInferOptionsForContainer(list.id);
        const effectiveInfer = this.getInferOptionsForChild(
            list.id,
            itemSchema,
        );

        let containerSchema: ContainerSchemaType | undefined;
        let containerType: ContainerType | undefined;

        if (itemSchema && isContainerSchema(itemSchema)) {
            containerSchema = itemSchema;
            containerType = schemaToContainerType(itemSchema);
        } else {
            containerType = tryInferContainerType(item, effectiveInfer);
        }

        if (
            containerType &&
            (!containerSchema || isValueOfContainerType(containerType, item))
        ) {
            const childInfer = containerSchema
                ? undefined
                : effectiveInfer || baseInfer;
            this.insertContainerIntoList(
                list,
                containerSchema,
                index,
                item,
                childInfer,
            );
            return;
        }

        // Default to simple insert
        list.insert(index, applyEncode(itemSchema, item));
    }

    /**
     * Subscribe to state changes
     */
    subscribe(callback: SubscriberCallback<InferType<S>>): () => void {
        this.subscribers.add(callback);

        // Return unsubscribe function
        return () => {
            this.subscribers.delete(callback);
        };
    }

    /**
     * Notify all subscribers of state change
     * @param source The source channel for the sync operation
     * @param tags Optional tags associated with this update
     */
    private notifySubscribers(source: UpdateSource, tags?: string[]) {
        const metadata: UpdateMetadata = {
            source,
            tags,
        };

        for (const subscriber of this.subscribers) {
            subscriber(this.state, metadata);
        }
    }

    /** Path resolver context for EphemeralPatchManager */
    private get ephemeralCtx(): PathResolverContext {
        return {
            doc: this.doc,
            decodeField: (containerId, key, value) => {
                const fieldSchema = this.getSchemaForChild(containerId, key);
                return applyDecode(fieldSchema, value);
            },
        };
    }

    /**
     * Compose state by overlaying ephemeral patches on top of base state.
     * If no ephemeral manager or no patches, returns base unchanged.
     */
    private composeState(base: InferType<S>): InferType<S> {
        if (!this.ephemeralManager) return base;
        return this.ephemeralManager.compose(base, this.ephemeralCtx);
    }

    private applyEphemeralDeltas(
        deltas: readonly EphemeralPatchDelta[],
        state: InferType<S> = this.state,
    ): InferType<S> {
        if (!this.ephemeralManager || deltas.length === 0) return state;
        return this.ephemeralManager.applyDelta(
            state,
            this.baseState,
            deltas,
            this.ephemeralCtx,
        );
    }

    private withSuppressedLocalEphemeralEvents<T>(callback: () => T): T {
        this.suppressLocalEphemeralEvents += 1;
        try {
            return callback();
        } finally {
            this.suppressLocalEphemeralEvents -= 1;
        }
    }

    /**
     * Handle events from the EphemeralStore (both local and remote)
     */
    private handleEphemeralEvent = (event: EphemeralStoreChangeEvent) => {
        if (this.syncing) return;
        if (event.by === "local" && this.suppressLocalEphemeralEvents > 0) {
            return;
        }
        this.state = this.applyEphemeralDeltas(event.deltas);
        this.notifySubscribers(UpdateSource.EPHEMERAL);
    };

    /**
     * Immediately commit all pending ephemeral patches to LoroDoc.
     *
     * Call this when the temporary operation ends (e.g. on `mouseup` after a drag)
     * to flush ephemeral values into permanent LoroDoc history without waiting for
     * the debounced timeout.
     *
     * Only values that still match what this peer last wrote to the EphemeralStore
     * are committed. Values overwritten by a remote peer are skipped.
     *
     * After finalization, the EphemeralStore patches are cleaned up and the
     * debounce timer is cancelled.
     *
     * No-op if there are no pending local ephemeral patches.
     */
    finalizeEphemeralPatches(): void {
        if (!this.ephemeralManager || !this.ephemeralManager.hasLocalPatches)
            return;

        this.syncing = true;
        this.retaggedUnionMaps.clear();
        try {
            const localEvent = this.captureLocalDocEvent(() => {
                this.ephemeralManager?.finalize(this.doc);
            });
            if (localEvent) {
                const filtered = this.filterIgnoredEvents(localEvent);
                if (filtered.events.length > 0) {
                    this.registerContainersFromLoroEvent(filtered);
                    const routed = this.routeUnionEvents(filtered);
                    const normalized = this.normalizeLoroEventBatch(
                        routed.batch,
                    );
                    this.baseState = this.applyNormalizedLoroEventToState(
                        this.baseState,
                        normalized,
                        routed.reproject,
                    );
                }
            }
            this.state = this.composeState(this.baseState);
            this.notifySubscribers(UpdateSource.MIRROR);
        } finally {
            this.syncing = false;
        }
    }

    /**
     * Clean up resources
     */
    dispose() {
        // Clean up ephemeral resources
        this.ephemeralManager?.dispose();

        this.subscribers.clear();
        this.subscriptions.forEach((x) => {
            x();
        });
        this.subscriptions.length = 0;
    }

    /**
     * Attaches a detached container to a map
     *
     * If the schema is provided, the container will be registered with the schema
     */
    private insertContainerIntoMap(
        map: LoroMap,
        schema: ContainerSchemaType | undefined,
        key: string,
        value: unknown,
        childInferOptions?: InferContainerOptions,
    ) {
        const infer = this.getInferOptionsForMapChild(
            map.id,
            childInferOptions,
        );
        let insertedContainer: Container | undefined;
        if (infer?.mergeableMapChildContainers) {
            const containerType = this.getContainerTypeForInsert(
                schema,
                value,
                infer,
            );
            insertedContainer = this.insertMergeableContainerIntoMap(
                map,
                key,
                containerType,
            );
        } else {
            const [detachedContainer] = this.createContainerFromSchema(
                schema,
                value,
                infer,
            );
            insertedContainer = map.setContainer(key, detachedContainer);
        }

        if (!insertedContainer) {
            throw new Error("Failed to insert container into map");
        }

        if (!schema && infer) {
            this.inferOptionsByContainerId.set(insertedContainer.id, infer);
        }

        this.registerContainerHandle(insertedContainer, schema, {
            value,
            force: this.mustReregister(insertedContainer, schema),
        });

        if (infer?.mergeableMapChildContainers) {
            this.updateTopLevelContainer(insertedContainer, value);
        } else {
            this.initializeContainer(insertedContainer, schema, value);
        }
        // Stamp $cid for child maps directly on the provided value (pending state)
        if (insertedContainer.kind() === "Map") {
            this.stampCid(value, insertedContainer.id);
        }
        return insertedContainer;
    }

    private insertMergeableContainerIntoMap(
        map: LoroMap,
        key: string,
        containerType: ContainerType,
    ): Container {
        const existing = map.get(key);
        if (isContainer(existing) && existing.kind() === containerType) {
            return existing;
        }

        if (existing !== undefined) {
            map.delete(key);
        }

        switch (containerType) {
            case "Map":
                return map.ensureMergeableMap(key);
            case "List":
                return map.ensureMergeableList(key);
            case "MovableList":
                return map.ensureMergeableMovableList(key);
            case "Text":
                return map.ensureMergeableText(key);
            case "Tree":
                return map.ensureMergeableTree(key);
            default:
                throw new Error(
                    `Unsupported mergeable map child container type: ${containerType}`,
                );
        }
    }

    /**
     * Once a container has been created, and attached to its parent
     *
     * We initialize the inner values using the schema that we previously registered.
     */
    private initializeContainer(
        container: Container,
        schema: ContainerSchemaType | undefined,
        value: unknown,
    ) {
        let discriminant: string | undefined;
        if (schema && isLoroUnionSchema(schema)) {
            const resolved = this.getContainerSchema(container.id);
            if (!resolved) {
                throw new Error(
                    `Cannot initialize unknown union variant in ${container.id}`,
                );
            }
            discriminant = schema.discriminant;
            schema = resolved;
        }
        const kind = container.kind();
        if (kind === "Map") {
            const map = container as LoroMap;
            if (!isObject(value)) {
                return;
            }
            const mapSchema = schema?.type === "loro-map" ? schema : undefined;
            const baseInfer = this.getInferOptionsForContainer(map.id);
            for (const [key, val] of Object.entries(value)) {
                // Skip injected CID field
                if (key === CID_KEY) continue;
                // Skip undefined values - treat them as non-existent fields
                if (val === undefined) continue;
                if (key === discriminant) {
                    // The tag is raw: never through a field or catchall schema.
                    map.set(key, val as Value);
                    continue;
                }
                if (mapSchema) {
                    const fieldSchema = getMapFieldSchema(mapSchema, key);

                    if (fieldSchema?.type === "any") {
                        const infer = this.getInferOptionsForChild(
                            map.id,
                            fieldSchema,
                        );
                        const ct = tryInferContainerType(val, infer);
                        if (ct) {
                            this.insertContainerIntoMap(
                                map,
                                undefined,
                                key,
                                val,
                                infer,
                            );
                        } else {
                            map.set(key, val);
                        }
                        continue;
                    }

                    if (fieldSchema && isContainerSchema(fieldSchema)) {
                        const ct = schemaToContainerType(fieldSchema);
                        if (ct && isValueOfContainerType(ct, val)) {
                            this.insertContainerIntoMap(
                                map,
                                fieldSchema,
                                key,
                                val,
                            );
                        } else {
                            // Schema says container but value doesn't match - fall back to primitive
                            map.set(key, applyEncode(fieldSchema, val));
                        }
                        continue;
                    }

                    // Primitive schema - encode value before storing
                    map.set(key, applyEncode(fieldSchema, val));
                    continue;
                }

                const ct = tryInferContainerType(val, baseInfer);
                if (ct) {
                    this.insertContainerIntoMap(
                        map,
                        undefined,
                        key,
                        val,
                        baseInfer,
                    );
                } else {
                    map.set(key, val);
                }
            }
        } else if (kind === "List" || kind === "MovableList") {
            const list = container as LoroList | LoroMovableList;
            if (!Array.isArray(value)) {
                return;
            }

            const itemSchema = (
                schema as LoroListSchema<SchemaType> | undefined
            )?.itemSchema;

            const baseInfer = this.getInferOptionsForContainer(list.id);
            const isListItemContainer = isContainerSchema(itemSchema);

            for (let i = 0; i < value.length; i++) {
                const item = value[i];

                if (itemSchema?.type === "any") {
                    const infer =
                        applySchemaToInferOptions(itemSchema, baseInfer) ||
                        baseInfer;
                    const ct = tryInferContainerType(item, infer);
                    if (ct) {
                        this.insertContainerIntoList(
                            list,
                            undefined,
                            i,
                            item,
                            infer,
                        );
                    } else {
                        list.insert(i, item);
                    }
                    continue;
                }

                if (isListItemContainer) {
                    const ct = schemaToContainerType(itemSchema);
                    if (ct && isValueOfContainerType(ct, item)) {
                        this.insertContainerIntoList(list, itemSchema, i, item);
                    } else {
                        list.insert(i, applyEncode(itemSchema, item));
                    }
                    continue;
                }

                if (!itemSchema) {
                    const ct = tryInferContainerType(item, baseInfer);
                    if (ct) {
                        this.insertContainerIntoList(
                            list,
                            undefined,
                            i,
                            item,
                            baseInfer,
                        );
                    } else {
                        list.insert(i, item);
                    }
                    continue;
                }

                list.insert(i, applyEncode(itemSchema, item));
            }
        } else if (kind === "Text") {
            const text = container as LoroText;
            if (typeof value === "string") {
                text.update(value);
            }
        } else if (kind === "Tree") {
            const tree = container as LoroTree;
            this.updateTreeContainer(tree, value);
        } else {
            throw new Error(`Unknown container kind: ${kind}`);
        }
    }

    /**
     * Resolve the container type for an insert without allocating a detached container.
     */
    private getContainerTypeForInsert(
        schema: ContainerSchemaType | undefined,
        value: unknown,
        inferOptions?: InferContainerOptions,
    ): ContainerType {
        const containerType = schema
            ? schemaToContainerType(schema)
            : tryInferContainerType(value, inferOptions);

        if (!containerType) {
            throw new Error(`Unknown schema type: ${containerType}`);
        }

        return containerType;
    }

    /**
     * Create a new detached container based on a given schema.
     *
     * If the schema is undefined, we infer the container type from the value.
     */
    private createContainerFromSchema(
        schema: ContainerSchemaType | undefined,
        value: unknown,
        inferOptions?: InferContainerOptions,
    ): [Container, ContainerType] {
        const containerType = this.getContainerTypeForInsert(
            schema,
            value,
            inferOptions,
        );

        switch (containerType) {
            case "Map":
                return [new LoroMap(), "Map"];
            case "List":
                return [new LoroList(), "List"];
            case "MovableList":
                return [new LoroMovableList(), "MovableList"];
            case "Text":
                return [new LoroText(), "Text"];
            case "Tree":
                return [new LoroTree(), "Tree"];
            default:
                throw new Error(`Unknown schema type: ${containerType}`);
        }
    }

    /**
     * Attaches a detached container to a list
     *
     * If the schema is provided, the container will be registered with the schema
     */
    private insertContainerIntoList(
        list: LoroList | LoroMovableList,
        schema: ContainerSchemaType | undefined,
        index: number,
        value: unknown,
        childInferOptions?: InferContainerOptions,
    ) {
        const infer =
            childInferOptions ||
            (!schema ? this.getInferOptionsForContainer(list.id) : undefined);
        const [detachedContainer, _containerType] =
            this.createContainerFromSchema(schema, value, infer);
        let insertedContainer: Container | undefined;

        if (index === undefined) {
            insertedContainer = list.pushContainer(detachedContainer);
        } else {
            insertedContainer = list.insertContainer(index, detachedContainer);
        }

        if (!insertedContainer) {
            throw new Error("Failed to insert container into list");
        }

        if (!schema && infer) {
            this.inferOptionsByContainerId.set(insertedContainer.id, infer);
        }

        this.registerContainerHandle(insertedContainer, schema, {
            value,
            force: this.mustReregister(insertedContainer, schema),
        });

        this.initializeContainer(insertedContainer, schema, value);
        // Stamp $cid for list item maps directly on the provided value (pending state)
        if (insertedContainer.kind() === "Map") {
            this.stampCid(value, insertedContainer.id);
        }
        return insertedContainer;
    }

    /**
     * Update a Tree container using existing tree diff to generate precise create/move/delete
     * and nested node.data changes, then apply via container change appliers.
     */
    private updateTreeContainer(tree: LoroTree, value: unknown) {
        if (!Array.isArray(value)) {
            throw new Error("Tree value must be an array of nodes");
        }

        // Normalize current tree JSON from Loro to Mirror node shape
        const current: unknown[] = normalizeTreeJsonForMirror(tree.toJSON());
        const next: unknown[] = value as unknown[];

        // Optional schema to enable nested node.data diffs
        const parentSchema = this.getContainerSchema(tree.id);
        const treeSchema =
            parentSchema && isLoroTreeSchema(parentSchema)
                ? parentSchema
                : undefined;

        // Compute changes
        const changes = diffTree(
            this.doc,
            current,
            next,
            tree.id,
            treeSchema,
            this.options?.inferOptions,
        );

        if (changes.length === 0) return;

        // Group changes by container; apply tree ops first, then nested containers.
        // The order here matters for trees: child creates may depend on a parent's freshly
        // assigned ID (filled via `onCreate`), so we must apply creates in order.
        const grouped = new Map<ContainerID | "", Change[]>();
        for (const ch of changes) {
            const cid = ch.container;
            const arr = grouped.get(cid);
            if (arr) arr.push(ch);
            else grouped.set(cid, [ch]);
        }

        // Apply structural tree changes on the target tree first
        const treeGroup = grouped.get(tree.id);
        if (treeGroup && treeGroup.length) {
            this.applyContainerChanges(tree, treeGroup);
            grouped.delete(tree.id);
        }

        // Apply nested container changes (e.g., node.data maps)
        for (const [cid, group] of grouped) {
            if (cid === "") continue;
            const container = this.doc.getContainerById(cid);
            if (!container || group.length === 0) continue;
            this.applyContainerChanges(container, group);
        }
    }

    /**
     * Update a Map container
     */
    private updateMapContainer(map: LoroMap, value: unknown) {
        // Replace entire map
        if (!isObject(value)) {
            throw new Error("Map value must be an object");
        }

        // Schema for this container (optional)
        const schema = this.getContainerSchema(map.id);

        // Stamp $cid on the pending value
        if (schema && isObject(value)) {
            defineCidProperty(value, map.id);
        }

        // Get current keys
        const currentKeys = new Set(map.keys());

        // Process each field in the new value
        for (const [key, val] of Object.entries(value)) {
            if (key === CID_KEY) continue; // Skip CID
            // Treat explicit undefined the same as an absent key. This avoids
            // writing Loro nulls when updating newly ensured mergeable maps.
            if (val === undefined) continue;
            if (this.isUnionDiscriminant(map.id, key)) {
                // The tag is raw: never through a field or catchall schema.
                map.set(key, val as Value);
            } else if (schema && schema.type === "loro-map") {
                this.updateMapEntry(map, key, val, schema);
            } else {
                // Infer whether this is a container
                const infer = this.getInferOptionsForContainer(map.id);
                const ct = tryInferContainerType(val, infer);
                if (ct) {
                    // No child schema; insert with inferred container type
                    this.insertContainerIntoMap(
                        map,
                        undefined,
                        key,
                        val,
                        infer,
                    );
                } else {
                    map.set(key, val);
                }
            }
            currentKeys.delete(key);
        }

        // Delete keys that are no longer present
        for (const key of currentKeys) {
            map.delete(key);
        }
    }

    /**
     * Switch a union map to another variant in place (same container, same $cid):
     * re-register under the variant resolved from the pending value, write the
     * tag, delete every doc key the new value lacks (including strays the state
     * never showed), then write each key under the new variant. A same-kind child
     * is kept and reconciled; a different-kind child is recreated. A re-ensured
     * mergeable child revives its old contents, so every write is a full
     * reconcile.
     */
    private applyUnionSwitch(map: LoroMap, value: Record<string, unknown>) {
        const union = this.containerRegistry.get(map.id)?.union;
        if (!union) {
            throw new Error(
                `union-switch on a container not registered as a union: ${map.id}`,
            );
        }
        this.registerContainerHandle(map, union, {
            value,
            force: true,
            scanNested: false,
        });
        this.retaggedUnionMaps.add(map.id);
        const variant = this.getContainerSchema(map.id);
        if (!variant || !isLoroMapSchema(variant)) {
            throw new Error(`union-switch to an unknown variant in ${map.id}`);
        }

        map.set(union.discriminant, value[union.discriminant] as Value);
        for (const key of map.keys()) {
            if (key === union.discriminant) continue;
            // Ignore fields are memory-only: never leave their data in the doc.
            if (
                value[key] === undefined ||
                getMapFieldSchema(variant, key)?.type === "ignore"
            ) {
                map.delete(key);
            }
        }
        for (const [key, val] of Object.entries(value)) {
            if (
                key === CID_KEY ||
                key === union.discriminant ||
                val === undefined
            ) {
                continue;
            }
            const fieldSchema = getMapFieldSchema(variant, key);
            const existing = map.get(key);
            const kind =
                fieldSchema && isContainerSchema(fieldSchema)
                    ? schemaToContainerType(fieldSchema)
                    : undefined;
            if (
                kind &&
                isContainer(existing) &&
                existing.kind() === kind &&
                isValueOfContainerType(kind, val)
            ) {
                this.registerContainerHandle(
                    existing,
                    fieldSchema as ContainerSchemaType,
                    { value: val, force: true },
                );
                this.updateTopLevelContainer(existing, val);
                continue;
            }
            this.updateMapEntry(map, key, val, variant);
        }
        defineCidProperty(value, map.id);
    }

    /**
     * Helper to update a single entry in a map
     */
    private updateMapEntry(
        map: LoroMap,
        key: string,
        value: unknown,
        schema: SchemaType | null,
    ) {
        if (key === CID_KEY) return; // Ignore CID in writes
        if (this.isUnionDiscriminant(map.id, key)) {
            // The tag is raw: never through a field or catchall schema.
            map.set(key, value as Value);
            return;
        }
        // Check if this field should be a container according to schema
        const mapSchema = schema?.type === "loro-map" ? schema : null;
        if (mapSchema) {
            const fieldSchema = getMapFieldSchema(mapSchema, key);
            if (fieldSchema && fieldSchema.type === "ignore") {
                // Skip ignore fields: they live only in mirrored state
                return;
            }
            if (fieldSchema?.type === "any") {
                const infer = this.getInferOptionsForChild(map.id, fieldSchema);
                const ct = tryInferContainerType(value, infer);
                if (ct) {
                    this.insertContainerIntoMap(
                        map,
                        undefined,
                        key,
                        value,
                        infer,
                    );
                    return;
                }
            }
            if (fieldSchema && isContainerSchema(fieldSchema)) {
                const ct = schemaToContainerType(fieldSchema);
                if (ct && isValueOfContainerType(ct, value)) {
                    this.insertContainerIntoMap(map, fieldSchema, key, value);
                    return; // Avoid overwriting the inserted container
                }
            }

            // Primitive schema (possibly with transform) — encode and set
            map.set(key, applyEncode(fieldSchema, value));
            return;
        }

        // Default to simple set (no schema available)
        map.set(key, value);
    }

    /**
     * Get current state
     */
    getState(): InferType<S> {
        return this.state;
    }

    private applyLocalLoroChanges(
        changes: Change[],
        pendingState: InferType<S>,
        options?: SetStateOptions,
    ): boolean {
        let localEvent: LoroEventBatch | undefined;
        this.syncing = true;
        this.retaggedUnionMaps.clear();
        try {
            localEvent = this.captureLocalDocEvent(() => {
                this.applyChangesToLoro(changes, pendingState, options);
            });
        } finally {
            this.syncing = false;
        }

        if (!localEvent) {
            return false;
        }

        const filtered = this.filterIgnoredEvents(localEvent);
        if (filtered.events.length === 0) {
            // Nothing applicable (shouldn't happen — the diff never emits
            // changes for Ignore fields). Fall back to a full snapshot so
            // state stays consistent either way.
            this.baseState = this.rebuildBaseState();
            this.state = this.composeState(this.baseState);
            return true;
        }

        this.registerContainersFromLoroEvent(filtered);
        const routed = this.routeUnionEvents(filtered);
        const normalized = this.normalizeLoroEventBatch(routed.batch);
        this.baseState = this.applyNormalizedLoroEventToState(
            this.baseState,
            normalized,
            routed.reproject,
        );
        this.state = this.applyNormalizedLoroEventToState(
            this.state,
            normalized,
            routed.reproject,
        );
        return true;
    }

    /**
     * @internal
     * Advanced ephemeral hot path. Prefer `setState` for the public API surface.
     */
    private patchEphemeral(
        containerId: ContainerID,
        key: string,
        value: string | number | boolean | null,
        options?: Pick<SetStateOptions, "finalizeTimeout" | "tags">,
    ): void {
        if (this.syncing) return;
        if (!this.ephemeralManager) {
            throw new Error("patchEphemeral requires an ephemeralStore");
        }

        const change: Change = {
            container: containerId,
            key,
            value,
            kind: "set",
        };
        if (!this.ephemeralManager.isEligible(change, this.doc)) {
            throw new Error(
                "patchEphemeral only supports primitive values on existing LoroMap keys",
            );
        }

        const deltas = this.withSuppressedLocalEphemeralEvents(
            () =>
                this.ephemeralManager?.writeValue(containerId, key, value) ??
                [],
        );
        if (deltas.length === 0) return;

        this.ephemeralManager.scheduleFinalizeAfter(
            options?.finalizeTimeout,
            () => {
                this.finalizeEphemeralPatches();
            },
        );
        this.state = this.applyEphemeralDeltas(deltas);

        const tags = options?.tags
            ? Array.isArray(options.tags)
                ? options.tags
                : [options.tags]
            : undefined;
        this.notifySubscribers(UpdateSource.MIRROR, tags);
    }

    /**
     * Update state and propagate changes.
     *
     * `updater` may be:
     * - An **object** — shallow-merged into the current state.
     * - A **function** — receives a mutable Immer draft (mutate in place)
     *   or returns a new immutable state object.
     *
     * ---
     *
     * ### Behavior depends on `ephemeralStore` configuration
     *
     * **Without `ephemeralStore`** (default) — all changes are written to
     * LoroDoc synchronously. This is the standard path for persistent edits.
     *
     * **With `ephemeralStore`** — Mirror diffs the new state against the
     * current composed state (`LoroDoc + EphemeralStore overlay`) and
     * classifies each change automatically:
     *
     * | Condition | Destination |
     * |---|---|
     * | Primitive value (`string`, `number`, `boolean`, `null`) on an **existing key** of an **existing LoroMap** | → `EphemeralStore` (no LoroDoc write) |
     * | Everything else (new keys, new containers, list/text/tree ops) | → `LoroDoc` directly |
     *
     * This means a single `setState` call can write some changes to
     * EphemeralStore and others to LoroDoc in the same invocation.
     *
     * Ephemeral values are committed to LoroDoc when:
     * 1. The {@link SetStateOptions.finalizeTimeout | finalizeTimeout}
     *    expires (default 50 000 ms), or
     * 2. You call {@link finalizeEphemeralPatches} manually (e.g. on `mouseup`).
     *
     * The debounce timer resets on each `setState` call that produces
     * ephemeral changes, so it only fires after the user stops updating.
     *
     * @example
     * ```ts
     * // Without ephemeralStore — writes directly to LoroDoc
     * mirror.setState((s) => { s.count = 1; });
     *
     * // With ephemeralStore — x/y go to EphemeralStore, push goes to LoroDoc
     * mirror.setState(
     *     (s) => {
     *         s.items[0].x = e.clientX;   // → EphemeralStore (primitive on existing key)
     *         s.items[0].y = e.clientY;   // → EphemeralStore
     *         s.items.push({ x: 0, y: 0, name: "new" }); // → LoroDoc (structural change)
     *     },
     *     { finalizeTimeout: 1_000 },
     * );
     * ```
     */
    setState(
        updater: (state: Readonly<InferInputType<S>>) => InferInputType<S>,
        options?: SetStateOptions,
    ): void;
    setState(
        updater: (state: InferType<S>) => void,
        options?: SetStateOptions,
    ): void;
    setState(
        updater: Partial<InferInputType<S>>,
        options?: SetStateOptions,
    ): void;
    setState(
        updater:
            | ((state: InferType<S>) => InferType<S> | InferInputType<S> | void)
            | ((state: Readonly<InferInputType<S>>) => InferInputType<S>)
            | Partial<InferInputType<S>>,
        options?: SetStateOptions,
    ): void {
        if (this.syncing) return; // Prevent recursive updates

        // Calculate new state; support mutative or return-based updater via Immer
        const newState =
            typeof updater === "function"
                ? produce<InferType<S>>(this.state, (draft) => {
                      const res = (
                          updater as (
                              state: InferType<S>,
                          ) => InferType<S> | void
                      )(draft as InferType<S>);
                      if (res && res !== (draft as unknown)) {
                          return res as unknown as typeof draft;
                      }
                  })
                : (Object.assign(
                      {},
                      this.state as unknown as Record<string, unknown>,
                      updater as Record<string, unknown>,
                  ) as InferType<S>);

        // Immer's strict shallow copy keeps `$cid` but drops its read-only flags; restore
        // them before anything else observes the new state.
        hardenCidDescriptors(newState, this.state);

        // Validate state if needed
        if (this.options.validateUpdates) {
            const validation =
                this.schema &&
                validateSchema(this.schema, newState, {
                    ignoreUnknownProperties:
                        this.options.ignoreUnknownProperties,
                });
            if (validation && !validation.valid) {
                const errorMessage = `State validation failed: ${validation.errors?.join(
                    ", ",
                )}`;
                throw new Error(errorMessage);
            }
        }

        // Extract tags for this update
        const tags = options?.tags
            ? Array.isArray(options.tags)
                ? options.tags
                : [options.tags]
            : undefined;

        if (this.ephemeralManager) {
            // Route changes through ephemeral classification
            const changes = diffContainer(
                this.doc,
                this.state,
                newState,
                "",
                this.schema,
                this.options?.inferOptions,
            );

            const ephemeralChanges: EphemeralEligibleChange[] = [];
            const loroChanges: Change[] = [];
            for (const change of changes) {
                if (this.ephemeralManager.isEligible(change, this.doc)) {
                    ephemeralChanges.push(change);
                } else {
                    loroChanges.push(change);
                }
            }

            // Apply non-ephemeral changes directly to LoroDoc
            if (loroChanges.length > 0) {
                const appliedIncrementally = this.applyLocalLoroChanges(
                    loroChanges,
                    newState,
                    options,
                );
                if (!appliedIncrementally) {
                    this.baseState = this.rebuildBaseState();
                    this.state = this.composeState(this.baseState);
                }
            }

            // Write ephemeral-eligible changes to EphemeralStore
            if (ephemeralChanges.length > 0) {
                const deltas = this.withSuppressedLocalEphemeralEvents(
                    () =>
                        this.ephemeralManager?.writeChanges(ephemeralChanges) ??
                        [],
                );
                // Schedule debounced finalization
                this.ephemeralManager.scheduleFinalizeAfter(
                    options?.finalizeTimeout,
                    () => {
                        this.finalizeEphemeralPatches();
                    },
                );
                this.state = this.applyEphemeralDeltas(deltas);
            }
        } else {
            // No ephemeral store — apply everything to LoroDoc
            this.updateLoro(newState, options);
            this.baseState = stripUndefined(newState);
            this.state = this.composeState(this.baseState);

            if (this.options.checkStateConsistency) {
                this.checkStateConsistency();
            }
        }

        // Notify subscribers
        this.notifySubscribers(UpdateSource.MIRROR, tags);
    }

    checkStateConsistency() {
        // Compare baseState (doc-only + Ignore) against a fresh doc snapshot.
        // Using this.state would include the ephemeral overlay and always diverge
        // when ephemeral patches are active.
        const base = this.baseState as unknown as Record<string, unknown>;
        const snapshot = this.buildRootStateSnapshot(base);
        this.preserveIgnoredComparisonValues(snapshot, base, this.schema);
        // `$cid` is non-enumerable, so `deepEqual` cannot see it; compare the markers
        // separately to catch a tampered or stale container id in the state.
        const valuesDiverged = !deepEqual(base, snapshot);
        const cidsDiverged = !cidsEqual(base, snapshot);
        if (valuesDiverged || cidsDiverged) {
            console.error(
                valuesDiverged
                    ? "State diverged"
                    : `State diverged ($cid mismatch; values are equal)`,
                safeStringify(base),
                safeStringify(snapshot),
            );
            throw new Error("[InternalError] State diverged");
        }
    }

    // The comparison snapshot owns these objects. Ignore is memory-only: neither
    // its document value nor its container identities participate in consistency.
    private preserveIgnoredComparisonValues(
        snapshot: unknown,
        base: unknown,
        schema: SchemaType | undefined,
    ): void {
        if (
            !schema ||
            !snapshot ||
            !base ||
            typeof snapshot !== "object" ||
            typeof base !== "object"
        )
            return;
        if (isLoroUnionSchema(schema)) {
            // Compare under the variant the memory state holds; a placeholder or
            // unknown tag has no Ignore fields to preserve.
            const tag = (base as Record<string, unknown>)[schema.discriminant];
            const variant = resolveUnionVariant(schema, tag);
            this.preserveIgnoredComparisonValues(snapshot, base, variant);
            return;
        }
        if (isLoroTreeSchema(schema)) {
            if (!Array.isArray(snapshot) || !Array.isArray(base)) return;
            for (let i = 0; i < snapshot.length; i++) {
                const node = snapshot[i] as Record<string, unknown> | undefined;
                const previous = base[i] as Record<string, unknown> | undefined;
                if (!node || !previous) continue;
                // Tree nodes wrap the schema-owned data in { id, data, children }.
                this.preserveIgnoredComparisonValues(
                    node.data,
                    previous.data,
                    schema.nodeSchema,
                );
                this.preserveIgnoredComparisonValues(
                    node.children,
                    previous.children,
                    schema,
                );
            }
            return;
        }
        const fresh = snapshot as Record<string, unknown>;
        const memory = base as Record<string, unknown>;
        for (const key of new Set([
            ...Object.keys(fresh),
            ...Object.keys(memory),
        ])) {
            const childSchema = getChildSchema(schema, key);
            if (childSchema?.type === "ignore") {
                if (Object.prototype.hasOwnProperty.call(memory, key)) {
                    Object.defineProperty(fresh, key, {
                        value: memory[key],
                        enumerable: true,
                        configurable: true,
                        writable: true,
                    });
                } else {
                    delete fresh[key];
                }
            } else {
                this.preserveIgnoredComparisonValues(
                    fresh[key],
                    memory[key],
                    childSchema,
                );
            }
        }
    }

    /**
     * Whether `key` of a known-variant union map is part of its projection: the
     * tag, or a declared (or catchall) non-Ignore field whose stored value matches
     * the declared kind. Anything else is a stray from a concurrent switch, or a
     * newer peer's field, and stays in the doc unseen.
     */
    private unionSlotIsReadable(
        entry: {
            union: AnyLoroUnionSchema;
            schema: ContainerSchemaType | undefined;
        },
        key: string,
        value: unknown,
    ): boolean {
        if (key === entry.union.discriminant) return true;
        if (!entry.schema || !isLoroMapSchema(entry.schema)) return false;
        const fieldSchema = getMapFieldSchema(entry.schema, key);
        if (!fieldSchema || fieldSchema.type === "ignore") return false;
        if (fieldSchema.type === "any") return true;
        const kind = schemaToContainerType(fieldSchema);
        return kind
            ? isContainer(value) && value.kind() === kind
            : !isContainer(value);
    }

    private containerToMirrorState(
        c: Container,
        options: RootSnapshotOptions = {},
    ): MirrorState {
        const kind = c.kind();
        const schema = this.getContainerSchema(c.id);
        if (kind === "Map") {
            const m = c as LoroMap;
            const unionEntry = this.containerRegistry.get(c.id);
            if (unionEntry?.union && !unionEntry.schema) {
                if (options.registerContainers)
                    this.registerNestedContainers(c);
                return makeUnknownVariantPlaceholder(
                    c.id,
                    m.get(unionEntry.union.discriminant),
                    normalizeContainerForJson(m) as Record<string, unknown>,
                ) as MirrorState;
            }
            const obj: MirrorStateObject = {};
            const childRegistrationContext = options.registerContainers
                ? this.getChildRegistrationContext(c)
                : undefined;
            defineCidProperty(obj, c.id);
            for (const k of m.keys()) {
                const v = m.get(k);
                if (
                    unionEntry?.union &&
                    !this.unionSlotIsReadable(
                        { union: unionEntry.union, schema: unionEntry.schema },
                        k,
                        v,
                    )
                ) {
                    continue;
                }
                if (isContainer(v)) {
                    if (childRegistrationContext) {
                        this.registerChildContainer(
                            c,
                            v,
                            k,
                            childRegistrationContext,
                            {
                                scanNested: false,
                            },
                        );
                    }
                    obj[k] = this.containerToMirrorState(v, options);
                } else {
                    // Decode primitive values using field schema (never the tag)
                    const fieldSchema =
                        unionEntry?.union && k === unionEntry.union.discriminant
                            ? undefined
                            : getChildSchema(schema, k);
                    obj[k] = applyDecode(fieldSchema, v) as MirrorState;
                }
            }
            return obj;
        } else if (kind === "List" || kind === "MovableList") {
            const arr: MirrorState[] = [];
            const l = c as unknown as LoroList | LoroMovableList;
            const len = l.length;
            const childRegistrationContext = options.registerContainers
                ? this.getChildRegistrationContext(c)
                : undefined;
            // Get item schema for decoding list items
            const itemSchema = getChildSchema(schema);
            for (let i = 0; i < len; i++) {
                const v = l.get(i);
                if (isContainer(v)) {
                    if (childRegistrationContext) {
                        this.registerChildContainer(
                            c,
                            v,
                            i,
                            childRegistrationContext,
                            {
                                scanNested: false,
                            },
                        );
                    }
                    arr.push(this.containerToMirrorState(v, options));
                } else {
                    // Decode primitive items using item schema
                    arr.push(applyDecode(itemSchema, v) as MirrorState);
                }
            }
            return arr;
        } else if (kind === "Text") {
            // LoroText toJSON returns a string
            return (c as LoroText).toJSON();
        } else if (kind === "Tree") {
            const t = c as LoroTree;
            if (options.registerContainers) {
                this.registerNestedContainers(c);
            }
            // Normalize via toJSON first
            const normalized = normalizeTreeJsonForMirror(t.toJSON());
            // Optionally inject $cid per node.data using an id->cid map from live nodes
            const schema = this.getContainerSchema(t.id);
            const withCid = schema && isLoroTreeSchema(schema);
            if (withCid) {
                const idToCid = new Map<string, string>();
                // Best-effort: collect from runtime nodes if API available
                const tMaybe = t as unknown as { getNodes?: () => unknown[] };
                const nodes: unknown[] = tMaybe.getNodes?.() ?? [];
                for (const raw of nodes) {
                    try {
                        const n = raw as { id?: unknown; data?: unknown };
                        const id = typeof n.id === "string" ? n.id : undefined;
                        let dataId: string | undefined;
                        if (n.data && typeof n.data === "object") {
                            const d = n.data as { id?: unknown };
                            dataId =
                                typeof d.id === "string" ? d.id : undefined;
                        }
                        if (id && dataId) idToCid.set(id, dataId);
                    } catch {
                        // ignore
                    }
                }
                const stamp = (arr: unknown[]) => {
                    for (const node of arr) {
                        const n = node as {
                            id: unknown;
                            data?: unknown;
                            children?: unknown;
                        };
                        const cid =
                            typeof n.id === "string"
                                ? idToCid.get(n.id)
                                : undefined;
                        if (cid) {
                            if (!n.data || typeof n.data !== "object") {
                                (n as { data: Record<string, unknown> }).data =
                                    {};
                            }
                            defineCidProperty(n.data, cid as ContainerID);
                        }
                        if (Array.isArray(n.children))
                            stamp(n.children as unknown[]);
                    }
                };
                stamp(normalized);
                decodeNestedJsonValues(normalized, schema);
            }
            return normalized as unknown as MirrorState;
        }
        // Fallback
        return c.toJSON();
    }

    /**
     * Build a state snapshot from LoroDoc.
     * When `prevState` is provided, Ignore fields are preserved from it
     * (they only exist in memory and are not backed by LoroDoc).
     */
    private rebuildBaseState(): InferType<S> {
        return this.buildRootStateSnapshot(
            this.baseState as Record<string, unknown>,
        ) as InferType<S>;
    }

    /**
     * Build a fresh state snapshot from the LoroDoc.
     *
     * When `prevState` is provided, Ignore fields are preserved from it
     * (they only exist in memory and are not backed by LoroDoc).
     */
    private buildRootStateSnapshot(
        prevState?: Record<string, unknown>,
        options: RootSnapshotOptions = {},
    ): Record<string, unknown> {
        if (!this.schema || this.schema.type !== "schema") {
            // Fallback to previous normalization if no schema
            return toNormalizedJson(this.doc) as Record<string, unknown>;
        }

        const root: Record<string, unknown> = {};
        const rootSchema = this.schema as RootSchemaType<
            Record<string, RootContainerSchemaType>
        >;
        for (const key in rootSchema.definition) {
            const fieldSchema = rootSchema.definition[key];
            // Preserve Ignore fields from previous state — they are memory-only
            if ((fieldSchema as { type: string }).type === "ignore") {
                if (prevState && key in prevState) {
                    root[key] = prevState[key];
                }
                continue;
            }
            const containerType = schemaToContainerType(fieldSchema);
            if (!containerType) continue;
            const container = getRootContainerByType(
                this.doc,
                key,
                containerType,
            );
            // Always include maps to expose $cid for stable identity
            if (containerType === "Map") {
                root[key] = this.containerToMirrorState(container, options);
            } else if (
                containerType === "List" ||
                containerType === "MovableList"
            ) {
                // Always include lists, even if empty, to match Mirror's state shape
                root[key] = this.containerToMirrorState(container, options);
            } else if (containerType === "Text") {
                // Always include text, even if empty, to match Mirror's state shape
                root[key] = this.containerToMirrorState(container, options);
            } else if (containerType === "Tree") {
                const arr = this.containerToMirrorState(
                    container,
                    options,
                ) as unknown[];
                if (!Array.isArray(arr) || arr.length === 0) continue;
                root[key] = arr;
            } else {
                root[key] = this.containerToMirrorState(container, options);
            }
        }

        // With ignoreUnknownProperties, also mirror doc root keys the schema
        // does not declare (e.g. written by peers on a newer schema version),
        // so state stays consistent with the incremental event path — which
        // always applies them — instead of deleting them on the next write.
        if (this.options.ignoreUnknownProperties) {
            // LoroDoc roots are always containers, so this returns only
            // root key -> container id without descending into their values.
            const shallowDocState = this.doc.getShallowValue();
            for (const [key, containerId] of Object.entries(shallowDocState)) {
                if (
                    Object.prototype.hasOwnProperty.call(
                        rootSchema.definition,
                        key,
                    )
                ) {
                    continue;
                }

                const container = this.doc.getContainerById(containerId);
                if (!container) {
                    // Match toNormalizedJson's error for an unresolved container
                    // id so this optimization does not hide a corrupt or
                    // inconsistent document state.
                    throw new Error(`ContainerID not found: ${containerId}`);
                }
                root[key] = normalizeContainerForJson(container);
            }
        }
        return root;
    }

    /**
     * Register a container schema
     */
    private registerContainerWithRegistry(
        containerId: ContainerID,
        schemaType: ContainerSchemaType | undefined,
    ) {
        this.containerRegistry.set(containerId, {
            schema: schemaType,
            registered: true,
        });
    }

    private stampCid(target: unknown, cid: ContainerID) {
        if (!isObject(target)) return;
        defineCidProperty(target, cid);
    }

    private getInferOptionsForContainer(containerId: ContainerID | "") {
        if (containerId !== "") {
            const local = this.inferOptionsByContainerId.get(containerId);
            if (local) return local;
        }
        return this.options?.inferOptions || {};
    }

    private getInferOptionsForChild(
        parentId: ContainerID,
        childSchema: SchemaType | undefined,
    ) {
        const base = this.getInferOptionsForContainer(parentId);
        return applySchemaToInferOptions(childSchema, base) || base;
    }

    private getInferOptionsForMapChild(
        parentId: ContainerID,
        childInferOptions?: InferContainerOptions,
    ): InferContainerOptions {
        const base =
            childInferOptions || this.getInferOptionsForContainer(parentId);
        const parentSchema = this.getContainerSchema(parentId);
        if (!parentSchema || !isLoroMapSchema(parentSchema)) {
            return base;
        }

        const { mergeableMapChildContainers } = parentSchema.options;
        if (mergeableMapChildContainers === undefined) {
            return base;
        }

        return {
            ...base,
            mergeableMapChildContainers,
        };
    }

    private getContainerSchema(
        containerId: ContainerID,
    ): ContainerSchemaType | undefined {
        return this.containerRegistry.get(containerId)?.schema;
    }

    /**
     * Whether `key` is the discriminant of a union-registered map. The tag is
     * a raw string: it is never written or read through a field or catchall
     * schema.
     */
    private isUnionDiscriminant(
        containerId: ContainerID,
        key: string | number | undefined,
    ): boolean {
        const union = this.containerRegistry.get(containerId)?.union;
        return !!union && key === union.discriminant;
    }

    private getSchemaForChildContainer(
        containerId: ContainerID,
        childKey: string | number,
    ): ContainerSchemaType | undefined {
        if (this.isUnionDiscriminant(containerId, childKey)) return undefined;
        return getChildContainerSchema(
            this.getContainerSchema(containerId),
            childKey,
        );
    }

    private getSchemaForChild(
        containerId: ContainerID,
        childKey: string | number,
    ): SchemaType | undefined {
        if (this.isUnionDiscriminant(containerId, childKey)) return undefined;
        return getChildSchema(this.getContainerSchema(containerId), childKey);
    }

    /* Get all container IDs registered with the mirror */
    getContainerIds(): ContainerID[] {
        return Array.from(this.containerRegistry.keys());
    }
}

/**
 * Export the json of the doc with LoroTree containers normalized
 * @param doc
 * @returns
 */
export function toNormalizedJson(doc: LoroDoc): unknown {
    // Document shallow values contain only root ContainerIDs. Resolve those IDs,
    // then normalize through container APIs without sending returned JS values
    // back to wasm, so `cid:`-prefixed strings stay strings.
    const root: Record<string, unknown> = {};
    for (const [key, id] of Object.entries(doc.getShallowValue())) {
        const container = doc.getContainerById(id);
        if (!container) {
            throw new Error(`ContainerID not found: ${id}`);
        }
        root[key] = normalizeContainerForJson(container);
    }
    return root;
}

function normalizeContainerForJson(c: Container): unknown {
    const kind = c.kind();
    if (kind === "Tree") {
        return normalizeTreeJsonForMirror((c as LoroTree).toJSON());
    }
    if (kind === "Text") {
        return (c as LoroText).toJSON();
    }
    if (kind === "Map") {
        const m = c as LoroMap;
        const obj: Record<string, unknown> = {};
        for (const key of m.keys()) {
            if (key === CID_KEY) continue;
            const child = m.get(key);
            obj[key] = isContainer(child)
                ? normalizeContainerForJson(child)
                : child;
        }
        defineCidProperty(obj, m.id);
        return obj;
    }
    if (kind === "List" || kind === "MovableList") {
        const l = c as LoroList | LoroMovableList;
        const arr: unknown[] = [];
        for (let i = 0; i < l.length; i++) {
            const item = l.get(i);
            arr.push(
                isContainer(item) ? normalizeContainerForJson(item) : item,
            );
        }
        return arr;
    }
    // Fallback for any other container kind (e.g. Counter): use its JSON form.
    return (c as unknown as { toJSON(): unknown }).toJSON();
}

// Normalize a shallow object shape from provided initialState by converting
// container-like primitives to empty shapes without carrying data:
// - arrays -> []
// - strings -> ''
// - plain objects -> {}
// Other primitive types are passed through (number, boolean, null/undefined).
function normalizeInitialShapeShallow(
    input: Record<string, unknown>,
): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input)) {
        if (Array.isArray(value)) {
            out[key] = [];
        } else if (typeof value === "string") {
            out[key] = "";
        } else if (isObject(value)) {
            out[key] = {};
        } else {
            out[key] = value;
        }
    }
    return out;
}

function normalizeTreeJsonForMirror(input: unknown) {
    return normalizeTreeJson(input, {
        isTreeData: isObject,
        createEmptyData: () => ({}),
    });
}

// Deep merge initialState into a base state with awareness of the provided root schema.
// - Does not override values already present in base (doc/defaults take precedence)
// - For Ignore fields, copies values verbatim into in-memory state only
// - For container fields, fills missing keys with normalized empty shape when initialState hints at presence
// - For primitive fields, uses initial values if base lacks them
function mergeInitialIntoBaseWithSchema(
    base: Record<string, unknown>,
    init: Record<string, unknown>,
    rootSchema: RootSchemaType<Record<string, RootContainerSchemaType>>,
) {
    for (const [k, initVal] of Object.entries(init)) {
        const fieldSchema = rootSchema.definition[k];
        if (!fieldSchema) {
            // Unknown field at root: hint shape only
            if (!(k in base)) {
                if (Array.isArray(initVal)) base[k] = [];
                else if (typeof initVal === "string") base[k] = "";
                else if (isObject(initVal)) base[k] = {};
            }
            continue;
        }

        const t = fieldSchema.type as string;
        if (t === "ignore") {
            base[k] = initVal;
            continue;
        }
        if (t === "loro-map") {
            // Ensure object
            if (!(k in base) || !isObject(base[k])) base[k] = {};
            const nestedBase = base[k] as Record<string, unknown>;
            const nestedInit: Record<string, unknown> = isObject(initVal)
                ? initVal
                : {};
            const nestedSchema = fieldSchema as unknown as LoroMapSchema<
                Record<string, SchemaType>
            >; // actual types are not used at runtime
            // Recurse
            mergeInitialIntoBaseWithSchema(nestedBase, nestedInit, {
                type: "schema",
                definition: nestedSchema.definition as Record<
                    string,
                    ContainerSchemaType
                >,
                options: {},
                getContainerType() {
                    return "Map";
                },
            } as unknown as RootSchemaType<
                Record<string, RootContainerSchemaType>
            >);
            continue;
        }
        if (t === "loro-list" || t === "loro-movable-list") {
            if (!(k in base)) base[k] = [];
            continue;
        }
        if (t === "loro-text") {
            if (!(k in base)) base[k] = "";
            continue;
        }
        if (t === "string" || t === "number" || t === "boolean") {
            if (!(k in base)) base[k] = initVal;
            continue;
        }
    }
}
