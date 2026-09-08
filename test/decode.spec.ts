import { expect } from 'chai';
import {
    decode,
    toObject,
    schema,
    messageType,
    enumType,
    fieldDef,
    scalar,
    type Field,
    type MessageType,
    type Value
} from '../src/index.ts';
import { hex, concat, varint, varintField, lenField, utf8, expectProblem, expectNoProblems } from './test-util.ts';

function field(input: Uint8Array, number: number): Field {
    const result = decode(input);
    const field = result.message.fields.get(number);
    expect(field, `field ${number} missing from ${JSON.stringify([...result.message.fields.keys()])}`).to.not.equal(undefined);
    return field!;
}

function kinds(values: readonly Value[]): string[] {
    return values.map(v => v.kind);
}

describe('decode without a schema', () => {
    it('decodes varints as int64 bigints', () => {
        const f = field(hex('08 96 01'), 1);
        expect(f.values).to.deep.equal([{ kind: 'int64', value: 150n }]);
        expect(f.def).to.deep.include({ name: 'field_1', cardinality: 'optional', packed: false });
    });

    it('decodes 10-byte varints as negative numbers', () => {
        expect(field(hex('08 ff ff ff ff ff ff ff ff ff 01'), 1).values).to.deep.equal([{ kind: 'int64', value: -1n }]);
    });

    it('keeps full 64-bit precision', () => {
        const value = 2n ** 53n + 1n;
        expect(field(varintField(1, value), 1).values).to.deep.equal([{ kind: 'int64', value }]);
        expect(field(varintField(1, 2n ** 63n - 1n), 1).values).to.deep.equal([{ kind: 'int64', value: 2n ** 63n - 1n }]);
    });

    it('decodes the highest field numbers correctly', () => {
        const result = decode(hex('f8 ff ff ff 0f 01'));
        expectNoProblems(result.problems);
        expect([...result.message.fields.keys()]).to.deep.equal([536870911]);
        expect(toObject(result.message)).to.deep.equal({ '536870911': 1n });
        expect(toObject(decode(hex('80 80 80 80 08 01')).message)).to.deep.equal({ '268435456': 1n });
    });

    it('decodes fixed64 as double when the bits look like a float', () => {
        expect(field(hex('09 00 00 00 00 00 00 f0 3f'), 1).values).to.deep.equal([{ kind: 'double', value: 1 }]);
        expect(field(hex('09 00 00 00 00 00 c0 5e c0'), 1).values).to.deep.equal([{ kind: 'double', value: -123 }]);
    });

    it('decodes fixed64 as an integer otherwise', () => {
        const f = field(hex('09 05 00 00 00 00 00 00 00'), 1);
        expect(f.values).to.deep.equal([{ kind: 'fixed64', value: 5n }]);
        expect(f.alternatives.map(a => a.type)).to.deep.equal([scalar('sfixed64'), scalar('double')]);
        expect(field(hex('09 ff ff ff ff ff ff ff ff'), 1).values).to.deep.equal([{ kind: 'sfixed64', value: -1n }]);
    });

    it('decodes fixed32 as float or integer', () => {
        expect(field(hex('0d 00 00 80 3f'), 1).values).to.deep.equal([{ kind: 'float', value: 1 }]);
        expect(field(hex('0d 07 00 00 00'), 1).values).to.deep.equal([{ kind: 'fixed32', value: 7n }]);
    });

    it('decodes strings, including non-ASCII UTF-8', () => {
        expect(field(lenField(2, 'hello'), 2).values).to.deep.equal([{ kind: 'string', value: 'hello' }]);
        expect(field(lenField(2, 'Hello World with UTF8 ←'), 2).values)
            .to.deep.equal([{ kind: 'string', value: 'Hello World with UTF8 ←' }]);
    });

    it('reads short strings as strings even when they parse as messages', () => {
        for (const text of ['PP', '((((', 'hi', 'A', 'HA', 'ok', 'en']) {
            expect(field(lenField(1, text), 1).values, text).to.deep.equal([{ kind: 'string', value: text }]);
        }
    });

    it('offers the message reading of an ambiguous string as an alternative', () => {
        const f = field(lenField(1, 'hi'), 1);
        const alt = f.alternatives.find(a => a.type.kind === 'message');
        expect(alt).to.not.equal(undefined);
        const nested = alt!.values[0]!;
        expect(nested.kind).to.equal('message');
        expect(toObject((nested as Value & { kind: 'message' }).value)).to.deep.equal({ '13': 105n });
        expect(f.alternatives.some(a => a.type.kind === 'scalar' && a.type.scalar === 'bytes')).to.equal(true);
    });

    it('decodes nested messages', () => {
        const result = decode(hex('1a 05 0a 03 61 62 63'));
        expectNoProblems(result.problems);
        const f = result.message.fields.get(3)!;
        expect(kinds(f.values)).to.deep.equal(['message']);
        expect(f.def!.type).to.deep.equal({ kind: 'message', name: 'Message.Field3' });
        expect(toObject(result.message)).to.deep.equal({ '3': { '1': 'abc' } });
        expect((result.schema.types.get('Message.Field3') as MessageType).fields.get(1)!.type).to.deep.equal(scalar('string'));
    });

    it('prefers a message reading when the structure is convincing', () => {
        // Field 1 = " A": rawprotoparse 0.0.9 rendered this as the string "\n\x02 A"
        expect(toObject(decode(hex('12 04 0a 02 20 41')).message)).to.deep.equal({ '2': { '1': ' A' } });
    });

    it('decodes invalid UTF-8 as bytes', () => {
        const f = field(hex('12 03 ff fe fd'), 2);
        expect(f.values).to.deep.equal([{ kind: 'bytes', value: hex('ff fe fd') }]);
    });

    it('decodes bytes containing NUL as bytes', () => {
        const payload = hex('00 01 02 00 ff');
        expect(field(lenField(2, payload), 2).values).to.deep.equal([{ kind: 'bytes', value: payload }]);
    });

    it('detects packed varints', () => {
        const f = field(hex('1a 03 01 02 03'), 3);
        expect(f.values).to.deep.equal([{ kind: 'int64', value: 1n }, { kind: 'int64', value: 2n }, { kind: 'int64', value: 3n }]);
        expect(f.def).to.deep.include({ cardinality: 'repeated', packed: true });
        expect(toObject(decode(hex('1a 03 01 02 03')).message)).to.deep.equal({ '3': [1n, 2n, 3n] });
    });

    it('uses an unpacked occurrence as evidence that a payload is packed', () => {
        // Field 1 appears as a varint and as a length-delimited [6, 7]
        const f = field(hex('08 05 0a 02 06 07'), 1);
        expect(f.values).to.deep.equal([{ kind: 'int64', value: 5n }, { kind: 'int64', value: 6n }, { kind: 'int64', value: 7n }]);
        expect(f.def).to.deep.include({ cardinality: 'repeated', packed: true });
    });

    it('detects packed floats', () => {
        const f = field(hex('22 08 00 00 80 3f 00 00 20 40'), 4);
        expect(f.values).to.deep.equal([{ kind: 'float', value: 1 }, { kind: 'float', value: 2.5 }]);
        expect(f.def).to.deep.include({ packed: true });
    });

    it('keeps every value of a repeated field, including a falsy first one', () => {
        expect(toObject(decode(hex('08 00 08 05')).message)).to.deep.equal({ '1': [0n, 5n] });
    });

    it('decodes an empty length-delimited value as an empty string', () => {
        const f = field(hex('12 00'), 2);
        expect(f.values).to.deep.equal([{ kind: 'string', value: '' }]);
        expect(f.def!.presence).to.equal('explicit');
    });

    it('decodes groups as delimited messages and switches the schema to editions', () => {
        const result = decode(hex('0b 08 01 0c'));
        expectNoProblems(result.problems);
        expect(toObject(result.message)).to.deep.equal({ '1': { '1': 1n } });
        expect(result.message.fields.get(1)!.def).to.deep.include({ delimited: true });
        expect(result.schema.syntax).to.equal('editions');
        expect(result.schema.edition).to.equal('2023');
    });

    it('uses proto3 when no groups are present', () => {
        expect(decode(hex('08 01')).schema.syntax).to.equal('proto3');
    });

    it('decodes repeated nested messages', () => {
        const input = concat(lenField(1, hex('08 01')), lenField(1, hex('08 02')));
        const result = decode(input);
        expect(toObject(result.message)).to.deep.equal({ '1': [{ '1': 1n }, { '1': 2n }] });
    });

    it('lists integer alternatives for varints', () => {
        expect(field(hex('08 01'), 1).alternatives.map(a => a.type)).to.deep.equal([
            scalar('int32'), scalar('uint64'), scalar('sint64'), scalar('bool')
        ]);
        expect(field(hex('08 05'), 1).alternatives.map(a => a.type)).to.deep.equal([
            scalar('int32'), scalar('uint64'), scalar('sint64')
        ]);
        expect(field(varintField(1, 2n ** 40n), 1).alternatives.map(a => a.type)).to.deep.equal([
            scalar('uint64'), scalar('sint64')
        ]);
    });

    it('interprets alternatives with their own type', () => {
        const f = field(hex('08 03'), 1);
        const sint = f.alternatives.find(a => a.type.kind === 'scalar' && a.type.scalar === 'sint64')!;
        expect(sint.values).to.deep.equal([{ kind: 'sint64', value: -2n }]);
    });

    it('returns partial results and problems for truncated input', () => {
        const result = decode(hex('08 01 12 05 61'));
        expectProblem(result.problems, 'truncated', 2);
        expect(toObject(result.message)).to.deep.equal({ '1': 1n });
        expect(result.wire.trailing).to.deep.equal({ start: 2, end: 5 });
    });

    it('falls back to bytes when a payload is not a message, string or packed list', () => {
        // A valid field followed by a truncated tag: not a message, not UTF-8, not varints
        const inner = hex('08 01 8c');
        const result = decode(lenField(2, inner));
        expect(result.message.fields.get(2)!.values).to.deep.equal([{ kind: 'bytes', value: inner }]);
        expectNoProblems(result.problems);
    });

    it('reads three small bytes as a packed list rather than bytes', () => {
        expect(toObject(decode(lenField(2, hex('08 01 0c'))).message)).to.deep.equal({ '2': [8n, 1n, 12n] });
    });

    it('does not mistake random-looking binary for a message', () => {
        const payload = hex('9f 86 01 ff 00 12 34 56 78 9a bc de f0 11 22 33');
        expect(field(lenField(1, payload), 1).values[0]!.kind).to.equal('bytes');
    });

    it('names the root type as requested', () => {
        const result = decode(hex('12 02 08 01'), { rootName: 'Response' });
        expect(result.message.type).to.equal('Response');
        expect([...result.schema.types.keys()]).to.deep.equal(['Response.Field2', 'Response']);
    });

    it('decodes a realistic message', () => {
        const input = concat(
            varintField(1, 42),
            lenField(2, 'Jane Doe'),
            lenField(3, concat(lenField(1, 'jane@example.com'), varintField(2, 1))),
            hex('25 00 00 20 41'),
            hex('29 00 00 00 00 00 00 f0 3f'),
            varintField(6, 1),
            lenField(7, hex('01 02 03 04 05'))
        );
        const result = decode(input);
        expectNoProblems(result.problems);
        expect(toObject(result.message)).to.deep.equal({
            '1': 42n,
            '2': 'Jane Doe',
            '3': { '1': 'jane@example.com', '2': 1n },
            '4': 10,
            '5': 1,
            '6': 1n,
            '7': [1n, 2n, 3n, 4n, 5n]
        });
    });
});

describe('decode with a schema', () => {
    const testSchema = schema([
        messageType('test.Person', [
            fieldDef({ number: 1, name: 'id', type: scalar('int32') }),
            fieldDef({ number: 2, name: 'name', type: scalar('string') }),
            fieldDef({ number: 3, name: 'tags', type: scalar('uint32'), cardinality: 'repeated' }),
            fieldDef({ number: 4, name: 'address', type: { kind: 'message', name: 'test.Address' } }),
            fieldDef({ number: 5, name: 'kind', type: { kind: 'enum', name: 'test.Kind' } }),
            fieldDef({ number: 6, name: 'delta', type: scalar('sint32') }),
            fieldDef({ number: 7, name: 'attrs', type: { kind: 'map', key: 'string', value: scalar('int32') }, cardinality: 'repeated' }),
            fieldDef({ number: 8, name: 'score', type: scalar('double') }),
            fieldDef({ number: 9, name: 'active', type: scalar('bool') }),
            fieldDef({ number: 10, name: 'kinds', type: { kind: 'enum', name: 'test.Kind' }, cardinality: 'repeated' })
        ]),
        messageType('test.Address', [
            fieldDef({ number: 1, name: 'zip', type: scalar('sfixed32') })
        ]),
        enumType('test.Kind', [{ name: 'KIND_A', number: 0 }, { name: 'KIND_B', number: 1 }])
    ], { package: 'test' });

    const person = concat(
        hex('08 ff ff ff ff ff ff ff ff ff 01'),  // id = -1
        lenField(2, 'hi'),
        hex('1a 02 01 02'),                        // tags packed [1, 2]
        hex('18 03'),                              // tags unpacked 3
        lenField(4, hex('0d ff ff ff ff')),        // address.zip = -1
        hex('28 01'),                              // kind = KIND_B
        hex('30 03'),                              // delta = zigzag 3 = -2
        lenField(7, concat(lenField(1, 'a'), varintField(2, 5))),
        hex('41 00 00 00 00 00 00 f0 3f'),         // score = 1.0
        hex('48 01'),                              // active = true
        hex('52 02 01 07')                         // kinds packed [KIND_B, 7]
    );

    it('uses the declared names and types', () => {
        const result = decode(person, { schema: testSchema, type: 'test.Person' });
        expectNoProblems(result.problems);
        expect(result.message.type).to.equal('test.Person');
        expect(toObject(result.message)).to.deep.equal({
            id: -1n,
            name: 'hi',
            tags: [1n, 2n, 3n],
            address: { zip: -1n },
            kind: 'KIND_B',
            delta: -2n,
            attrs: [{ key: 'a', value: 5n }],
            score: 1,
            active: true,
            kinds: ['KIND_B', 7n]
        });
        expect(result.message.fields.get(1)!.values).to.deep.equal([{ kind: 'int32', value: -1n }]);
        expect(result.message.fields.get(5)!.values).to.deep.equal([{ kind: 'enum', value: 1n, name: 'KIND_B', type: 'test.Kind' }]);
        expect(result.message.fields.get(1)!.alternatives).to.deep.equal([]);
    });

    it('reports unknown fields and decodes them heuristically', () => {
        const result = decode(concat(person, varintField(99, 5), lenField(100, 'extra')), { schema: testSchema, type: 'test.Person' });
        expectProblem(result.problems, 'unknown-field');
        expect(result.problems.map(p => p.path)).to.deep.equal([[99], [100]]);
        const object = toObject(result.message);
        expect(object['99']).to.equal(5n);
        expect(object['100']).to.equal('extra');
        expect(result.message.fields.get(99)!.def!.inferred).to.not.equal(undefined);
    });

    it('infers types for unknown nested fields and adds them to the returned schema', () => {
        const result = decode(lenField(50, hex('08 01')), { schema: testSchema, type: 'test.Person' });
        expect(toObject(result.message)).to.deep.equal({ '50': { '1': 1n } });
        expect(result.schema.types.has('test.Person.Field50')).to.equal(true);
        expect(testSchema.types.has('test.Person.Field50')).to.equal(false);
    });

    it('reports wire type mismatches and keeps the raw field', () => {
        const result = decode(lenField(1, 'oops'), { schema: testSchema, type: 'test.Person' });
        const problem = expectProblem(result.problems, 'wire-type-mismatch', 0);
        expect(problem.path).to.deep.equal([1]);
        const value = result.message.fields.get(1)!.values[0]!;
        expect(value.kind).to.equal('raw');
        expect(toObject(result.message)).to.deep.equal({ id: utf8('oops') });
    });

    it('reports invalid UTF-8 in string fields and falls back to bytes', () => {
        const result = decode(hex('12 02 ff fe'), { schema: testSchema, type: 'test.Person' });
        expectProblem(result.problems, 'invalid-utf8', 2);
        expect(result.message.fields.get(2)!.values).to.deep.equal([{ kind: 'bytes', value: hex('ff fe') }]);
    });

    it('accepts group encoding for message fields', () => {
        const result = decode(hex('23 0d 05 00 00 00 24'), { schema: testSchema, type: 'test.Person' });
        expectNoProblems(result.problems);
        expect(toObject(result.message)).to.deep.equal({ address: { zip: 5n } });
    });

    it('reports malformed packed data', () => {
        const result = decode(hex('1a 02 01 80'), { schema: testSchema, type: 'test.Person' });
        expectProblem(result.problems, 'invalid-packed-data', 3);
        expect(toObject(result.message)).to.deep.equal({ tags: [1n] });
    });

    it('reports problems inside nested messages with the field path', () => {
        const result = decode(lenField(4, hex('0d 05 00')), { schema: testSchema, type: 'test.Person' });
        const problem = expectProblem(result.problems, 'truncated', 2);
        expect(problem.path).to.deep.equal([4]);
        expectProblem(result.problems, 'nested-message-problems');
    });

    it('falls back to heuristics for an unknown type name', () => {
        const broken = schema([messageType('A', [fieldDef({ number: 1, name: 'b', type: { kind: 'message', name: 'Missing' } })])]);
        const result = decode(lenField(1, hex('08 07')), { schema: broken });
        expectProblem(result.problems, 'unknown-type');
        expect(toObject(result.message)).to.deep.equal({ b: { '1': 7n } });
    });

    it('picks the only message type when none is named', () => {
        const single = schema([messageType('Only', [fieldDef({ number: 1, name: 'x', type: scalar('uint64') })])]);
        const result = decode(hex('08 07'), { schema: single });
        expectNoProblems(result.problems);
        expect(toObject(result.message)).to.deep.equal({ x: 7n });
    });

    it('reports a missing or ambiguous type and decodes heuristically', () => {
        const result = decode(hex('08 07'), { schema: testSchema, type: 'test.Nope' });
        expectProblem(result.problems, 'unknown-type');
        expect(toObject(result.message)).to.deep.equal({ '1': 7n });
        expectProblem(decode(hex('08 07'), { schema: testSchema }).problems, 'unknown-type');
    });

    it('applies last-wins and message merging for repeated singular fields', () => {
        const input = concat(
            varintField(1, 1), varintField(1, 2),
            lenField(4, hex('0d 01 00 00 00')), lenField(4, varintField(9, 1))
        );
        const result = decode(input, { schema: testSchema, type: 'test.Person' });
        const object = toObject(result.message);
        expect(object['id']).to.equal(2n);
        expect(object['address']).to.deep.equal({ zip: 1n, '9': 1n });
    });
});
