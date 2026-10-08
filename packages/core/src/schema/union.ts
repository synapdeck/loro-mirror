import { UNKNOWN_VARIANT_KEY } from "../constants.js";
import type {
    AnyLoroUnionSchema,
    SchemaType,
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

/** Whether a schema subtree contains a union (recursive schemas tolerated). */
export function schemaContainsUnion(schema: SchemaType | undefined): boolean {
    const visited = new Set<SchemaType>();
    const walk = (s: SchemaType | undefined): boolean => {
        if (!s || visited.has(s)) return false;
        visited.add(s);
        switch (s.type) {
            case "loro-union":
                return true;
            case "schema":
            case "loro-map": {
                const record = s as {
                    definition: Record<string, SchemaType>;
                    catchallType?: SchemaType;
                };
                return (
                    Object.values(record.definition).some(walk) ||
                    walk(record.catchallType)
                );
            }
            case "loro-list":
            case "loro-movable-list":
                return walk(s.itemSchema);
            case "loro-tree":
                return walk(s.nodeSchema);
            default:
                return false;
        }
    };
    return walk(schema);
}
