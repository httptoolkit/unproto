import { decodeWire, type WireMessage } from './wire.ts';
import type { Problem } from './problem.ts';
import type { FieldDef, MessageType, NamedType, Schema } from './schema.ts';
import type { Message } from './values.ts';
import { Inferrer, inferSchemaFromWire } from './infer.ts';
import { collectUnknownFields, interpretMessage, type InterpretContext, type UnknownFieldGroup } from './interpret.ts';

export interface DecodeOptions {
    /** Decode against this schema. Without one, a schema is inferred from the message itself. */
    readonly schema?: Schema;
    /** Full name of the message type to decode as. Required with a schema that has several types. */
    readonly type?: string;
    /** Name given to the inferred root type when no schema is provided. Defaults to 'Message'. */
    readonly rootName?: string;
    /** Maximum message nesting depth. Defaults to 100. */
    readonly recursionLimit?: number;
}

export interface DecodeResult {
    readonly message: Message;
    /**
     * The schema the message was decoded with: the one supplied, extended
     * with any types inferred for unknown fields, or a wholly inferred one.
     */
    readonly schema: Schema;
    readonly wire: WireMessage;
    /** Everything that went wrong, at the wire level or against the schema. Empty for a clean decode. */
    readonly problems: readonly Problem[];
}

/**
 * Decodes a protobuf message. Never throws for malformed input: whatever
 * could be read is returned, with the issues listed in `problems`.
 */
export function decode(input: Uint8Array, options: DecodeOptions = {}): DecodeResult {
    const recursionLimit = options.recursionLimit ?? 100;
    const wire = decodeWire(input, { recursionLimit });
    const problems: Problem[] = [...wire.problems];

    let schema: Schema;
    let type: MessageType | undefined;
    if (options.schema) {
        schema = options.schema;
        type = findMessageType(schema, options.type, problems);
    } else {
        const rootName = options.rootName ?? 'Message';
        schema = inferSchemaFromWire([wire], { rootName, recursionLimit }, problems);
        type = schema.types.get(rootName) as MessageType;
    }

    const types = new Map<string, NamedType>(schema.types);
    const inferred = new Set<string>(options.schema ? [] : types.keys());
    const extensions = new Map<string, Map<number, FieldDef>>();
    const ctx: InterpretContext = { types, inferred, extensions, problems, recursionLimit };

    if (options.schema && type) inferUnknownFields(wire, type, ctx);
    const message = interpretMessage(wire.fields, type, ctx, [], 0);

    return {
        message,
        schema: options.schema && (inferred.size > 0 || extensions.size > 0) ? extendSchema(schema, ctx) : schema,
        wire,
        problems
    };
}

/**
 * Infers every field the schema lacks before interpretation, each from all
 * of its occurrences at once, so that every instance of a type sees the
 * same definition and nothing is re-inferred (or replaced) along the way.
 */
function inferUnknownFields(wire: WireMessage, type: MessageType, ctx: InterpretContext): void {
    const groups = new Map<string, UnknownFieldGroup>();
    collectUnknownFields(wire.fields, type, ctx, [], 0, groups);
    if (groups.size === 0) return;
    const inferrer = new Inferrer(ctx.types, ctx.recursionLimit, ctx.inferred, ctx.problems);
    for (const group of groups.values()) {
        const def = inferrer.inferField(group.number, group.perSample, group.typeName, group.depth, group.path);
        let fields = ctx.extensions.get(group.typeName);
        if (!fields) {
            fields = new Map();
            ctx.extensions.set(group.typeName, fields);
        }
        fields.set(group.number, def);
    }
}

/** The supplied schema plus inferred types, with inferred fields added to the types they were found in */
function extendSchema(schema: Schema, ctx: InterpretContext): Schema {
    const types = new Map(ctx.types);
    for (const [typeName, fields] of ctx.extensions) {
        const original = types.get(typeName);
        if (original?.kind !== 'message') continue;
        types.set(typeName, { ...original, fields: new Map([...original.fields, ...fields]) });
    }
    return { ...schema, types };
}

function findMessageType(schema: Schema, name: string | undefined, problems: Problem[]): MessageType | undefined {
    if (name === undefined) {
        const messages = [...schema.types.values()].filter((t): t is MessageType => t.kind === 'message');
        if (messages.length === 1) return messages[0];
        problems.push({
            code: 'unknown-type',
            message: messages.length === 0
                ? 'The schema defines no message types; decoding heuristically'
                : 'The schema defines several message types and none was chosen; decoding heuristically'
        });
        return undefined;
    }
    const type = schema.types.get(name);
    if (type?.kind === 'message') return type;
    problems.push({
        code: 'unknown-type',
        message: type
            ? `${name} is an enum, not a message; decoding heuristically`
            : `Message type ${name} is not defined in the schema; decoding heuristically`
    });
    return undefined;
}
