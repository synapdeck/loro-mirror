# loro-mirror discriminated unions (`schema.Union`)

Sub-project 1 of the slideshow CRDT rework. Status: design approved in brainstorming 2026-10-08; spec awaiting review.

## Context

Synapdeck's note mirror (`packages/collab/src/schema.ts`) types every field instance as `schema.Any()`: `noteTypeFields: schema.LoroMapRecord(schema.Any())` and `adHocFields: schema.LoroMovableList(schema.Any(), f => f.id)`. Under `Any()` loro-mirror infers containers and diffs any inferred `LoroMovableList` by index (`diffMovableListByIndex`), so a reorder never emits a Loro `move` op. That blocks the slideshow rework (PRs #3199/#3203), which needs slide frames in a `LoroMovableList` keyed by frame id so drag-and-drop reorders merge with concurrent edits. loro-mirror 2.3.3 (latest) has no way to type a field instance more precisely than `Any()`, because field instances are a discriminated union and loro-mirror has no union schema.

Upstream PR loro-dev/loro-mirror#76 (branch `feat/discriminated-unions` in `~/loro-mirror`, the `synapdeck/loro-mirror` fork) added `schema.Union`, but a 2026-10-08 review found it unsuitable as a base:

- A variant switch of a union that is a map field or `LoroMapRecord` value throws `Unsupported change kind for map` (`diff.ts:1469` emits `set-container`; `mirror.ts:1337` rejects it).
- One unknown discriminant from a newer peer makes every later `setState` on the mirror throw.
- Child schemas are resolved from the doc's current tag rather than the value being written, so a child written before the tag is created with the old variant's container type (e.g. `frames` as `List`, not `MovableList`), permanently.
- "Replace the container on switch" degrades into an in-place merge under mergeable map child containers (#85), leaving chimera maps that validate.
- Unrelated scope that contradicts later `main` fixes: the constructor persists `initialState` into the doc, `$cid` becomes overwritable (against #88), and startup state construction is rewritten (against #86).
- It is 17 commits behind `main` with semantic conflicts against #85, #86, #88, #97 and #99.

Decision: rewrite on current `main` rather than rebase, reusing #76's type-level inference (`InferUnionType` and friends), builder and validator skeleton.

## Goals

- A `schema.Union` that loro-mirror can diff, apply and read for every parent kind Synapdeck needs, with real `move` ops for movable lists nested inside variants.
- One variant-switch semantic for every parent kind, compatible with mergeable map child containers and stable `$cid`s.
- Forward compatibility: a peer on a newer schema must never break an older client's mirror.
- Honest types: the inferred state type accounts for unknown variants without destroying discriminant narrowing.
- Upstream-acceptable quality and scope; usable by Synapdeck immediately via a scoped build.

## Non-goals

- Nested unions, or boolean/composite discriminants.
- Unions as root fields or as `LoroTree` node `data`.
- A "fields shared by all variants" feature (e.g. typing `id` on the unknown-variant placeholder).
- Changing loro-mirror's behavior when a peer leaves a known map missing a required field (pre-existing, not made worse here).
- Synapdeck integration (typed note-field schemas), the slideshow container representation, and the editor/presence rework. These are sub-projects 2–4.

## Process and distribution

- New branch `feat/union-schema` off `main` in `~/loro-mirror`; a new upstream PR. #76 is closed with a link to the new PR and a short note on why it was rewritten (switch semantics, mergeable containers).
- Synapdeck consumes the fork as a published scoped package `@synapdeck/loro-mirror` on the public npm registry (no auth needed, so Nix `pnpmDeps` fetching keeps working), wired in with a pnpm override `"loro-mirror": "npm:@synapdeck/loro-mirror@<version>"` so `loro-mirror-react` resolves to it too. Publishing and the override land with sub-project 2. An upstream bump is a rebase of the fork plus a release.
- This spec lives uncommitted in `~/slideshow-editor` and is committed with the first Synapdeck branch of the project.

## Design

### 1. Schema API and types

```ts
schema.Union(discriminant, variants, options?)

const Field = schema.Union("type", {
    text: schema.LoroMap({ isDerived: schema.Boolean(), value: schema.LoroText(), manualOverride: schema.LoroText() }),
    slideshow: schema.LoroMap({ isDerived: schema.Boolean(), slideshowData: Slideshow, manualOverride: Slideshow }),
});
```

- `discriminant` is a string key. Tag values are the keys of `variants`, so they are strings by construction.
- Each variant is a `LoroMap` schema, with or without `.catchall()`. A variant must not declare the discriminant key; the builder throws if one does. Nested unions are rejected.
- A variant keeps its own `LoroMap` options. `mergeableMapChildContainers` follows the usual precedence for a variant's children: the variant's own option, then the global `inferOptions`. No union-level mergeable option exists.
- Union options are the ordinary `SchemaOptions` (`required`, `defaultValue`, `description`, `validate`). There is no default variant; `getDefaultValue` returns `defaultValue` when given, otherwise `undefined`.
- The union's container type is `"Map"`.
- New exports: `LoroUnionSchema`, `isLoroUnionSchema`.

Types:

- `InferType<Union<D, V>>` is the union over each tag `K` of `{ [D]: K } & InferType<V[K]>` (including `$cid`), plus the unknown-variant placeholder:

  ```ts
  {
      [D]?: undefined;
      readonly $cid: string;
      readonly $unknownVariant: { readonly tag: string | null; readonly data: Readonly<Record<string, unknown>> };
  }
  ```

- `InferInputType` is the same with `$cid` optional.
- `$unknownVariant` becomes a reserved key alongside `$cid`.
- Verified with TypeScript 7.0.2 `--strict`: `switch (x.type)` narrows each literal variant and `case undefined` narrows to the placeholder; an exhaustive `never` check fails to compile until `case undefined` is handled. An open `{ type: string; [k: string]: unknown }` member, by contrast, defeats narrowing (`x.value` stays `unknown` after `x.type === "text"`), which is why the placeholder omits the discriminant.

### 2. Variant resolution (registry)

`main` looks up child schemas either by container id, through `containerRegistry` (event application, container writes), or by walking the static schema tree along a path (`diffMap`, `pathResolvesToIgnore`, event-path normalization, `containerToMirrorState`/`buildRootStateSnapshot`).

A union-typed map registers the concrete resolved variant `LoroMapSchema` in its registry entry, plus a back-pointer to its union. Registry-based lookups (about ten call sites) then see an ordinary map schema and need no change. A single function, `resolveUnionVariant(union, tag)`, is the only place a variant is chosen. It returns the variant schema, or "unknown" for an unknown, missing or non-string tag. Its inputs:

- Writes resolve from the **pending value** being written, never from the doc.
- Reads resolve from the **doc** (event delivery happens after import, so the doc holds the batch's final tag).

A union map with an unknown tag registers as unknown-variant; its children register without a schema, using inference.

### 3. Switch semantics

**Local switch (state → doc).** When `diffMap` or a list diff reaches a union-typed child and the old and new values are both map-shaped, it compares tags:

- Same known tag: diff normally against that variant's schema.
- Different tag, or old value is a placeholder and new value is a known variant: emit one new change kind, `union-switch`, targeting the child's **existing** `LoroMap` and carrying the new value. This holds for every parent kind (map field, `LoroMapRecord` value, `LoroList` with or without `idSelector`, `LoroMovableList`), so the item's container and `$cid` never change. Both the "replace the object" and "assign `draft.x.type`" styles produce it.

Applying `union-switch`:

1. Resolve the new variant from the pending value and re-register the map's registry entry to it.
2. Write the tag.
3. Delete every key **in the doc** that is not in the new value (not just keys in mirror state), so strays from an earlier concurrent switch cannot resurface later.
4. Write each key under the new variant's schema:
   - A child container of the same kind as the existing one is kept and reconciled to the new value.
   - A child of a different kind is deleted and recreated. Under mergeable children this is `main`'s existing `insertMergeableContainerIntoMap` delete-then-ensure path.
   - Every created or re-ensured child is reconciled to its full value through `updateTopLevelContainer`. This matters because re-ensuring a deleted mergeable container revives its old contents (verified on loro-crdt 1.16.3: delete `k`, re-`ensureMergeableMap("k")` returns the same id still holding the old keys); `main` already reconciles after ensure, and the switch path must go through it.

Placeholders in diffs:

- Unchanged placeholder (same reference): no ops.
- Replaced by a known variant: `union-switch`.
- Deleted: ordinary delete.
- A placeholder that is a different object (mutated through the Immer draft): the diff throws before any Loro op is applied, so that `setState` fails and leaves doc and state untouched. Only that call fails; the mirror stays usable.

**Remote switch (doc → state).**

- A newly inserted union map is resolved from the doc's tag at registration (`registerContainersFromLoroEvent`, `registerChildContainer`).
- A map event that updates the discriminant of a union-registered container marks it switched. After the batch is applied:
  - Its children are re-registered under the new variant. `registerContainerHandle` currently never overwrites an existing schema; this needs a forced re-registration path for the switched map's subtree.
  - Its state value is rebuilt wholesale from the doc through the read projection (§4), subsuming any per-key events inside it from the same batch.

**Concurrency (documented semantics).**

- Switch vs. switch: the tag is last-writer-wins. Both variants' keys may coexist in the doc; the projection shows only the winner's; the next local switch clears the strays.
- Switch vs. an edit of the old variant: the edit is lost if it touched a key or container the switch deleted. A delete beats a concurrent edit inside the deleted container (verified on loro-crdt 1.16.3). A key with the same name and container kind in both variants is kept in place, so edits to it survive.
- If an unknown tag wins the merge, the item becomes a placeholder.

### 4. Read projection and validation

Read projection (`containerToMirrorState`, `buildRootStateSnapshot`, the post-switch rebuild), for a union-registered map:

- Known tag: state gets the tag plus that variant's declared keys only. A catchall variant also shows undeclared keys as catchall entries (inherent to catchall; documented).
- A declared key whose container kind does not match the variant reads as absent. The next local write to that key recreates it.
- Unknown, missing or non-string tag: the placeholder `{ $cid, $unknownVariant: { tag, data } }`. `tag` is the stored string, or `null` when the tag is missing or not a string. `data` is the map's contents inferred as `schema.Any()` would infer them, deep-frozen.

So state never holds a variant whose shape contradicts its tag. Stray keys stay in the doc, invisible, until the next switch clears them.

Validation (`validateSchema`, and `setState`'s whole-state validation):

- A union value must be an object.
- If it has `$unknownVariant`, it is accepted structurally as a placeholder.
- Otherwise its tag must name a known variant, and it is validated as that variant's `LoroMap` plus the tag literal. A user-written value with an unknown tag is an error; only peers create unknown variants.
- Edits to placeholders are refused by the diff (§3), since `validateSchema` is pure and cannot tell an original placeholder from an edited copy.
- `ignoreUnknownProperties` is unchanged.

### 5. Path walks (#97, #99)

`pathResolvesToIgnore` and event path normalization walk the static schema along a path, and `getChildSchema` returns `undefined` at a union. Add one union step, `resolveUnionAtPath(union, containerIdAtThatHop)`, which consults the registry's current resolved variant (no doc read on the hot path). At a placeholder, or a union not yet registered, it returns `undefined`, the same "unknown, don't drop" behavior as `Any()`. #99's single-text-event path-copy inherits this step and needs no other change.

## Testing

Every row runs with mergeable map children both on and off, with `checkStateConsistency` enabled.

| Area | Cases |
| --- | --- |
| Placement | Union as map field, `LoroMapRecord` value, `LoroList` item with and without `idSelector`, `LoroMovableList` item. |
| Local switch | Replace-object and assign-tag styles; same-kind child kept (container id unchanged); different-kind child recreated; stray doc keys deleted; `$cid` stable; reorder of a nested `LoroMovableList(…, idSelector)` inside a variant emits `move`. |
| Container types | A child written in the same `setState` as the tag, with the tag key last in object order, gets the new variant's container type (regression for #76's wrong-container-type defect). |
| Remote switch | Children re-registered and state re-projected; a later local edit uses the new variant's schemas. |
| Concurrency | Switch vs. switch; switch vs. old-variant edit; switch back after a concurrent switch (no revival of stale mergeable contents); same-name, same-kind key survives a switch. |
| Unknown variants | A newer peer's tag reads as a placeholder; unrelated `setState`s keep working; replacing or deleting the placeholder works; a mutated placeholder fails only that call and emits no ops. |
| Fault tolerance | Wrong-kind slot reads absent and is recreated on the next write; missing or non-string tag becomes a placeholder with `tag: null`. |
| Integration | #97: events for an `Ignore` field inside a variant are dropped. #99: a single text event inside a variant applies correctly. |
| Types (`*.test-d.ts`) | Narrowing per tag; exhaustiveness fails without `case undefined`; `InferInputType` with optional `$cid`; builder rejects a variant declaring the discriminant. |

The repo's existing gates must pass: `pnpm build && pnpm test && pnpm lint && pnpm typecheck`.

## Follow-on sub-projects (separate specs)

2. Publish `@synapdeck/loro-mirror`, add the pnpm override, and replace `Any()` in Synapdeck's note schema with a `type`-discriminated union whose variants declare both manual and derived keys (optional) with `isDerived` as an ordinary boolean, so manual↔derived conversion stays an in-place edit rather than a variant switch.
3. Slideshow container representation: frames as `LoroMovableList(LoroMap{ id, imageRef, alt: LoroText }, f => f.id)`, keyframe tracked by frame id, and every writer that creates slideshow values (conformers, `buildMigratedNoteDoc`/`carryOver`, `adHocDerivationMutations`, spreadsheet paste, `lorofy*`) creating containers.
4. Rework #3199/#3203 onto the new representation, with drag-and-drop reorder, a per-slide presence highlight and an alt-text cursor over `useEditorEphemeral`/`useNotePresencePublisher`.
