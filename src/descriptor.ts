import type { Problem } from './problem.ts';
import {
    enumType,
    fieldDef,
    isPackable,
    messageType,
    resolveTypeName,
    scalar,
    schema,
    type Cardinality,
    type EnumValue,
    type ExtensionDecl,
    type FieldDef,
    type FieldType,
    type MessageType,
    type MethodDecl,
    type NamedType,
    type NumberRange,
    type ScalarType,
    type Schema,
    type ServiceDecl
} from './schema.ts';
import type { Message, Value } from './values.ts';
import { decode } from './decode.ts';
import {
    editionDefaults,
    featuresFromNumbers,
    mergeFeatures,
    type FeatureSet,
    type ResolvedFeatures
} from './features.ts';

export interface DescriptorSetOptions {
    /**
     * Which file in the set the schema's package and syntax come from.
     * Defaults to the last file, which is the one asked for when protoc
     * emits its dependencies first.
     */
    readonly file?: string;
}

export interface DescriptorSetResult {
    readonly schema: Schema;
    /** Files that could not be read, and anything in them we could not model */
    readonly problems: readonly Problem[];
}

// ---------------------------------------------------------------------------
// The part of descriptor.proto needed to read a FileDescriptorSet. Written as
// schema literals rather than parsed at load time, so that reading descriptors
// does not depend on the .proto parser.
// ---------------------------------------------------------------------------

type FieldSpec = readonly [number, string, ScalarType | string, Cardinality?];

function descriptorType(name: string, fields: readonly FieldSpec[]): MessageType {
    return messageType(name, fields.map(([number, fieldName, type, cardinality]) => fieldDef({
        number,
        name: fieldName,
        type: SCALARS.has(type) ? scalar(type as ScalarType) : { kind: 'message', name: type },
        cardinality: cardinality ?? 'optional'
    })));
}

const SCALARS: ReadonlySet<string> = new Set([
    'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
    'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes'
]);

const P = 'google.protobuf.';

const DESCRIPTOR_TYPES: readonly MessageType[] = [
    descriptorType(`${P}FileDescriptorSet`, [[1, 'file', `${P}FileDescriptorProto`, 'repeated']]),
    descriptorType(`${P}FileDescriptorProto`, [
        [1, 'name', 'string'],
        [2, 'package', 'string'],
        [3, 'dependency', 'string', 'repeated'],
        [4, 'message_type', `${P}DescriptorProto`, 'repeated'],
        [5, 'enum_type', `${P}EnumDescriptorProto`, 'repeated'],
        [6, 'service', `${P}ServiceDescriptorProto`, 'repeated'],
        [7, 'extension', `${P}FieldDescriptorProto`, 'repeated'],
        [8, 'options', `${P}FileOptions`],
        [10, 'public_dependency', 'int32', 'repeated'],
        [11, 'weak_dependency', 'int32', 'repeated'],
        [12, 'syntax', 'string'],
        [14, 'edition', 'int32']
    ]),
    descriptorType(`${P}DescriptorProto`, [
        [1, 'name', 'string'],
        [2, 'field', `${P}FieldDescriptorProto`, 'repeated'],
        [3, 'nested_type', `${P}DescriptorProto`, 'repeated'],
        [4, 'enum_type', `${P}EnumDescriptorProto`, 'repeated'],
        [5, 'extension_range', `${P}Range`, 'repeated'],
        [6, 'extension', `${P}FieldDescriptorProto`, 'repeated'],
        [7, 'options', `${P}MessageOptions`],
        [8, 'oneof_decl', `${P}OneofDescriptorProto`, 'repeated'],
        [9, 'reserved_range', `${P}Range`, 'repeated'],
        [10, 'reserved_name', 'string', 'repeated']
    ]),
    // ExtensionRange, ReservedRange and EnumReservedRange all have this shape
    descriptorType(`${P}Range`, [[1, 'start', 'int32'], [2, 'end', 'int32']]),
    descriptorType(`${P}FieldDescriptorProto`, [
        [1, 'name', 'string'],
        [2, 'extendee', 'string'],
        [3, 'number', 'int32'],
        [4, 'label', 'int32'],
        [5, 'type', 'int32'],
        [6, 'type_name', 'string'],
        [7, 'default_value', 'string'],
        [8, 'options', `${P}FieldOptions`],
        [9, 'oneof_index', 'int32'],
        [10, 'json_name', 'string'],
        [17, 'proto3_optional', 'bool']
    ]),
    descriptorType(`${P}OneofDescriptorProto`, [[1, 'name', 'string'], [2, 'options', `${P}OneofOptions`]]),
    descriptorType(`${P}EnumDescriptorProto`, [
        [1, 'name', 'string'],
        [2, 'value', `${P}EnumValueDescriptorProto`, 'repeated'],
        [3, 'options', `${P}EnumOptions`],
        [4, 'reserved_range', `${P}Range`, 'repeated'],
        [5, 'reserved_name', 'string', 'repeated']
    ]),
    descriptorType(`${P}EnumValueDescriptorProto`, [
        [1, 'name', 'string'],
        [2, 'number', 'int32'],
        [3, 'options', `${P}EnumValueOptions`]
    ]),
    descriptorType(`${P}ServiceDescriptorProto`, [
        [1, 'name', 'string'],
        [2, 'method', `${P}MethodDescriptorProto`, 'repeated'],
        [3, 'options', `${P}ServiceOptions`]
    ]),
    descriptorType(`${P}MethodDescriptorProto`, [
        [1, 'name', 'string'],
        [2, 'input_type', 'string'],
        [3, 'output_type', 'string'],
        [4, 'options', `${P}MethodOptions`],
        [5, 'client_streaming', 'bool'],
        [6, 'server_streaming', 'bool']
    ]),
    descriptorType(`${P}FileOptions`, [[50, 'features', `${P}FeatureSet`]]),
    descriptorType(`${P}MessageOptions`, [
        [1, 'message_set_wire_format', 'bool'],
        [7, 'map_entry', 'bool'],
        [12, 'features', `${P}FeatureSet`]
    ]),
    descriptorType(`${P}FieldOptions`, [[2, 'packed', 'bool'], [21, 'features', `${P}FeatureSet`]]),
    descriptorType(`${P}OneofOptions`, [[1, 'features', `${P}FeatureSet`]]),
    descriptorType(`${P}EnumOptions`, [[2, 'allow_alias', 'bool'], [7, 'features', `${P}FeatureSet`]]),
    descriptorType(`${P}EnumValueOptions`, [[2, 'features', `${P}FeatureSet`]]),
    descriptorType(`${P}ServiceOptions`, [[34, 'features', `${P}FeatureSet`]]),
    descriptorType(`${P}MethodOptions`, [[35, 'features', `${P}FeatureSet`]]),
    descriptorType(`${P}FeatureSet`, [
        [1, 'field_presence', 'int32'],
        [2, 'enum_type', 'int32'],
        [3, 'repeated_field_encoding', 'int32'],
        [4, 'utf8_validation', 'int32'],
        [5, 'message_encoding', 'int32'],
        [6, 'json_format', 'int32']
    ])
];

/** The subset of descriptor.proto this module reads, as a schema */
export const DESCRIPTOR_SCHEMA: Schema = schema(DESCRIPTOR_TYPES, { package: 'google.protobuf', syntax: 'proto2' });

const TYPE_NAMES: Record<number, ScalarType> = {
    1: 'double', 2: 'float', 3: 'int64', 4: 'uint64', 5: 'int32', 6: 'fixed64', 7: 'fixed32',
    8: 'bool', 9: 'string', 12: 'bytes', 13: 'uint32', 15: 'sfixed32', 16: 'sfixed64',
    17: 'sint32', 18: 'sint64'
};
const TYPE_GROUP = 10;
const TYPE_MESSAGE = 11;
const TYPE_ENUM = 14;

const LABEL_REQUIRED = 2;
const LABEL_REPEATED = 3;

const EDITIONS: Record<number, string> = {
    998: 'proto2', 999: 'proto3', 1000: '2023', 1001: '2024', 1002: '2026'
};

/**
 * Reads a binary `FileDescriptorSet`, as produced by
 * `protoc --descriptor_set_out=x.pb --include_imports`, `buf build`, or any
 * runtime that can serialize descriptors. Editions features are resolved
 * through their lexical scopes, so the resulting fields carry the presence,
 * packing and message encoding that actually apply.
 */
export function schemaFromDescriptorSet(bytes: Uint8Array, options: DescriptorSetOptions = {}): DescriptorSetResult {
    const problems: Problem[] = [];
    const result = decode(bytes, { schema: DESCRIPTOR_SCHEMA, type: `${P}FileDescriptorSet` });
    // Fields of descriptor.proto we do not model are expected, not worth reporting
    for (const problem of result.problems) {
        if (problem.code !== 'unknown-field' && problem.code !== 'unknown-type') problems.push(problem);
    }

    const files = subMessages(result.message, 1);
    if (files.length === 0) {
        problems.push({ code: 'unknown-type', message: 'The descriptor set contains no files' });
        return { schema: schema([], { syntax: 'proto3' }), problems };
    }

    const types = new Map<string, NamedType>();
    const services: ServiceDecl[] = [];
    const extensions: ExtensionDecl[] = [];
    // Type references may be relative, so every declared name is collected first
    const reader = new DescriptorReader(types, services, extensions, problems, declaredNames(files));

    let primary = files[files.length - 1]!;
    if (options.file !== undefined) {
        const named = files.find(f => str(f, 1) === options.file);
        if (named) primary = named;
        else problems.push({ code: 'unknown-type', message: `The descriptor set contains no file named ${options.file}` });
    }

    for (const file of files) reader.readFile(file);
    for (const name of reader.foldedMapEntries) types.delete(name);

    const edition = fileEdition(primary);
    return {
        schema: {
            syntax: edition === 'proto2' || edition === 'proto3' ? edition : 'editions',
            ...(edition === 'proto2' || edition === 'proto3' ? {} : { edition }),
            package: str(primary, 2),
            types,
            imports: strings(primary, 3).map(path => ({ path, kind: 'default' as const })),
            ...(services.length > 0 ? { services } : {}),
            ...(extensions.length > 0 ? { extensions } : {})
        },
        problems
    };
}

function fileEdition(file: Message): string {
    const editionNumber = num(file, 14);
    if (editionNumber !== undefined) return EDITIONS[editionNumber] ?? String(editionNumber);
    return str(file, 12) === 'proto3' ? 'proto3' : 'proto2';
}

/** Every fully-qualified message and enum name the set declares */
function declaredNames(files: readonly Message[]): Set<string> {
    const names = new Set<string>();
    const addMessage = (message: Message, scope: string): void => {
        const fullName = join(scope, str(message, 1) ?? '');
        names.add(fullName);
        for (const nested of subMessages(message, 3)) addMessage(nested, fullName);
        for (const enumeration of subMessages(message, 4)) names.add(join(fullName, str(enumeration, 1) ?? ''));
    };
    for (const file of files) {
        const pkg = str(file, 2) ?? '';
        for (const message of subMessages(file, 4)) addMessage(message, pkg);
        for (const enumeration of subMessages(file, 5)) names.add(join(pkg, str(enumeration, 1) ?? ''));
    }
    return names;
}

function join(scope: string, name: string): string {
    return scope === '' ? name : `${scope}.${name}`;
}

class DescriptorReader {
    private readonly types: Map<string, NamedType>;
    private readonly services: ServiceDecl[];
    private readonly extensions: ExtensionDecl[];
    private readonly problems: Problem[];
    private readonly declared: ReadonlySet<string>;
    /** Map entry types that have been folded into a map field, so are no longer needed */
    readonly foldedMapEntries = new Set<string>();

    constructor(
        types: Map<string, NamedType>,
        services: ServiceDecl[],
        extensions: ExtensionDecl[],
        problems: Problem[],
        declared: ReadonlySet<string>
    ) {
        this.types = types;
        this.services = services;
        this.extensions = extensions;
        this.problems = problems;
        this.declared = declared;
    }

    readFile(file: Message): void {
        const edition = fileEdition(file);
        const pkg = str(file, 2) ?? '';
        const features = mergeFeatures(editionDefaults(edition), readFeatures(subMessage(file, 8)));

        for (const message of subMessages(file, 4)) this.readMessage(message, pkg, edition, features);
        for (const enumeration of subMessages(file, 5)) this.readEnum(enumeration, pkg, features);
        for (const service of subMessages(file, 6)) this.readService(service, pkg);
        for (const extension of subMessages(file, 7)) {
            const field = this.readField(extension, pkg, edition, features, []);
            const extendee = this.resolve(str(extension, 2) ?? '', pkg, 'extendee');
            if (field) this.extensions.push({ extendee, field });
        }
    }

    private readMessage(message: Message, scope: string, edition: string, inherited: ResolvedFeatures): void {
        const name = str(message, 1) ?? '';
        const fullName = join(scope, name);
        const options = subMessage(message, 7);
        const features = mergeFeatures(inherited, readFeatures(options));

        // Nested types are read first so that map entry types are known to their fields
        for (const nested of subMessages(message, 3)) this.readMessage(nested, fullName, edition, features);
        for (const enumeration of subMessages(message, 4)) this.readEnum(enumeration, fullName, features);

        const oneofs = subMessages(message, 8);
        const oneofNames = oneofs.map(o => str(o, 1) ?? '');
        const oneofFeatures = oneofs.map(o => mergeFeatures(features, readFeatures(subMessage(o, 2))));

        const fields = new Map<number, FieldDef>();
        for (const descriptor of subMessages(message, 2)) {
            const index = num(descriptor, 9);
            // A proto3 `optional` field is wrapped in a synthetic one-member oneof
            const synthetic = bool(descriptor, 17) === true;
            const scopeFeatures = index !== undefined && !synthetic ? oneofFeatures[index] ?? features : features;
            const field = this.readField(descriptor, fullName, edition, scopeFeatures, oneofNames, index, synthetic);
            if (field) fields.set(field.number, field);
        }

        this.types.set(fullName, {
            kind: 'message',
            name,
            fullName,
            fields,
            oneofs: oneofNames.filter((_, i) => [...fields.values()].some(f => f.oneof === oneofNames[i])),
            mapEntry: bool(options, 7) === true,
            messageSet: bool(options, 1) === true,
            ...ranges('reservedRanges', subMessages(message, 9), true),
            ...names('reservedNames', strings(message, 10)),
            ...ranges('extensionRanges', subMessages(message, 5), true)
        });
    }

    private readField(
        descriptor: Message,
        scope: string,
        edition: string,
        inherited: ResolvedFeatures,
        oneofNames: readonly string[],
        oneofIndex?: number,
        synthetic = false
    ): FieldDef | undefined {
        const name = str(descriptor, 1) ?? '';
        const number = num(descriptor, 3);
        if (number === undefined) {
            this.problems.push({ code: 'invalid-field-number', message: `Field ${join(scope, name)} has no number` });
            return undefined;
        }

        const options = subMessage(descriptor, 8);
        const features = mergeFeatures(inherited, readFeatures(options));
        const label = num(descriptor, 4);
        const typeNumber = num(descriptor, 5);
        const typeName = str(descriptor, 6);
        const repeated = label === LABEL_REPEATED;

        let type = this.fieldType(typeNumber, typeName, scope, name);

        let cardinality: Cardinality = repeated ? 'repeated' : 'optional';
        if (!repeated && (label === LABEL_REQUIRED || features.fieldPresence === 'LEGACY_REQUIRED')) {
            cardinality = 'required';
        }

        // A repeated message field of a map entry type is a map field. The synthetic
        // entry type is then redundant, since the map type carries its key and value.
        if (repeated && type.kind === 'message') {
            const entry = this.types.get(type.name);
            if (entry?.kind === 'message' && entry.mapEntry) {
                const key = entry.fields.get(1)?.type;
                const value = entry.fields.get(2)?.type;
                if (key?.kind === 'scalar' && value) {
                    type = { kind: 'map', key: key.scalar, value };
                    this.foldedMapEntries.add(entry.fullName);
                }
            }
        }

        const oneof = oneofIndex !== undefined && !synthetic ? oneofNames[oneofIndex] : undefined;
        const packedOption = bool(options, 2);
        const packed = repeated && isPackable(type) && (packedOption ?? features.repeatedFieldEncoding === 'PACKED');
        // Repeated fields have no presence; oneof members always do
        const explicit = !repeated && (
            synthetic
            || oneof !== undefined
            || label === LABEL_REQUIRED
            || features.fieldPresence !== 'IMPLICIT'
            || type.kind === 'message'
            || type.kind === 'map'
        );
        const defaultValue = str(descriptor, 7);
        const jsonName = str(descriptor, 10);

        return {
            number,
            name,
            type,
            cardinality,
            presence: explicit ? 'explicit' : 'implicit',
            packed,
            delimited: typeNumber === TYPE_GROUP || features.messageEncoding === 'DELIMITED',
            ...(oneof !== undefined ? { oneof } : {}),
            ...(jsonName !== undefined ? { jsonName } : {}),
            ...(defaultValue !== undefined ? { defaultValue } : {})
        };
    }

    private fieldType(typeNumber: number | undefined, typeName: string | undefined, scope: string, field: string): FieldType {
        if (typeNumber === TYPE_MESSAGE || typeNumber === TYPE_GROUP || typeNumber === TYPE_ENUM) {
            const kind = typeNumber === TYPE_ENUM ? 'enum' as const : 'message' as const;
            return { kind, name: this.resolve(typeName ?? '', scope, field) };
        }
        const named = typeNumber === undefined ? undefined : TYPE_NAMES[typeNumber];
        if (named) return scalar(named);
        this.problems.push({
            code: 'unknown-type',
            message: `Field ${join(scope, field)} has unknown type number ${typeNumber}; reading it as bytes`
        });
        return scalar('bytes');
    }

    /**
     * Descriptor type references are usually fully qualified with a leading
     * dot, but the format allows relative names resolved with C++ scoping
     * rules, and some producers emit those.
     */
    private resolve(typeName: string, scope: string, field: string): string {
        const resolved = resolveTypeName(typeName, scope, this.declared);
        if (resolved !== undefined) return resolved;
        this.problems.push({
            code: 'unresolved-type',
            message: `Field ${join(scope, field)} refers to type '${typeName}', which the descriptor set does not define`
        });
        return qualify(typeName);
    }

    private readEnum(descriptor: Message, scope: string, inherited: ResolvedFeatures): void {
        const name = str(descriptor, 1) ?? '';
        const fullName = join(scope, name);
        const features = mergeFeatures(inherited, readFeatures(subMessage(descriptor, 3)));
        const values: EnumValue[] = [];
        for (const value of subMessages(descriptor, 2)) {
            values.push({ name: str(value, 1) ?? '', number: num(value, 2) ?? 0 });
        }
        this.types.set(fullName, {
            ...enumType(fullName, values, { open: features.enumType === 'OPEN' }),
            ...ranges('reservedRanges', subMessages(descriptor, 4), false),
            ...names('reservedNames', strings(descriptor, 5))
        });
    }

    private readService(descriptor: Message, scope: string): void {
        const name = str(descriptor, 1) ?? '';
        const methods: MethodDecl[] = subMessages(descriptor, 2).map(method => ({
            name: str(method, 1) ?? '',
            inputType: this.resolve(str(method, 2) ?? '', scope, 'input_type'),
            outputType: this.resolve(str(method, 3) ?? '', scope, 'output_type'),
            clientStreaming: bool(method, 5) === true,
            serverStreaming: bool(method, 6) === true
        }));
        this.services.push({ name, fullName: join(scope, name), methods });
    }
}

function readFeatures(options: Message | undefined): FeatureSet | undefined {
    if (!options) return undefined;
    const features = subMessage(options, options.type === `${P}FileOptions` ? 50
        : options.type === `${P}MessageOptions` ? 12
        : options.type === `${P}FieldOptions` ? 21
        : options.type === `${P}EnumOptions` ? 7
        : options.type === `${P}ServiceOptions` ? 34
        : options.type === `${P}MethodOptions` ? 35
        : options.type === `${P}EnumValueOptions` ? 2
        : 1);
    if (!features) return undefined;
    return featuresFromNumbers({
        fieldPresence: num(features, 1),
        enumType: num(features, 2),
        repeatedFieldEncoding: num(features, 3),
        utf8Validation: num(features, 4),
        messageEncoding: num(features, 5),
        jsonFormat: num(features, 6)
    });
}

/** Descriptor ranges are half-open for fields and extensions, inclusive for enum values */
function ranges(key: 'reservedRanges' | 'extensionRanges', messages: readonly Message[], exclusiveEnd: boolean): Record<string, NumberRange[]> {
    if (messages.length === 0) return {};
    return {
        [key]: messages.map(range => {
            const start = num(range, 1) ?? 0;
            const end = num(range, 2) ?? start;
            return { start, end: exclusiveEnd ? end - 1 : end };
        })
    };
}

function names(key: 'reservedNames', values: readonly string[]): Record<string, readonly string[]> {
    return values.length === 0 ? {} : { [key]: values };
}

/** Descriptor type names are fully qualified with a leading dot */
function qualify(name: string): string {
    return name.startsWith('.') ? name.slice(1) : name;
}

// --- Accessors over a decoded descriptor message ---

function values(message: Message | undefined, number: number): readonly Value[] {
    return message?.fields.get(number)?.values ?? [];
}

function str(message: Message | undefined, number: number): string | undefined {
    const value = values(message, number).at(-1);
    return value?.kind === 'string' ? value.value : undefined;
}

function strings(message: Message | undefined, number: number): string[] {
    return values(message, number).flatMap(v => v.kind === 'string' ? [v.value] : []);
}

function num(message: Message | undefined, number: number): number | undefined {
    const value = values(message, number).at(-1);
    return value?.kind === 'int32' ? Number(value.value) : undefined;
}

function bool(message: Message | undefined, number: number): boolean | undefined {
    const value = values(message, number).at(-1);
    return value?.kind === 'bool' ? value.value : undefined;
}

function subMessage(message: Message | undefined, number: number): Message | undefined {
    const value = values(message, number).at(-1);
    return value?.kind === 'message' ? value.value : undefined;
}

function subMessages(message: Message | undefined, number: number): Message[] {
    return values(message, number).flatMap(v => v.kind === 'message' ? [v.value] : []);
}
