import { expect } from 'chai';
import {
    decode,
    toObject,
    schema,
    messageType,
    fieldDef,
    scalar
} from '../src/index.ts';
import { hex, concat, lenField, varintField } from './test-util.ts';

describe('toObject', () => {
    const input = concat(varintField(1, 5), lenField(2, 'x'), lenField(3, varintField(1, 1)));
    const named = schema([
        messageType('T', [
            fieldDef({ number: 1, name: 'count', type: scalar('int32') }),
            fieldDef({ number: 2, name: 'label', type: scalar('string') }),
            fieldDef({ number: 3, name: 'inner', type: { kind: 'message', name: 'T' } })
        ])
    ]);

    it('keys inferred fields by number and schema fields by name', () => {
        expect(toObject(decode(input).message)).to.deep.equal({ '1': 5n, '2': 'x', '3': { '1': 1n } });
        expect(toObject(decode(input, { schema: named }).message)).to.deep.equal({ count: 5n, label: 'x', inner: { count: 1n } });
    });

    it('produces JSON-friendly values with a bigint-aware replacer', () => {
        const object = toObject(decode(concat(input, lenField(4, hex('ff 00')))).message);
        const json = JSON.stringify(object, (_key, value: unknown) =>
            typeof value === 'bigint' ? value.toString()
            : value instanceof Uint8Array ? `bytes(${value.length})`
            : value);
        expect(JSON.parse(json)).to.deep.equal({ '1': '5', '2': 'x', '3': { '1': '1' }, '4': 'bytes(2)' });
    });

    it('flattens map fields into plain objects', () => {
        const maps = schema([messageType('M', [
            fieldDef({ number: 1, name: 'counters', type: { kind: 'map', key: 'string', value: scalar('int32') }, cardinality: 'repeated' }),
            fieldDef({ number: 2, name: 'byId', type: { kind: 'map', key: 'int32', value: scalar('string') }, cardinality: 'repeated' })
        ])]);
        const bytes = concat(
            lenField(1, concat(lenField(1, 'logins'), varintField(2, 7))),
            lenField(1, concat(lenField(1, 'posts'), varintField(2, 130))),
            lenField(2, concat(varintField(1, 5), lenField(2, 'five')))
        );
        const result = decode(bytes, { schema: maps, type: 'M' });
        expect(result.problems).to.deep.equal([]);
        expect(toObject(result.message)).to.deep.equal({
            counters: { logins: 7n, posts: 130n },
            byId: { 5: 'five' }
        });
    });

    it('uses type defaults for map entries missing a key or a value', () => {
        const maps = schema([messageType('M', [
            fieldDef({ number: 1, name: 'm', type: { kind: 'map', key: 'string', value: scalar('int32') }, cardinality: 'repeated' })
        ])]);
        // One entry with only a value, one with only a key, then a duplicate key that wins
        const bytes = concat(
            lenField(1, varintField(2, 9)),
            lenField(1, lenField(1, 'k')),
            lenField(1, concat(lenField(1, 'k'), varintField(2, 3)))
        );
        expect(toObject(decode(bytes, { schema: maps, type: 'M' }).message)).to.deep.equal({ m: { '': 9n, k: 3n } });
    });

    it('replays oneof members and message merges in wire order', () => {
        const oneofs = schema([
            messageType('T', [
                fieldDef({ number: 1, name: 'a', type: { kind: 'message', name: 'M' }, oneof: 'choice' }),
                fieldDef({ number: 2, name: 'b', type: scalar('int32'), oneof: 'choice' })
            ]),
            messageType('M', [
                fieldDef({ number: 1, name: 'x', type: scalar('int32') }),
                fieldDef({ number: 2, name: 'y', type: scalar('int32') })
            ]),
            messageType('Outer', [fieldDef({ number: 1, name: 't', type: { kind: 'message', name: 'T' } })])
        ]);
        // a = {x: 1}, then b = 1 (clears a), then a = {y: 2} starts afresh
        expect(toObject(decode(hex('0a 02 08 01 10 01 0a 02 10 02'), { schema: oneofs, type: 'T' }).message)).to.deep.equal({ a: { y: 2n } });
        // t = {a: {x: 1}} merged with t = {b: 7}: b clears a inside the merged message
        expect(toObject(decode(hex('0a 04 0a 02 08 01 0a 02 10 07'), { schema: oneofs, type: 'Outer' }).message)).to.deep.equal({ t: { b: 7n } });
    });

    it('keeps only the last-written member of a oneof', () => {
        const choice = schema([messageType('O', [
            fieldDef({ number: 3, name: 'a', type: scalar('int32'), oneof: 'c' }),
            fieldDef({ number: 4, name: 'b', type: scalar('int32'), oneof: 'c' }),
            fieldDef({ number: 5, name: 'other', type: scalar('int32') })
        ])]);
        expect(toObject(decode(hex('18 01 20 02 18 03 28 09'), { schema: choice }).message)).to.deep.equal({ a: 3n, other: 9n });
        expect(toObject(decode(hex('18 01 20 02'), { schema: choice }).message)).to.deep.equal({ b: 2n });
    });
});
