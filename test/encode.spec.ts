import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import protobuf from 'protobufjs';
import {
    decode,
    toObject,
    schema,
    messageType,
    enumType,
    fieldDef,
    scalar,
    type Message,
    type PlainObject
} from '../src/index.ts';
import { encodeMessage, encodeObject } from '../src/encode.ts';
import { hex, concat, varint, tag, utf8, lenField, varintField, expectProblem, expectNoProblems } from './test-util.ts';

function toHex(bytes: Uint8Array): string {
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Decodes and re-encodes, expecting a clean decode and identical bytes */
function expectRoundTrip(bytes: Uint8Array): void {
    const result = decode(bytes);
    expectNoProblems(result.problems);
    expect(toHex(encodeMessage(result.message))).to.equal(toHex(bytes));
}

describe('encodeMessage', () => {
    it('round trips scalars of every wire type', () => {
        expectRoundTrip(concat(
            varintField(1, 150),
            hex('11 01 02 03 04 05 06 07 08'),
            lenField(3, 'hello'),
            hex('25 00 00 80 3f'),
            varintField(5, 2n ** 63n - 1n)
        ));
    });

    it('round trips nested messages and their contents', () => {
        expectRoundTrip(hex('1a 05 0a 03 61 62 63'));
        expectRoundTrip(lenField(1, concat(lenField(2, concat(lenField(3, 'deep'), varintField(4, 7))), varintField(5, 8))));
    });

    it('round trips repeated fields interleaved with others', () => {
        expectRoundTrip(concat(varintField(1, 1), lenField(2, 'a'), varintField(1, 2), lenField(2, 'b'), varintField(1, 3)));
    });

    it('round trips packed fields', () => {
        expectRoundTrip(lenField(4, concat(varint(1), varint(2), varint(300), varint(2n ** 40n))));
        expectRoundTrip(concat(lenField(4, hex('01 02 03')), lenField(4, hex('04 05'))));
    });

    it('round trips groups, including nested groups', () => {
        expectRoundTrip(hex('0b 08 05 12 03 61 62 63 0c'));
        expectRoundTrip(concat(tag(1, 3), tag(2, 3), varintField(3, 5), tag(2, 4), lenField(4, 'in'), tag(1, 4), varintField(9, 1)));
    });

    it('round trips the largest field numbers', () => {
        expectRoundTrip(concat(varintField(536870911, 1), lenField(536870911, 'x'), varintField(268435456, 2)));
    });

    it('round trips 64-bit values at full precision', () => {
        expectRoundTrip(concat(
            varintField(1, 2n ** 64n - 1n),
            varintField(2, 2n ** 53n + 1n),
            hex('19 ff ff ff ff ff ff ff ff'),
            hex('21 00 00 00 00 00 00 f0 3f')
        ));
    });

    it('round trips non-canonical varints and length prefixes', () => {
        expectRoundTrip(hex('08 96 81 80 00'));
        expectRoundTrip(hex('12 83 80 00 61 62 63'));
        expectRoundTrip(hex('88 80 00 05'));
        expectRoundTrip(hex('08 ff ff ff ff ff ff ff ff ff 01'));
    });

    it('keeps the size of a record padded in both its tag and its length', () => {
        // The model records only the two widths together, so the padding moves
        const input = hex('92 80 00 83 80 00 61 62 63');
        const output = encodeMessage(decode(input).message);
        expect(output.length).to.equal(input.length);
        expect(toObject(decode(output).message)).to.deep.equal(toObject(decode(input).message));
    });

    for (const name of ['pixelstarships', 'hearthstone']) {
        it(`round trips the ${name} capture exactly`, async () => {
            const bytes = new Uint8Array(await readFile(new URL(`./fixtures/${name}.bin`, import.meta.url)));
            expectRoundTrip(bytes);
        });
    }

    describe('without the original encoding', () => {
        const sample = schema([
            messageType('S', [
                fieldDef({ number: 1, name: 'a', type: scalar('int32') }),
                fieldDef({ number: 2, name: 'b', type: scalar('string') }),
                fieldDef({ number: 3, name: 'c', type: scalar('sint64') }),
                fieldDef({ number: 4, name: 'p', type: scalar('int32'), cardinality: 'repeated' }),
                fieldDef({ number: 5, name: 'u', type: scalar('fixed32'), cardinality: 'repeated', packed: false }),
                fieldDef({ number: 6, name: 'n', type: { kind: 'message', name: 'S' } }),
                fieldDef({ number: 7, name: 'g', type: { kind: 'message', name: 'S' }, delimited: true })
            ])
        ]);

        it('re-encodes canonical input identically from its values', () => {
            const bytes = concat(
                varintField(1, -5),
                lenField(2, 'text'),
                varintField(3, 9),
                lenField(4, concat(varint(1), varint(2), varint(3))),
                concat(tag(5, 5), hex('01 00 00 00'), tag(5, 5), hex('02 00 00 00')),
                lenField(6, varintField(1, 1)),
                concat(tag(7, 3), varintField(1, 2), tag(7, 4))
            );
            const result = decode(bytes, { schema: sample, type: 'S' });
            expectNoProblems(result.problems);
            expect(toHex(encodeMessage(result.message, { preserveEncoding: false }))).to.equal(toHex(bytes));
        });

        it('canonicalises non-canonical encodings', () => {
            const result = decode(hex('08 96 81 80 00'), { schema: sample, type: 'S' });
            expect(toHex(encodeMessage(result.message, { preserveEncoding: false }))).to.equal('089601');
        });
    });

    describe('over randomly generated wire data', () => {
        // A seed keeps failures reproducible; the shapes cover every wire type,
        // nesting, and the redundant padding that real encoders sometimes emit.
        let seed = 0x9e3779b9;
        const next = (): number => {
            seed = (seed + 0x6d2b79f5) | 0;
            let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
        const pick = (limit: number): number => Math.floor(next() * limit);

        /** A varint with `extra` redundant zero groups appended */
        const padded = (value: bigint, extra: number): Uint8Array => {
            const canonical = varint(value);
            if (extra === 0 || canonical.length + extra > 10) return canonical;
            const bytes = new Uint8Array(canonical.length + extra);
            bytes.set(canonical);
            for (let i = 0; i < bytes.length; i++) if (i < bytes.length - 1) bytes[i]! |= 0x80;
            return bytes;
        };

        const randomBytes = (length: number): Uint8Array =>
            new Uint8Array(Array.from({ length }, () => pick(256)));

        const randomRecord = (depth: number): Uint8Array => {
            const number = pick(4) === 0 ? 1 + pick(536870910) : 1 + pick(20);
            switch (pick(depth < 3 ? 6 : 5)) {
                case 0: {
                    const value = BigInt(pick(2 ** 30)) * BigInt(pick(2 ** 30) + 1);
                    return concat(tag(number, 0), padded(value, pick(3)));
                }
                case 1: return concat(tag(number, 1), randomBytes(8));
                case 2: return concat(tag(number, 5), randomBytes(4));
                case 3: return concat(tag(number, 2), padded(BigInt(5), pick(3)), randomBytes(5));
                case 4: {
                    // Padding in the tag instead: only one of the two is recoverable
                    const payload = randomMessage(depth + 1);
                    return concat(padded(BigInt(number) * 8n + 2n, pick(2)), varint(payload.length), payload);
                }
                default: return concat(tag(number, 3), randomMessage(depth + 1), tag(number, 4));
            }
        };

        const randomMessage = (depth: number): Uint8Array =>
            concat(...Array.from({ length: pick(5) }, () => randomRecord(depth)));

        it('re-encodes 500 random messages byte for byte', () => {
            for (let i = 0; i < 500; i++) {
                const bytes = randomMessage(0);
                const result = decode(bytes);
                expect(result.wire.trailing, toHex(bytes)).to.equal(undefined);
                expect(toHex(encodeMessage(result.message)), `message ${i}`).to.equal(toHex(bytes));
            }
        });
    });

    it('encodes fields that have lost their wire records from their values', () => {
        const bytes = concat(varintField(1, 7), lenField(2, 'old'), varintField(3, 9));
        const message = decode(bytes).message;
        const edited: Message = {
            type: message.type,
            fields: new Map([...message.fields].map(([number, field]) => [
                number,
                number === 2
                    ? { ...field, values: [{ kind: 'string' as const, value: 'new' }], raw: [] }
                    : field
            ]))
        };
        // The edited field has no wire position left, so it follows the preserved ones
        expect(toHex(encodeMessage(edited)))
            .to.equal(toHex(concat(varintField(1, 7), varintField(3, 9), lenField(2, 'new'))));
        expect(toObject(decode(encodeMessage(edited)).message)).to.deep.equal({ '1': 7n, '2': 'new', '3': 9n });
    });
});

const colour = enumType('t.Colour', [
    { name: 'COLOUR_UNKNOWN', number: 0 },
    { name: 'RED', number: 1 },
    { name: 'GREEN', number: 2 }
]);

const sampleProto = `
    syntax = "proto3";
    package t;
    enum Colour { COLOUR_UNKNOWN = 0; RED = 1; GREEN = 2; }
    message Nested { int32 x = 1; string y = 2; }
    message Sample {
        int32 i32 = 1;
        int64 i64 = 2;
        uint32 u32 = 3;
        uint64 u64 = 4;
        sint32 s32 = 5;
        sint64 s64 = 6;
        fixed32 f32 = 7;
        fixed64 f64 = 8;
        sfixed32 sf32 = 9;
        sfixed64 sf64 = 10;
        float fl = 11;
        double db = 12;
        bool bo = 13;
        string st = 14;
        bytes by = 15;
        Colour colour = 16;
        Nested nested = 17;
        repeated int32 packed = 18;
        repeated string strings = 19;
        map<string, int32> counts = 20;
        repeated Nested children = 21;
        repeated uint32 unpacked = 22 [packed = false];
    }
`;

const implicit = { presence: 'implicit' } as const;

const sampleSchema = schema([
    colour,
    messageType('t.Nested', [
        fieldDef({ number: 1, name: 'x', type: scalar('int32'), ...implicit }),
        fieldDef({ number: 2, name: 'y', type: scalar('string'), ...implicit })
    ]),
    messageType('t.Sample', [
        fieldDef({ number: 1, name: 'i32', type: scalar('int32'), ...implicit }),
        fieldDef({ number: 2, name: 'i64', type: scalar('int64'), ...implicit }),
        fieldDef({ number: 3, name: 'u32', type: scalar('uint32'), ...implicit }),
        fieldDef({ number: 4, name: 'u64', type: scalar('uint64'), ...implicit }),
        fieldDef({ number: 5, name: 's32', type: scalar('sint32'), ...implicit }),
        fieldDef({ number: 6, name: 's64', type: scalar('sint64'), ...implicit }),
        fieldDef({ number: 7, name: 'f32', type: scalar('fixed32'), ...implicit }),
        fieldDef({ number: 8, name: 'f64', type: scalar('fixed64'), ...implicit }),
        fieldDef({ number: 9, name: 'sf32', type: scalar('sfixed32'), ...implicit }),
        fieldDef({ number: 10, name: 'sf64', type: scalar('sfixed64'), ...implicit }),
        fieldDef({ number: 11, name: 'fl', type: scalar('float'), ...implicit }),
        fieldDef({ number: 12, name: 'db', type: scalar('double'), ...implicit }),
        fieldDef({ number: 13, name: 'bo', type: scalar('bool'), ...implicit }),
        fieldDef({ number: 14, name: 'st', type: scalar('string'), ...implicit }),
        fieldDef({ number: 15, name: 'by', type: scalar('bytes'), ...implicit }),
        fieldDef({ number: 16, name: 'colour', type: { kind: 'enum', name: 't.Colour' }, ...implicit }),
        fieldDef({ number: 17, name: 'nested', type: { kind: 'message', name: 't.Nested' } }),
        fieldDef({ number: 18, name: 'packed', type: scalar('int32'), cardinality: 'repeated' }),
        fieldDef({ number: 19, name: 'strings', type: scalar('string'), cardinality: 'repeated' }),
        fieldDef({ number: 20, name: 'counts', type: { kind: 'map', key: 'string', value: scalar('int32') }, cardinality: 'repeated' }),
        fieldDef({ number: 21, name: 'children', type: { kind: 'message', name: 't.Nested' }, cardinality: 'repeated' }),
        fieldDef({ number: 22, name: 'unpacked', type: scalar('uint32'), cardinality: 'repeated', packed: false })
    ])
], { package: 't' });

const Sample = protobuf.parse(sampleProto).root.lookupType('t.Sample');

/** Encodes with unproto and reads the result back with protobufjs */
function throughProtobufjs(object: PlainObject, type: protobuf.Type = Sample, typeName = 't.Sample'): unknown {
    const result = encodeObject(object, sampleSchema, typeName);
    expectNoProblems(result.problems);
    return type.toObject(type.decode(result.bytes), { longs: String, enums: String, bytes: Array });
}

describe('encodeObject', () => {
    it('encodes every scalar type as protobufjs reads it', () => {
        expect(throughProtobufjs({
            i32: -7,
            i64: '9007199254740993',
            u32: 4294967295,
            u64: 18446744073709551615n,
            s32: -3,
            s64: -9007199254740993n,
            f32: 4294967295n,
            f64: 2n ** 64n - 1n,
            sf32: -2147483648,
            sf64: -9223372036854775808n,
            fl: -0.5,
            db: 3.25,
            bo: true,
            st: 'Hello, world! ←',
            by: new Uint8Array([0xff, 0x00, 0x01])
        })).to.deep.equal({
            i32: -7,
            i64: '9007199254740993',
            u32: 4294967295,
            u64: '18446744073709551615',
            s32: -3,
            s64: '-9007199254740993',
            f32: 4294967295,
            f64: '18446744073709551615',
            sf32: -2147483648,
            sf64: '-9223372036854775808',
            fl: -0.5,
            db: 3.25,
            bo: true,
            st: 'Hello, world! ←',
            by: [0xff, 0x00, 0x01]
        });
    });

    it('encodes enums by name or by number', () => {
        expect(throughProtobufjs({ colour: 'GREEN' })).to.deep.equal({ colour: 'GREEN' });
        expect(throughProtobufjs({ colour: 2 })).to.deep.equal({ colour: 'GREEN' });
        expect(throughProtobufjs({ colour: 7n })).to.deep.equal({ colour: 7 });
    });

    it('encodes nested and repeated messages', () => {
        expect(throughProtobufjs({
            nested: { x: 1, y: 'one' },
            children: [{ x: 2 }, { y: 'three' }]
        })).to.deep.equal({
            nested: { x: 1, y: 'one' },
            children: [{ x: 2 }, { y: 'three' }]
        });
    });

    it('encodes maps as objects or as entry lists', () => {
        expect(throughProtobufjs({ counts: { a: 1, b: 2 } })).to.deep.equal({ counts: { a: 1, b: 2 } });
        expect(throughProtobufjs({ counts: [{ key: 'a', value: 1 }, { key: 'b', value: 2 }] }))
            .to.deep.equal({ counts: { a: 1, b: 2 } });
    });

    it('encodes repeated fields packed or unpacked as the definition says', () => {
        const result = encodeObject({ packed: [1, 2, 300], unpacked: [4, 5], strings: ['one', 'two'] }, sampleSchema, 't.Sample');
        expectNoProblems(result.problems);
        expect(toHex(result.bytes)).to.equal(toHex(concat(
            lenField(18, concat(varint(1), varint(2), varint(300))),
            lenField(19, 'one'),
            lenField(19, 'two'),
            varintField(22, 4),
            varintField(22, 5)
        )));
        expect(Sample.toObject(Sample.decode(result.bytes)))
            .to.deep.equal({ packed: [1, 2, 300], unpacked: [4, 5], strings: ['one', 'two'] });
    });

    it('accepts a single value for a repeated field', () => {
        expect(throughProtobufjs({ packed: 5, children: { x: 1 } }))
            .to.deep.equal({ packed: [5], children: [{ x: 1 }] });
    });

    it('accepts numbers, decimal strings and bytes lists for their types', () => {
        expect(throughProtobufjs({ i64: 12, u64: '18446744073709551615', db: '3.5', bo: 1n, by: [1, 2, 3] }))
            .to.deep.equal({ i64: '12', u64: '18446744073709551615', db: 3.5, bo: true, by: [1, 2, 3] });
    });

    it('accepts keys by field number as well as by name', () => {
        expect(throughProtobufjs({ '1': -7, '14': 'text', '17': { '2': 'y' } }))
            .to.deep.equal({ i32: -7, st: 'text', nested: { y: 'y' } });
    });

    it('emits fields in ascending field number order', () => {
        const result = encodeObject({ st: 'z', i32: 1, nested: {}, u32: 3 }, sampleSchema, 't.Sample');
        expectNoProblems(result.problems);
        expect([...decode(result.bytes).message.fields.keys()]).to.deep.equal([1, 3, 14, 17]);
    });

    it('skips implicit-presence values that equal the type default', () => {
        const result = encodeObject({
            i32: 0,
            u64: 0n,
            fl: 0,
            bo: false,
            st: '',
            by: new Uint8Array(0),
            colour: 0,
            packed: []
        }, sampleSchema, 't.Sample');
        expectNoProblems(result.problems);
        expect(result.bytes.length).to.equal(0);
    });

    it('emits explicit-presence values that equal the type default', () => {
        const explicit = schema([messageType('E', [
            fieldDef({ number: 1, name: 'a', type: scalar('int32') }),
            fieldDef({ number: 2, name: 'b', type: scalar('string') })
        ])]);
        const result = encodeObject({ a: 0, b: '' }, explicit);
        expectNoProblems(result.problems);
        expect(toHex(result.bytes)).to.equal(toHex(concat(varintField(1, 0), lenField(2, ''))));
    });

    it('matches what protobufjs encodes for the same values', () => {
        const values = {
            i32: -7,
            u32: 4294967295,
            s32: -3,
            f64: '1234',
            fl: -0.5,
            bo: true,
            st: 'text',
            by: new Uint8Array([1, 2]),
            colour: 'RED',
            nested: { x: 5, y: 'nested' },
            packed: [1, 2, 300],
            strings: ['one', 'two'],
            counts: { key: 7 },
            children: [{ x: 1 }, { x: 2 }],
            unpacked: [8, 9]
        };
        const expected = Sample.encode(Sample.fromObject(values)).finish();
        const result = encodeObject({ ...values, i64: 0, f32: 0 }, sampleSchema, 't.Sample');
        expectNoProblems(result.problems);
        expect(toHex(result.bytes)).to.equal(toHex(new Uint8Array(expected)));
    });

    it('encodes groups with start and end tags', () => {
        const groupProto = protobuf.parse(`
            syntax = "proto2";
            message Outer {
                optional group Item = 1 {
                    optional int32 x = 1;
                    optional string y = 2;
                }
                repeated group Many = 2 { optional int32 z = 1; }
                optional int32 after = 3;
            }
        `).root.lookupType('Outer');
        const groupSchema = schema([
            messageType('Outer', [
                fieldDef({ number: 1, name: 'item', type: { kind: 'message', name: 'Item' }, delimited: true }),
                fieldDef({ number: 2, name: 'many', type: { kind: 'message', name: 'Many' }, delimited: true, cardinality: 'repeated' }),
                fieldDef({ number: 3, name: 'after', type: scalar('int32') })
            ]),
            messageType('Item', [
                fieldDef({ number: 1, name: 'x', type: scalar('int32') }),
                fieldDef({ number: 2, name: 'y', type: scalar('string') })
            ]),
            messageType('Many', [fieldDef({ number: 1, name: 'z', type: scalar('int32') })])
        ], { syntax: 'proto2' });

        const result = encodeObject({ item: { x: 9, y: 'why' }, many: [{ z: 1 }, { z: 2 }], after: 4 }, groupSchema, 'Outer');
        expectNoProblems(result.problems);
        expect(toHex(result.bytes)).to.equal(toHex(concat(
            tag(1, 3), varintField(1, 9), lenField(2, 'why'), tag(1, 4),
            tag(2, 3), varintField(1, 1), tag(2, 4),
            tag(2, 3), varintField(1, 2), tag(2, 4),
            varintField(3, 4)
        )));
        expect(groupProto.toObject(groupProto.decode(result.bytes)))
            .to.deep.equal({ item: { x: 9, y: 'why' }, many: [{ z: 1 }, { z: 2 }], after: 4 });
    });

    it('round trips a decoded message through toObject and back to the same bytes', () => {
        const values = {
            i32: 1,
            i64: '9007199254740993',
            s64: -2,
            sf32: -7,
            db: 1.5,
            bo: true,
            st: 'text',
            by: new Uint8Array([0xff, 0x01]),
            colour: 'GREEN',
            nested: { x: 5, y: 'nested' },
            packed: [1, 2, 300],
            strings: ['one', 'two'],
            counts: { a: 1, b: 2 },
            children: [{ x: 1 }, { x: 2 }],
            unpacked: [8, 9]
        };
        const bytes = new Uint8Array(Sample.encode(Sample.fromObject(values)).finish());
        const decoded = decode(bytes, { schema: sampleSchema, type: 't.Sample' });
        expectNoProblems(decoded.problems);

        const result = encodeObject(toObject(decoded.message), sampleSchema, 't.Sample');
        expectNoProblems(result.problems);
        expect(toHex(result.bytes)).to.equal(toHex(bytes));
    });

    it('picks the only message type when none is named', () => {
        const single = schema([messageType('Only', [fieldDef({ number: 1, name: 'a', type: scalar('int32') })])]);
        const result = encodeObject({ a: 5 }, single);
        expectNoProblems(result.problems);
        expect(toHex(result.bytes)).to.equal(toHex(varintField(1, 5)));
    });

    it('reports an ambiguous or unknown type name', () => {
        const ambiguous = encodeObject({ i32: 1 }, sampleSchema);
        expectProblem(ambiguous.problems, 'unknown-type');
        expect(ambiguous.bytes.length).to.equal(0);

        const missing = encodeObject({ i32: 1 }, sampleSchema, 't.Missing');
        expectProblem(missing.problems, 'unknown-type');
        expect(missing.bytes.length).to.equal(0);

        const notAMessage = encodeObject({ i32: 1 }, sampleSchema, 't.Colour');
        expectProblem(notAMessage.problems, 'unknown-type');

        const noTypes = encodeObject({ a: 1 }, schema([colour]));
        expectProblem(noTypes.problems, 'unknown-type');
    });

    it('reports fields the schema does not define and encodes the rest', () => {
        const result = encodeObject({ i32: 1, nope: 2, '99': 3 }, sampleSchema, 't.Sample');
        expect(result.problems.map(p => p.code)).to.deep.equal(['unknown-field', 'unknown-field']);
        expect(result.problems.map(p => p.message).join(' ')).to.contain('nope').and.to.contain('99');
        expect(toHex(result.bytes)).to.equal(toHex(varintField(1, 1)));
    });

    it('reports values that do not fit the field type', () => {
        const badValues: PlainObject[] = [
            { i32: 2n ** 40n },
            { u32: -1 },
            { i64: 2n ** 64n },
            { u64: -5n },
            { i32: 1.5 },
            { i32: 'not a number' },
            { st: { a: 1 } },
            { by: [1, 2, 999] },
            { nested: 'not a message' },
            { colour: 'PUCE' },
            { db: 'not a number' },
            { counts: 5 }
        ];
        for (const object of badValues) {
            const result = encodeObject(object, sampleSchema, 't.Sample');
            expectProblem(result.problems, 'invalid-value');
            expect(toHex(result.bytes), JSON.stringify(Object.keys(object))).to.equal('');
        }
    });

    it('skips only the values that do not fit', () => {
        const result = encodeObject({ i32: 2n ** 40n, st: 'kept', packed: [1, 'no', 3] }, sampleSchema, 't.Sample');
        expect(result.problems.map(p => p.code)).to.deep.equal(['invalid-value', 'invalid-value']);
        expect(toHex(result.bytes)).to.equal(toHex(concat(
            lenField(14, 'kept'),
            lenField(18, concat(varint(1), varint(3)))
        )));
    });

    it('writes a string that is not valid UTF-8 back as its bytes', () => {
        const bytes = hex('ff fe fd');
        const result = encodeObject({ st: bytes }, sampleSchema, 't.Sample');
        expectNoProblems(result.problems);
        expect(toHex(result.bytes)).to.equal(toHex(lenField(14, bytes)));
    });

    it('reports a message type the schema refers to but does not define', () => {
        const broken = schema([messageType('B', [
            fieldDef({ number: 1, name: 'inner', type: { kind: 'message', name: 'Gone' } })
        ])]);
        const result = encodeObject({ inner: { x: 1 } }, broken, 'B');
        expectProblem(result.problems, 'unknown-type');
        expect(result.bytes.length).to.equal(0);
    });

    it('accepts pre-encoded bytes for a nested message', () => {
        const result = encodeObject({ nested: utf8('') }, sampleSchema, 't.Sample');
        expectNoProblems(result.problems);
        const inner = encodeObject({ x: 1 }, sampleSchema, 't.Nested');
        const withBytes = encodeObject({ nested: inner.bytes }, sampleSchema, 't.Sample');
        expect(toHex(withBytes.bytes)).to.equal(toHex(lenField(17, inner.bytes)));
        expect(toHex(result.bytes)).to.equal(toHex(lenField(17, new Uint8Array(0))));
    });
});
