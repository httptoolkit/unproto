import { expect } from 'chai';
import protobuf from 'protobufjs';
import { decode, toObject, type PlainValue } from '../src/index.ts';

// A seeded corpus of random schemas and messages, encoded by protobufjs, decoded
// without a schema and scored against what the bytes actually contain. This guards
// the heuristics against regressions: the thresholds sit a little below the
// measured accuracy, and any change that moves them should be deliberate.

let seed = 12345;
const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)]!;
const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

const WORDS = ['id', 'user', 'Hello, World!', 'jane@example.com', 'https://example.com/api/v1?x=1', 'ok', 'en', 'US', 'a', 'PP',
    '((((', 'hi', 'The quick brown fox', 'Ünïcödé ← →', '日本語テキスト', '2024-01-01T00:00:00Z', 'true', '{"json":1}', 'AB', 'x'];
const SCALARS = ['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool', 'double', 'float',
    'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'string', 'bytes'] as const;

interface FieldSpec { id: number; type: string; rule?: 'repeated'; options?: { packed: boolean } }
interface SchemaSpec { fields: Record<string, FieldSpec>; nested: Record<string, SchemaSpec> }

function randomSchema(depth: number): SchemaSpec {
    const fields: Record<string, FieldSpec> = {};
    const nested: Record<string, SchemaSpec> = {};
    const used = new Set<number>();
    const count = int(1, 7);
    for (let i = 0; i < count; i++) {
        let id: number;
        do { id = rand() < 0.02 ? int(41, 536870911) : int(1, 40); } while (used.has(id));
        used.add(id);
        const field: FieldSpec = { id, type: rand() < 0.2 && depth < 2 ? 'message' : pick(SCALARS) };
        if (field.type === 'message') {
            field.type = `N${id}`;
            nested[field.type] = randomSchema(depth + 1);
        }
        if (rand() < 0.25) {
            field.rule = 'repeated';
            if (rand() < 0.3) field.options = { packed: false };
        }
        fields[`f${id}`] = field;
    }
    return { fields, nested };
}

type Json = string | number | boolean | Uint8Array | Json[] | { [key: string]: Json };

function randomValue(type: string, schema: SchemaSpec): Json {
    switch (type) {
        case 'int32': return pick([0, 1, 7, 150, -1, -5, 2147483647, -2147483648, int(0, 100000)]);
        case 'int64': return pick(['0', '1', '-1', '9007199254740993', '-9007199254740993', String(int(0, 1e9)), '9223372036854775807']);
        case 'uint32': return pick([0, 1, 255, 4294967295, int(0, 1e6)]);
        case 'uint64': return pick(['0', '3', '18446744073709551615', String(int(0, 1e9))]);
        case 'sint32': return pick([0, -1, 1, -1000, 1000]);
        case 'sint64': return pick(['0', '-1', '5', '-4611686018427387904']);
        case 'bool': return rand() < 0.5;
        case 'double': return pick([0, 1, -1.5, 3.14159, 1727340414.715315, 1e-3, -123456.789]);
        case 'float': return pick([0, 1, 2.5, -0.5, 100.25]);
        case 'fixed32': case 'sfixed32': return pick([0, 1, 7, 1000, 123456, type === 'sfixed32' ? -3 : 99999]);
        case 'fixed64': case 'sfixed64': return pick(['0', '1', '1234', '99999999', type === 'sfixed64' ? '-7' : '123456789012']);
        case 'string': return rand() < 0.1 ? '' : pick(WORDS);
        case 'bytes': {
            const out = new Uint8Array(pick([0, 1, 2, 4, 8, 16, 24]));
            const ascii = rand() < 0.2;
            for (let i = 0; i < out.length; i++) out[i] = ascii ? int(0x20, 0x7e) : int(0, 255);
            return out;
        }
        default: return randomMessage(schema.nested[type]!);
    }
}

function randomMessage(schema: SchemaSpec): { [key: string]: Json } {
    const obj: { [key: string]: Json } = {};
    for (const [name, field] of Object.entries(schema.fields)) {
        if (rand() < 0.2) continue;
        obj[name] = field.rule === 'repeated'
            ? Array.from({ length: pick([0, 2, 2, 3, 4]) }, () => randomValue(field.type, schema))
            : randomValue(field.type, schema);
    }
    return obj;
}

// Canonical forms so that both sides compare the same way: every number as a decimal
// string, empty string/bytes/message all as 'empty' since they are indistinguishable.
type Canon = string | Canon[] | { [key: string]: Canon };

function canon(v: PlainValue): Canon {
    if (typeof v === 'bigint' || typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? '1' : '0';
    if (typeof v === 'string') return v === '' ? 'empty' : 's:' + v;
    if (v instanceof Uint8Array) return v.length === 0 ? 'empty' : 'b:' + Buffer.from(v).toString('hex');
    if (Array.isArray(v)) return v.map(canon);
    const keys = Object.keys(v);
    if (keys.length === 0) return 'empty';
    const out: { [key: string]: Canon } = {};
    for (const k of keys.sort((a, b) => Number(a) - Number(b))) out[k] = canon(v[k]!);
    return out;
}

/** What a schemaless decoder could ideally recover from the encoded object */
function expectedShape(schema: SchemaSpec, obj: { [key: string]: Json }): Canon {
    const out: { [key: string]: Canon } = {};
    for (const [name, field] of Object.entries(schema.fields)) {
        if (!(name in obj)) continue;
        const conv = (v: Json): Canon => {
            switch (field.type) {
                case 'sint32': case 'sint64': { const n = BigInt(v as string | number); return ((n << 1n) ^ (n >> 63n)).toString(); }
                case 'bool': return v ? '1' : '0';
                case 'float': return String(Math.fround(v as number));
                case 'string': return v === '' ? 'empty' : 's:' + (v as string);
                case 'bytes': return (v as Uint8Array).length === 0 ? 'empty' : 'b:' + Buffer.from(v as Uint8Array).toString('hex');
                case 'int32': case 'int64': case 'uint32': case 'uint64': case 'double':
                case 'fixed32': case 'fixed64': case 'sfixed32': case 'sfixed64': return String(v);
                default: return expectedShape(schema.nested[field.type]!, v as { [key: string]: Json });
            }
        };
        if (field.rule === 'repeated') {
            const values = (obj[name] as Json[]).map(conv);
            if (values.length === 0) continue;
            out[String(field.id)] = values.length === 1 ? values[0]! : values;
        } else {
            out[String(field.id)] = conv(obj[name]!);
        }
    }
    return Object.keys(out).length === 0 ? 'empty' : out;
}

function leaves(v: Canon, prefix = '', out = new Map<string, string>()): Map<string, string> {
    if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${prefix}[${i}]`, out));
    else if (typeof v === 'object') for (const k of Object.keys(v)) leaves(v[k]!, `${prefix}/${k}`, out);
    else out.set(prefix, v);
    return out;
}

function toProtobufJs(schema: SchemaSpec): protobuf.INamespace {
    const nested: { [key: string]: protobuf.AnyNestedObject } = {};
    for (const [name, s] of Object.entries(schema.nested)) nested[name] = toProtobufJs(s) as protobuf.AnyNestedObject;
    return { fields: schema.fields, nested } as protobuf.INamespace;
}

describe('schemaless decoding of a random protobufjs corpus', function () {
    this.timeout(30000);

    it('recovers most of the encoded structure and values', () => {
        const N = 1500;
        let messages = 0;
        let exact = 0;
        let leafOk = 0;
        let leafTotal = 0;

        for (let i = 0; i < N; i++) {
            seed = 1000 + i;
            const schema = randomSchema(0);
            const root = protobuf.Root.fromJSON({ nested: { Root: toProtobufJs(schema) } });
            const Root = root.lookupType('Root');
            const bytes = Root.encode(Root.fromObject(randomMessage(schema))).finish();
            if (bytes.length === 0) continue;

            // Ground truth is what protobufjs itself reads back, so defaults it skipped are excluded
            const onWire = Root.toObject(Root.decode(bytes), { longs: String, bytes: Buffer, defaults: false }) as { [key: string]: Json };
            const expected = expectedShape(schema, onWire);
            const actual = canon(toObject(decode(bytes).message));

            messages++;
            if (JSON.stringify(actual) === JSON.stringify(expected)) exact++;
            const actualLeaves = leaves(actual);
            for (const [path, value] of leaves(expected)) {
                leafTotal++;
                if (actualLeaves.get(path) === value) leafOk++;
            }
        }

        const exactRatio = exact / messages;
        const leafRatio = leafOk / leafTotal;
        console.log(`      corpus: ${messages} messages, ${(100 * exactRatio).toFixed(1)}% exact, ${(100 * leafRatio).toFixed(1)}% of ${leafTotal} values`);
        expect(messages).to.be.greaterThan(N * 0.9);
        expect(exactRatio).to.be.greaterThan(0.68);
        expect(leafRatio).to.be.greaterThan(0.9);
    });
});
