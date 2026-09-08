import { decodeWire, type WireMessage } from './wire.ts';
import type { Problem } from './problem.ts';
import type { MessageType, NamedType, Schema } from './schema.ts';
import type { Message } from './values.ts';
import { inferSchemaFromWire } from './infer.ts';
import { createContext, extendSchema, findMessageType, inferUnknownFields, interpretMessage } from './interpret.ts';

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
    const ctx = createContext(types, inferred, problems, recursionLimit);

    if (options.schema && type) inferUnknownFields([wire.fields], type, ctx);
    const message = interpretMessage(wire.fields, type, ctx, [], 0);

    return {
        message,
        schema: options.schema && (inferred.size > 0 || ctx.extensions.size > 0) ? extendSchema(schema, ctx) : schema,
        wire,
        problems
    };
}
