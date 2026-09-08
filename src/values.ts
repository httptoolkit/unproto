import type { WireField } from './wire.ts';
import type { FieldDef, FieldType } from './schema.ts';

export type IntKind =
    | 'int32' | 'int64' | 'uint32' | 'uint64' | 'sint32' | 'sint64'
    | 'fixed32' | 'fixed64' | 'sfixed32' | 'sfixed64';

/**
 * A decoded value. Every integer type is a bigint whatever its width, so
 * that consumers only deal with one numeric type; only floats are numbers.
 */
export type Value =
    | { readonly kind: IntKind; readonly value: bigint }
    | { readonly kind: 'float' | 'double'; readonly value: number }
    | { readonly kind: 'bool'; readonly value: boolean }
    | { readonly kind: 'enum'; readonly value: bigint; readonly name?: string; readonly type: string }
    | { readonly kind: 'string'; readonly value: string }
    | { readonly kind: 'bytes'; readonly value: Uint8Array }
    | { readonly kind: 'message'; readonly value: Message }
    /** A wire field that could not be interpreted, e.g. because its wire type contradicts the schema */
    | { readonly kind: 'raw'; readonly wire: WireField };

/** Another plausible reading of a whole field's occurrences */
export interface Alternative {
    readonly type: FieldType;
    readonly packed: boolean;
    readonly values: readonly Value[];
}

export interface Field {
    readonly number: number;
    readonly name?: string;
    readonly def?: FieldDef;
    /** One entry per element, in wire order. Packed records are expanded. */
    readonly values: readonly Value[];
    /** The wire records this field was read from, in wire order */
    readonly raw: readonly WireField[];
    /** Other readings, best first. Empty unless the field's type was inferred. */
    readonly alternatives: readonly Alternative[];
}

export interface Message {
    /** Full name of the schema type this was decoded as, if any */
    readonly type?: string;
    /** Keyed by field number, in the order fields first appear on the wire */
    readonly fields: ReadonlyMap<number, Field>;
}

export const INT_KINDS: ReadonlySet<string> = new Set<IntKind>([
    'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
    'fixed32', 'fixed64', 'sfixed32', 'sfixed64'
]);
