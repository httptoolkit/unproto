import { decodeWire, type WireMessage } from './wire.ts';
import type { Problem } from './problem.ts';
import type { NamedType, Schema } from './schema.ts';
import type { AnalysisCache } from './heuristics.ts';
import { Inferrer } from './infer.ts';
import { createContext, extendSchema, findMessageType, inferUnknownFields } from './interpret.ts';

export interface SchemaInferrerOptions {
    /** Name given to the root message type when inferring from scratch. Defaults to 'Message'. */
    readonly rootName?: string;
    readonly recursionLimit?: number;
    /**
     * A schema to extend rather than replace: its types and fields are kept
     * as they are, and only fields it does not define are inferred and added.
     */
    readonly base?: Schema;
    /** With `base`: the full name of the type the samples are instances of. Optional if `base` has one message type. */
    readonly type?: string;
}

/**
 * Infers a schema from any number of messages of the same type. Every
 * sample adds evidence: a field seen more than once in one message is
 * repeated, one absent from some messages is optional, and readings that
 * fit every occurrence win over readings that fit only some.
 */
export class SchemaInferrer {
    private readonly options: SchemaInferrerOptions;
    private readonly recursionLimit: number;
    private readonly samples: WireMessage[] = [];
    private readonly cache: AnalysisCache = new WeakMap();
    private result: { readonly schema: Schema; readonly problems: readonly Problem[] } | undefined;

    constructor(options: SchemaInferrerOptions = {}) {
        this.options = options;
        this.recursionLimit = options.recursionLimit ?? 100;
    }

    /** How many messages have been added */
    get size(): number {
        return this.samples.length;
    }

    add(message: Uint8Array): this {
        this.samples.push(decodeWire(message, { recursionLimit: this.recursionLimit }));
        this.result = undefined;
        return this;
    }

    /** The schema inferred from every message added so far */
    schema(): Schema {
        return this.infer().schema;
    }

    /** Wire-level problems in the samples, and anything inference had to give up on */
    problems(): readonly Problem[] {
        return this.infer().problems;
    }

    private infer(): { readonly schema: Schema; readonly problems: readonly Problem[] } {
        if (this.result) return this.result;
        const problems: Problem[] = this.samples.flatMap(s => s.problems);
        const schema = this.options.base ? this.extend(this.options.base, problems) : this.fresh(problems);
        this.result = { schema, problems };
        return this.result;
    }

    private fresh(problems: Problem[]): Schema {
        const types = new Map<string, NamedType>();
        const inferrer = new Inferrer(types, this.recursionLimit, new Set(), problems, this.cache);
        const root = inferrer.allocateName(this.options.rootName ?? 'Message');
        inferrer.inferMessageType(root, this.samples.map(s => s.fields), 0, []);
        return inferrer.needsEditions
            ? { syntax: 'editions', edition: '2023', types }
            : { syntax: 'proto3', types };
    }

    private extend(base: Schema, problems: Problem[]): Schema {
        const type = findMessageType(base, this.options.type, problems);
        const ctx = createContext(new Map(base.types), new Set(), problems, this.recursionLimit);
        if (type) inferUnknownFields(this.samples.map(s => s.fields), type, ctx, this.cache);
        return extendSchema(base, ctx);
    }
}

/** Infers a schema from messages of one type in a single call. */
export function inferSchema(samples: readonly Uint8Array[], options: SchemaInferrerOptions = {}): Schema {
    const inferrer = new SchemaInferrer(options);
    for (const sample of samples) inferrer.add(sample);
    return inferrer.schema();
}
