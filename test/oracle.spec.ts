import { expect } from 'chai';
import protobuf from 'protobufjs';
import {
    decode,
    toObject,
    schema,
    messageType,
    fieldDef,
    scalar
} from '../src/index.ts';
import { expectNoProblems } from './test-util.ts';

// Cross-checks against protobufjs as an independent encoder

describe('decoding protobufjs output', () => {
    const proto3 = protobuf.parse(`
        syntax = "proto3";
        package sample;
        message Thing {
            int32 a = 1;
            string b = 2;
            repeated int32 c = 3;
            double d = 4;
            float e = 5;
            bool f = 6;
            Thing g = 7;
            bytes h = 8;
            sint32 i = 9;
            fixed64 j = 10;
            map<string, int32> m = 11;
            repeated string s = 12;
            int64 big = 13;
            uint32 u = 14;
            repeated Thing children = 15;
        }
    `).root;
    const Thing = proto3.lookupType('sample.Thing');

    const payload = {
        a: -7,
        b: 'Hello, world!',
        c: [1, 2, 300],
        d: 3.25,
        e: -0.5,
        f: true,
        g: { a: 5, b: 'nested value' },
        h: new Uint8Array([0xff, 0x00, 0x01]),
        i: -3,
        j: '1234',
        m: { key: 7 },
        s: ['one', 'two'],
        big: '9007199254740993',
        u: 4294967295,
        children: [{ a: 1 }, { a: 2 }]
    };
    // fromObject converts the 64-bit strings to Longs, so no precision is lost
    const encoded = Thing.encode(Thing.fromObject(payload)).finish();

    it('decodes heuristically to sensible values', () => {
        const result = decode(encoded);
        expectNoProblems(result.problems);
        expect(toObject(result.message)).to.deep.equal({
            '1': -7n,
            '2': 'Hello, world!',
            '3': [1n, 2n, 300n],
            '4': 3.25,
            '5': -0.5,
            '6': 1n,
            '7': { '1': 5n, '2': 'nested value' },
            '8': new Uint8Array([0xff, 0x00, 0x01]),
            '9': 5n,
            '10': 1234n,
            '11': { '1': 'key', '2': 7n },
            '12': ['one', 'two'],
            '13': 9007199254740993n,
            '14': 4294967295n,
            '15': [{ '1': 1n }, { '1': 2n }]
        });
    });

    it('decodes exactly with a matching schema', () => {
        const thing = 'sample.Thing';
        const thingSchema = schema([
            messageType(thing, [
                fieldDef({ number: 1, name: 'a', type: scalar('int32') }),
                fieldDef({ number: 2, name: 'b', type: scalar('string') }),
                fieldDef({ number: 3, name: 'c', type: scalar('int32'), cardinality: 'repeated' }),
                fieldDef({ number: 4, name: 'd', type: scalar('double') }),
                fieldDef({ number: 5, name: 'e', type: scalar('float') }),
                fieldDef({ number: 6, name: 'f', type: scalar('bool') }),
                fieldDef({ number: 7, name: 'g', type: { kind: 'message', name: thing } }),
                fieldDef({ number: 8, name: 'h', type: scalar('bytes') }),
                fieldDef({ number: 9, name: 'i', type: scalar('sint32') }),
                fieldDef({ number: 10, name: 'j', type: scalar('fixed64') }),
                fieldDef({ number: 11, name: 'm', type: { kind: 'map', key: 'string', value: scalar('int32') }, cardinality: 'repeated' }),
                fieldDef({ number: 12, name: 's', type: scalar('string'), cardinality: 'repeated' }),
                fieldDef({ number: 13, name: 'big', type: scalar('int64') }),
                fieldDef({ number: 14, name: 'u', type: scalar('uint32') }),
                fieldDef({ number: 15, name: 'children', type: { kind: 'message', name: thing }, cardinality: 'repeated' })
            ])
        ], { package: 'sample' });

        const result = decode(encoded, { schema: thingSchema, type: thing });
        expectNoProblems(result.problems);
        expect(toObject(result.message)).to.deep.equal({
            a: -7n,
            b: 'Hello, world!',
            c: [1n, 2n, 300n],
            d: 3.25,
            e: -0.5,
            f: true,
            g: { a: 5n, b: 'nested value' },
            h: new Uint8Array([0xff, 0x00, 0x01]),
            i: -3n,
            j: 1234n,
            m: { key: 7n },
            s: ['one', 'two'],
            big: 9007199254740993n,
            u: 4294967295n,
            children: [{ a: 1n }, { a: 2n }]
        });
    });

    it('decodes proto2 groups and explicitly packed fields', () => {
        const proto2 = protobuf.parse(`
            syntax = "proto2";
            message Outer {
                optional group Item = 1 {
                    optional int32 x = 1;
                    optional string y = 2;
                }
                repeated int32 packed = 2 [packed=true];
                repeated int32 unpacked = 3;
            }
        `).root;
        const Outer = proto2.lookupType('Outer');
        const bytes = Outer.encode(Outer.create({ item: { x: 9, y: 'why' }, packed: [4, 5, 6], unpacked: [7, 8] })).finish();

        const result = decode(bytes);
        expectNoProblems(result.problems);
        expect(toObject(result.message)).to.deep.equal({
            '1': { '1': 9n, '2': 'why' },
            '2': [4n, 5n, 6n],
            '3': [7n, 8n]
        });
        expect(result.schema.syntax).to.equal('editions');
    });
});
