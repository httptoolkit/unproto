import {
    describeType,
    isPackable,
    type EnumType,
    type FieldDef,
    type FieldType,
    type MessageType,
    type NamedType,
    type Schema
} from './schema.ts';

export interface PrintProtoOptions {
    /** Comment lines placed at the top of the file */
    readonly header?: readonly string[];
    /** The indentation unit. Defaults to two spaces. */
    readonly indent?: string;
}

type Syntax = 'proto2' | 'proto3' | 'editions';

interface Printer {
    readonly schema: Schema;
    readonly syntax: Syntax;
    readonly indent: string;
    readonly children: ReadonlyMap<string, readonly NamedType[]>;
    readonly lines: string[];
}

/**
 * Renders a schema as `.proto` source. Inferred schemas print as proto3,
 * or as edition 2023 when the data used group encoding, which proto3
 * cannot express. Fields whose definitions were inferred carry a trailing
 * comment with the evidence and the other readings that were considered.
 */
export function printProto(schema: Schema, options: PrintProtoOptions = {}): string {
    const printer: Printer = {
        schema,
        syntax: effectiveSyntax(schema),
        indent: options.indent ?? '  ',
        children: childrenByParent(schema),
        lines: []
    };
    const { lines } = printer;

    for (const line of options.header ?? []) lines.push(`// ${line}`);
    if (lines.length > 0) lines.push('');
    lines.push(printer.syntax === 'editions' ? `edition = "${schema.edition ?? '2023'}";` : `syntax = "${printer.syntax}";`);
    if (schema.package !== undefined) {
        lines.push('');
        lines.push(`package ${schema.package};`);
    }
    for (const type of printer.children.get('') ?? []) {
        lines.push('');
        printType(printer, type, '');
    }
    return lines.join('\n') + '\n';
}

/**
 * proto3 cannot express group encoding, and proto2 can only express it
 * through the group declaration syntax, which ties the field name to the
 * type name; edition 2023 expresses both faithfully, so a schema with
 * delimited fields prints in that dialect.
 */
function effectiveSyntax(schema: Schema): Syntax {
    if (schema.syntax === 'editions') return 'editions';
    for (const type of schema.types.values()) {
        if (type.kind !== 'message') continue;
        for (const field of type.fields.values()) {
            if (field.delimited) return 'editions';
        }
    }
    return schema.syntax;
}

/** Groups types under their enclosing type ('' for top level), keeping the schema's order */
function childrenByParent(schema: Schema): Map<string, NamedType[]> {
    const children = new Map<string, NamedType[]>();
    for (const type of schema.types.values()) {
        let parent = '';
        let candidate = type.fullName;
        while (candidate.includes('.')) {
            candidate = candidate.slice(0, candidate.lastIndexOf('.'));
            if (schema.types.get(candidate)?.kind === 'message') {
                parent = candidate;
                break;
            }
        }
        const list = children.get(parent);
        if (list) list.push(type);
        else children.set(parent, [type]);
    }
    return children;
}

function printType(printer: Printer, type: NamedType, pad: string): void {
    if (type.kind === 'enum') printEnum(printer, type, pad);
    else printMessage(printer, type, pad);
}

function printMessage(printer: Printer, type: MessageType, pad: string): void {
    const { lines, indent } = printer;
    const inner = pad + indent;
    const nested = printer.children.get(type.fullName) ?? [];
    if (type.fields.size === 0 && nested.length === 0) {
        lines.push(`${pad}message ${type.name} {}`);
        return;
    }

    lines.push(`${pad}message ${type.name} {`);
    if (printer.syntax === 'editions' && type.messageSet) lines.push(`${inner}option message_set_wire_format = true;`);

    const fields = [...type.fields.values()].sort((a, b) => a.number - b.number);
    const printedOneofs = new Set<string>();
    for (const field of fields) {
        if (field.oneof === undefined) {
            lines.push(inner + fieldLine(printer, field, type, false));
            continue;
        }
        if (printedOneofs.has(field.oneof)) continue;
        printedOneofs.add(field.oneof);
        lines.push(`${inner}oneof ${field.oneof} {`);
        for (const member of fields) {
            if (member.oneof === field.oneof) lines.push(inner + indent + fieldLine(printer, member, type, true));
        }
        lines.push(`${inner}}`);
    }

    for (const child of nested) {
        lines.push('');
        printType(printer, child, inner);
    }
    lines.push(`${pad}}`);
}

function printEnum(printer: Printer, type: EnumType, pad: string): void {
    const { lines, indent } = printer;
    lines.push(`${pad}enum ${type.name} {`);
    const numbers = new Set<number>();
    let aliased = false;
    for (const value of type.values) {
        if (numbers.has(value.number)) aliased = true;
        numbers.add(value.number);
    }
    if (aliased) lines.push(`${pad}${indent}option allow_alias = true;`);
    if (printer.syntax === 'editions' && !type.open) lines.push(`${pad}${indent}option features.enum_type = CLOSED;`);
    for (const value of type.values) lines.push(`${pad}${indent}${value.name} = ${value.number};`);
    lines.push(`${pad}}`);
}

function fieldLine(printer: Printer, field: FieldDef, scope: MessageType, inOneof: boolean): string {
    const { syntax } = printer;
    const parts: string[] = [];
    const scalarLike = field.type.kind === 'scalar' || field.type.kind === 'enum';

    if (!inOneof && field.type.kind !== 'map') {
        if (field.cardinality === 'repeated') parts.push('repeated');
        else if (syntax === 'proto2') parts.push(field.cardinality === 'required' ? 'required' : 'optional');
        else if (syntax === 'proto3' && field.presence === 'explicit' && scalarLike) parts.push('optional');
    }
    parts.push(typeText(printer, field.type, scope.fullName));

    let line = `${parts.join(' ')} ${field.name} = ${field.number}`;
    const options = fieldOptions(printer, field, scalarLike);
    if (options.length > 0) line += ` [${options.join(', ')}]`;
    line += ';';

    const note = inferenceNote(field);
    return note === undefined ? line : `${line} // ${note}`;
}

function fieldOptions(printer: Printer, field: FieldDef, scalarLike: boolean): string[] {
    const { syntax } = printer;
    const options: string[] = [];
    const repeatedPackable = field.cardinality === 'repeated' && isPackable(field.type);

    if (syntax === 'proto2') {
        if (repeatedPackable && field.packed) options.push('packed = true');
    } else if (syntax === 'proto3') {
        if (repeatedPackable && !field.packed) options.push('packed = false');
    } else {
        if (repeatedPackable && !field.packed) options.push('features.repeated_field_encoding = EXPANDED');
        if (field.delimited && field.type.kind === 'message') options.push('features.message_encoding = DELIMITED');
        if (field.cardinality === 'required') options.push('features.field_presence = LEGACY_REQUIRED');
        else if (field.cardinality !== 'repeated' && scalarLike && field.presence === 'implicit') options.push('features.field_presence = IMPLICIT');
    }
    if (syntax !== 'proto3' && field.defaultValue !== undefined) options.push(`default = ${field.defaultValue}`);
    if (field.jsonName !== undefined) options.push(`json_name = "${escapeString(field.jsonName)}"`);
    return options;
}

function inferenceNote(field: FieldDef): string | undefined {
    const notes = field.inferred;
    if (!notes) return undefined;
    const parts = [`seen in ${notes.presentIn} of ${notes.samples} message${notes.samples === 1 ? '' : 's'}`];
    if (notes.alternatives.length > 0) {
        const shown = notes.alternatives.slice(0, 3).map(alt => (alt.packed ? 'packed ' : '') + describeType(alt.type));
        parts.push(`could also be ${shown.join(', ')}${notes.alternatives.length > 3 ? ', ...' : ''}`);
    }
    return parts.join('; ');
}

function typeText(printer: Printer, type: FieldType, scope: string): string {
    switch (type.kind) {
        case 'scalar': return type.scalar;
        case 'map': return `map<${type.key}, ${typeText(printer, type.value, scope)}>`;
        case 'message':
        case 'enum': return typeReference(printer.schema, type.name, scope);
    }
}

/**
 * The shortest name that resolves to the target from inside `scope`,
 * following protobuf's rule: the first component is looked up in the
 * scope and then in each enclosing scope, and the rest must exist under
 * the first match. Unknown targets are written as given.
 */
function typeReference(schema: Schema, target: string, scope: string): string {
    if (!schema.types.has(target)) return target;
    const parts = target.split('.');
    for (let i = parts.length - 1; i >= 0; i--) {
        const candidate = parts.slice(i).join('.');
        if (resolve(schema, candidate, scope) === target) return candidate;
    }
    return '.' + target;
}

function resolve(schema: Schema, name: string, scope: string): string | undefined {
    const first = name.slice(0, name.indexOf('.') === -1 ? name.length : name.indexOf('.'));
    let current = scope;
    for (;;) {
        const prefix = current === '' ? '' : current + '.';
        if (nameExists(schema, prefix + first)) {
            const full = prefix + name;
            return schema.types.has(full) ? full : undefined;
        }
        if (current === '') return undefined;
        current = current.includes('.') ? current.slice(0, current.lastIndexOf('.')) : '';
    }
}

/** Whether a name is a type or a package/enclosing prefix of one */
function nameExists(schema: Schema, name: string): boolean {
    if (schema.types.has(name)) return true;
    for (const fullName of schema.types.keys()) {
        if (fullName.startsWith(name + '.')) return true;
    }
    return false;
}

function escapeString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
