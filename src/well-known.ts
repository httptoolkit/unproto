import {
    enumType,
    fieldDef,
    messageType,
    scalar,
    type FieldDef,
    type FieldType,
    type NamedType,
    type ScalarType
} from './schema.ts';

/**
 * The well-known types, as schema literals rather than bundled `.proto`
 * source, so that resolving an import of `google/protobuf/timestamp.proto`
 * costs no parsing. Only the shapes matter here: these are used to resolve
 * type references and to decode values, not to reproduce the originals.
 */

type Spec = readonly [number, string, ScalarType | { readonly message: string } | { readonly enum: string }, ('repeated' | 'optional')?];

function type(fullName: string, specs: readonly Spec[], oneof?: string): NamedType {
    const fields: FieldDef[] = specs.map(([number, name, kind, cardinality]) => {
        const type: FieldType = typeof kind === 'string' ? scalar(kind)
            : 'message' in kind ? { kind: 'message', name: kind.message }
            : { kind: 'enum', name: kind.enum };
        // These are proto3 files, so scalars have implicit presence and messages explicit
        const explicit = oneof !== undefined || (cardinality !== 'repeated' && type.kind === 'message');
        return fieldDef({
            number,
            name,
            type,
            cardinality: cardinality ?? 'optional',
            presence: explicit ? 'explicit' : 'implicit',
            ...(oneof !== undefined ? { oneof } : {})
        });
    });
    return { ...messageType(fullName, fields), oneofs: oneof !== undefined ? [oneof] : [] };
}

const G = 'google.protobuf.';

function wrapper(name: string, value: ScalarType): NamedType {
    return type(`${G}${name}`, [[1, 'value', value]]);
}

/** Every bundled well-known type, keyed by full name */
export const WELL_KNOWN_TYPES: ReadonlyMap<string, NamedType> = new Map(([
    type(`${G}Timestamp`, [[1, 'seconds', 'int64'], [2, 'nanos', 'int32']]),
    type(`${G}Duration`, [[1, 'seconds', 'int64'], [2, 'nanos', 'int32']]),
    type(`${G}Any`, [[1, 'type_url', 'string'], [2, 'value', 'bytes']]),
    type(`${G}Empty`, []),
    type(`${G}FieldMask`, [[1, 'paths', 'string', 'repeated']]),
    type(`${G}Struct`, [[1, 'fields', { message: `${G}Struct.FieldsEntry` }, 'repeated']]),
    { ...type(`${G}Struct.FieldsEntry`, [[1, 'key', 'string'], [2, 'value', { message: `${G}Value` }]]), mapEntry: true },
    type(`${G}Value`, [
        [1, 'null_value', { enum: `${G}NullValue` }],
        [2, 'number_value', 'double'],
        [3, 'string_value', 'string'],
        [4, 'bool_value', 'bool'],
        [5, 'struct_value', { message: `${G}Struct` }],
        [6, 'list_value', { message: `${G}ListValue` }]
    ], 'kind'),
    type(`${G}ListValue`, [[1, 'values', { message: `${G}Value` }, 'repeated']]),
    enumType(`${G}NullValue`, [{ name: 'NULL_VALUE', number: 0 }]),
    wrapper('DoubleValue', 'double'),
    wrapper('FloatValue', 'float'),
    wrapper('Int64Value', 'int64'),
    wrapper('UInt64Value', 'uint64'),
    wrapper('Int32Value', 'int32'),
    wrapper('UInt32Value', 'uint32'),
    wrapper('BoolValue', 'bool'),
    wrapper('StringValue', 'string'),
    wrapper('BytesValue', 'bytes')
] as readonly NamedType[]).map(t => [t.fullName, t]));

/** The types each bundled `google/protobuf/*.proto` import provides */
const BY_IMPORT: ReadonlyMap<string, readonly string[]> = new Map([
    ['google/protobuf/timestamp.proto', [`${G}Timestamp`]],
    ['google/protobuf/duration.proto', [`${G}Duration`]],
    ['google/protobuf/any.proto', [`${G}Any`]],
    ['google/protobuf/empty.proto', [`${G}Empty`]],
    ['google/protobuf/field_mask.proto', [`${G}FieldMask`]],
    ['google/protobuf/struct.proto', [`${G}Struct`, `${G}Struct.FieldsEntry`, `${G}Value`, `${G}ListValue`, `${G}NullValue`]],
    ['google/protobuf/wrappers.proto', [
        `${G}DoubleValue`, `${G}FloatValue`, `${G}Int64Value`, `${G}UInt64Value`,
        `${G}Int32Value`, `${G}UInt32Value`, `${G}BoolValue`, `${G}StringValue`, `${G}BytesValue`
    ]]
]);

/** Whether an import path is one of the bundled well-known type files */
export function isWellKnownImport(path: string): boolean {
    return BY_IMPORT.has(path);
}

/** The types provided by a bundled import, or an empty list for anything else */
export function wellKnownTypesFor(path: string): readonly NamedType[] {
    return (BY_IMPORT.get(path) ?? []).flatMap(name => {
        const type = WELL_KNOWN_TYPES.get(name);
        return type ? [type] : [];
    });
}
