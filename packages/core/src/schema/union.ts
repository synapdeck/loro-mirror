import { UNKNOWN_VARIANT_KEY } from "../constants.js";
import type {
    AnyLoroUnionSchema,
    UnionVariantSchema,
    UnknownVariantInfo,
} from "./types.js";

/** The variant for `tag`, or undefined for an unknown, missing or non-string tag. */
export function resolveUnionVariant(
    union: AnyLoroUnionSchema,
    tag: unknown,
): UnionVariantSchema | undefined {
    if (typeof tag !== "string") return undefined;
    return Object.prototype.hasOwnProperty.call(union.variants, tag)
        ? union.variants[tag]
        : undefined;
}

/** A stored tag as the placeholder reports it: the string, or null. */
export function unionTagOf(tag: unknown): string | null {
    return typeof tag === "string" ? tag : null;
}

export function isUnknownVariantPlaceholder(
    value: unknown,
): value is { $unknownVariant: UnknownVariantInfo } {
    return (
        typeof value === "object" &&
        value !== null &&
        Object.prototype.hasOwnProperty.call(value, UNKNOWN_VARIANT_KEY)
    );
}
