import type { WireType } from './wire.ts';

export type ScalarType =
    | 'double' | 'float'
    | 'int32' | 'int64' | 'uint32' | 'uint64' | 'sint32' | 'sint64'
    | 'fixed32' | 'fixed64' | 'sfixed32' | 'sfixed64'
    | 'bool' | 'string' | 'bytes';

export type FieldType =
    | { readonly kind: 'scalar'; readonly scalar: ScalarType }
    | { readonly kind: 'message'; readonly name: string }
    | { readonly kind: 'enum'; readonly name: string }
    | { readonly kind: 'map'; readonly key: ScalarType; readonly value: FieldType };

export type Cardinality = 'optional' | 'required' | 'repeated';

/** An inclusive range of field or enum numbers */
export interface NumberRange {
    readonly start: number;
    /** Inclusive. `MAX_FIELD_NUMBER` stands for the `max` keyword. */
    readonly end: number;
}

/** An option as written. Values are kept as source text, uninterpreted. */
export interface OptionDecl {
    /** Including any parentheses and dots, e.g. `(my.custom).nested` */
    readonly name: string;
    readonly value: string;
}

export interface ImportDecl {
    readonly path: string;
    readonly kind: 'default' | 'public' | 'weak' | 'option';
}

export interface MethodDecl {
    readonly name: string;
    readonly inputType: string;
    readonly outputType: string;
    readonly clientStreaming: boolean;
    readonly serverStreaming: boolean;
    readonly options?: readonly OptionDecl[];
}

export interface ServiceDecl {
    readonly name: string;
    readonly fullName: string;
    readonly methods: readonly MethodDecl[];
    readonly options?: readonly OptionDecl[];
}

/** A field declared on another message by an `extend` block */
export interface ExtensionDecl {
    /** Full name of the message being extended */
    readonly extendee: string;
    readonly field: FieldDef;
}

/** Whether an unset field is distinguishable from one set to its default value */
export type Presence = 'explicit' | 'implicit';

export interface AlternativeType {
    readonly type: FieldType;
    readonly packed: boolean;
}

export interface InferenceNotes {
    /** Other readings of the observed data that were considered plausible, best first */
    readonly alternatives: readonly AlternativeType[];
    /** How many of the sampled containing messages had this field */
    readonly presentIn: number;
    /** How many containing messages were sampled */
    readonly samples: number;
}

export interface FieldDef {
    readonly number: number;
    readonly name: string;
    readonly type: FieldType;
    readonly cardinality: Cardinality;
    readonly presence: Presence;
    /** Whether repeated scalar values are written as one length-delimited record */
    readonly packed: boolean;
    /** Whether a message value is written as a group (start/end tags) rather than length-prefixed */
    readonly delimited: boolean;
    readonly oneof?: string;
    readonly jsonName?: string;
    /** The default value as written in the schema, if any */
    readonly defaultValue?: string;
    /** Present only on fields whose definition was inferred from data */
    readonly inferred?: InferenceNotes;
    /** Options that do not affect decoding, kept so that they survive a round trip */
    readonly options?: readonly OptionDecl[];
}

export interface MessageType {
    readonly kind: 'message';
    readonly name: string;
    /** Dot-separated, package-qualified, without a leading dot. Nested types include their parents. */
    readonly fullName: string;
    readonly fields: ReadonlyMap<number, FieldDef>;
    readonly oneofs: readonly string[];
    readonly mapEntry: boolean;
    readonly messageSet: boolean;
    readonly reservedRanges?: readonly NumberRange[];
    readonly reservedNames?: readonly string[];
    readonly extensionRanges?: readonly NumberRange[];
    readonly options?: readonly OptionDecl[];
}

export interface EnumValue {
    readonly name: string;
    readonly number: number;
}

export interface EnumType {
    readonly kind: 'enum';
    readonly name: string;
    readonly fullName: string;
    readonly values: readonly EnumValue[];
    /** Open enums accept unknown numbers; closed ones treat them as unknown fields */
    readonly open: boolean;
    readonly reservedRanges?: readonly NumberRange[];
    readonly reservedNames?: readonly string[];
    readonly options?: readonly OptionDecl[];
}

export type NamedType = MessageType | EnumType;

export interface Schema {
    readonly syntax: 'proto2' | 'proto3' | 'editions';
    /** The edition string when `syntax` is 'editions', e.g. '2023'. Not restricted, so that future editions parse. */
    readonly edition?: string;
    readonly package?: string;
    readonly types: ReadonlyMap<string, NamedType>;
    readonly imports?: readonly ImportDecl[];
    readonly services?: readonly ServiceDecl[];
    readonly extensions?: readonly ExtensionDecl[];
    readonly options?: readonly OptionDecl[];
}

export const VARINT_SCALARS: ReadonlySet<ScalarType> = new Set<ScalarType>([
    'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool'
]);
export const I64_SCALARS: ReadonlySet<ScalarType> = new Set<ScalarType>(['fixed64', 'sfixed64', 'double']);
export const I32_SCALARS: ReadonlySet<ScalarType> = new Set<ScalarType>(['fixed32', 'sfixed32', 'float']);

export function scalarWireType(scalar: ScalarType): WireType {
    if (VARINT_SCALARS.has(scalar)) return 0;
    if (I64_SCALARS.has(scalar)) return 1;
    if (I32_SCALARS.has(scalar)) return 5;
    return 2;
}

/** Whether values of this type may be written as a packed repeated field */
export function isPackable(type: FieldType): boolean {
    if (type.kind === 'enum') return true;
    if (type.kind !== 'scalar') return false;
    return type.scalar !== 'string' && type.scalar !== 'bytes';
}

export function scalar(scalar: ScalarType): FieldType {
    return { kind: 'scalar', scalar };
}

export function describeType(type: FieldType): string {
    switch (type.kind) {
        case 'scalar': return type.scalar;
        case 'message': return type.name;
        case 'enum': return type.name;
        case 'map': return `map<${type.key}, ${describeType(type.value)}>`;
    }
}

type FieldDefInput = Pick<FieldDef, 'number' | 'name' | 'type'> & Partial<FieldDef>;

/** Builds a field definition with sensible defaults for anything not given */
export function fieldDef(input: FieldDefInput): FieldDef {
    return {
        cardinality: 'optional',
        presence: 'explicit',
        packed: input.cardinality === 'repeated' && isPackable(input.type),
        delimited: false,
        ...input
    };
}

/** Builds a message type from a list of fields; the simple name is the last segment of the full name */
export function messageType(fullName: string, fields: readonly FieldDef[], options: Partial<Omit<MessageType, 'kind' | 'fields' | 'fullName'>> = {}): MessageType {
    return {
        kind: 'message',
        name: fullName.slice(fullName.lastIndexOf('.') + 1),
        fullName,
        fields: new Map(fields.map(f => [f.number, f])),
        oneofs: [],
        mapEntry: false,
        messageSet: false,
        ...options
    };
}

export function enumType(fullName: string, values: readonly EnumValue[], options: Partial<Pick<EnumType, 'open'>> = {}): EnumType {
    return {
        kind: 'enum',
        name: fullName.slice(fullName.lastIndexOf('.') + 1),
        fullName,
        values,
        open: options.open ?? true
    };
}

export function schema(types: readonly NamedType[], options: Partial<Omit<Schema, 'types'>> = {}): Schema {
    return {
        syntax: 'proto3',
        types: new Map(types.map(t => [t.fullName, t])),
        ...options
    };
}
