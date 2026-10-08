import type { ContainerID } from "loro-crdt";
import { UNKNOWN_VARIANT_KEY } from "../constants.js";
import { unionTagOf } from "../schema/union.js";
import { defineCidProperty } from "./utils.js";

export function deepFreeze<T>(value: T): T {
    if (
        value !== null &&
        typeof value === "object" &&
        !Object.isFrozen(value)
    ) {
        Object.freeze(value);
        for (const child of Object.values(value as Record<string, unknown>))
            deepFreeze(child);
    }
    return value;
}

/** State placeholder for a union map whose tag this schema does not know. */
export function makeUnknownVariantPlaceholder(
    cid: ContainerID,
    tag: unknown,
    data: Record<string, unknown>,
): Record<string, unknown> {
    const placeholder: Record<string, unknown> = {
        [UNKNOWN_VARIANT_KEY]: deepFreeze({ tag: unionTagOf(tag), data }),
    };
    defineCidProperty(placeholder, cid);
    return placeholder;
}
