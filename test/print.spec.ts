import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import protobuf from 'protobufjs';
import {
    decode,
    printProto,
    inferSchema,
    schema,
    messageType,
    enumType,
    fieldDef,
    scalar
} from '../src/index.ts';
import { hex, concat, lenField, varintField } from './test-util.ts';

function parse(text: string): protobuf.Root {
    return protobuf.parse(text, { keepCase: true }).root;
}

describe('printProto', () => {
    it('prints an inferred schema as proto3 with inference notes', () => {
        const input = concat(
            varintField(1, 42),
            lenField(2, 'Jane'),
            lenField(3, concat(lenField(1, 'x'), varintField(2, 0))),
            hex('22 03 01 02 03'),
            lenField(5, 'a'), lenField(5, 'b')
        );
        const text = printProto(decode(input).schema, { header: ['Inferred by unproto'] });
        expect(text).to.equal([
            '// Inferred by unproto',
            '',
            'syntax = "proto3";',
            '',
            'message Message {',
            '  int64 field_1 = 1; // seen in 1 of 1 message; could also be int32, uint64, sint64',
            '  string field_2 = 2; // seen in 1 of 1 message; could also be bytes, packed int64, packed fixed32',
            '  Field3 field_3 = 3; // seen in 1 of 1 message; could also be packed int64, bytes, string',
            '  repeated int64 field_4 = 4; // seen in 1 of 1 message; could also be bytes, string',
            '  repeated string field_5 = 5; // seen in 1 of 1 message; could also be bytes, packed int64',
            '',
            '  message Field3 {',
            '    string field_1 = 1; // seen in 1 of 1 message; could also be bytes, packed int64',
            '    optional int64 field_2 = 2; // seen in 1 of 1 message; could also be int32, uint64, sint64, ...',
            '  }',
            '}',
            ''
        ].join('\n'));

        const root = parse(text);
        const type = root.lookupType('Message');
        expect(type.fieldsArray.map(f => [f.name, f.id, f.type, f.repeated])).to.deep.equal([
            ['field_1', 1, 'int64', false],
            ['field_2', 2, 'string', false],
            ['field_3', 3, 'Field3', false],
            ['field_4', 4, 'int64', true],
            ['field_5', 5, 'string', true]
        ]);
        expect(root.lookupType('Message.Field3').fields['field_2']!.options).to.deep.equal({ proto3_optional: true });
    });

    it('prints group encoding as edition 2023', () => {
        const text = printProto(inferSchema([hex('0b 08 01 0c')]));
        expect(text).to.include('edition = "2023";');
        expect(text).to.include('Field1 field_1 = 1 [features.message_encoding = DELIMITED];');
        expect(text).to.include('int64 field_1 = 1 [features.field_presence = IMPLICIT];');
        const root = parse(text);
        expect(root.lookupType('Message').fields['field_1']!.type).to.equal('Field1');
    });

    it('prints supplied schemas with packages, oneofs, maps, enums and options', () => {
        const supplied = schema([
            messageType('shop.Order', [
                fieldDef({ number: 1, name: 'id', type: scalar('uint64') }),
                fieldDef({ number: 2, name: 'status', type: { kind: 'enum', name: 'shop.Status' }, presence: 'implicit' }),
                fieldDef({ number: 3, name: 'card', type: scalar('string'), oneof: 'payment' }),
                fieldDef({ number: 4, name: 'cash', type: scalar('bool'), oneof: 'payment' }),
                fieldDef({ number: 5, name: 'items', type: { kind: 'message', name: 'shop.Order.Item' }, cardinality: 'repeated' }),
                fieldDef({ number: 6, name: 'tags', type: { kind: 'map', key: 'string', value: scalar('int32') }, cardinality: 'repeated' }),
                fieldDef({ number: 7, name: 'weights', type: scalar('float'), cardinality: 'repeated', packed: false }),
                fieldDef({ number: 8, name: 'note', type: scalar('string'), jsonName: 'orderNote', presence: 'implicit' }),
                fieldDef({ number: 9, name: 'nested', type: { kind: 'message', name: 'shop.Order.Item.Detail' } })
            ]),
            messageType('shop.Order.Item', [fieldDef({ number: 1, name: 'sku', type: scalar('string'), presence: 'implicit' })]),
            messageType('shop.Order.Item.Detail', []),
            enumType('shop.Status', [{ name: 'NEW', number: 0 }, { name: 'PAID', number: 1 }, { name: 'SETTLED', number: 1 }])
        ], { package: 'shop' });

        const text = printProto(supplied);
        expect(text).to.equal([
            'syntax = "proto3";',
            '',
            'package shop;',
            '',
            'message Order {',
            '  optional uint64 id = 1;',
            '  Status status = 2;',
            '  oneof payment {',
            '    string card = 3;',
            '    bool cash = 4;',
            '  }',
            '  repeated Item items = 5;',
            '  map<string, int32> tags = 6;',
            '  repeated float weights = 7 [packed = false];',
            '  string note = 8 [json_name = "orderNote"];',
            '  Item.Detail nested = 9;',
            '',
            '  message Item {',
            '    string sku = 1;',
            '',
            '    message Detail {}',
            '  }',
            '}',
            '',
            'enum Status {',
            '  option allow_alias = true;',
            '  NEW = 0;',
            '  PAID = 1;',
            '  SETTLED = 1;',
            '}',
            ''
        ].join('\n'));

        const root = parse(text);
        const order = root.lookupType('shop.Order');
        expect(order.oneofsArray.filter(o => !o.name.startsWith('_')).map(o => [o.name, o.oneof])).to.deep.equal([['payment', ['card', 'cash']]]);
        expect(order.fields['tags']!.map).to.equal(true);
        expect(order.fields['weights']!.options).to.deep.equal({ packed: false });
        expect(order.fields['nested']!.resolve().resolvedType!.fullName).to.equal('.shop.Order.Item.Detail');
        expect({ ...root.lookupEnum('shop.Status').values }).to.deep.equal({ NEW: 0, PAID: 1, SETTLED: 1 });
    });

    it('prints proto2 groups and required fields faithfully by promoting to editions', () => {
        const proto2 = schema([
            messageType('G', [
                fieldDef({ number: 1, name: 'grp', type: { kind: 'message', name: 'G.Grp' }, delimited: true, cardinality: 'required' }),
                fieldDef({ number: 2, name: 'n', type: scalar('int32'), cardinality: 'required' }),
                fieldDef({ number: 3, name: 'tags', type: scalar('int32'), cardinality: 'repeated', packed: false })
            ]),
            messageType('G.Grp', [fieldDef({ number: 1, name: 'x', type: scalar('int32') })])
        ], { syntax: 'proto2' });
        const text = printProto(proto2);
        expect(text).to.include('edition = "2023";');
        expect(text).to.include('Grp grp = 1 [features.message_encoding = DELIMITED, features.field_presence = LEGACY_REQUIRED];');
        expect(text).to.include('int32 n = 2 [features.field_presence = LEGACY_REQUIRED];');
        expect(text).to.include('repeated int32 tags = 3 [features.repeated_field_encoding = EXPANDED];');

        const root = parse(text);
        const G = root.lookupType('G');
        expect(() => G.decode(hex('0b 08 01 0c 10 05'))).to.not.throw();
        expect(() => G.decode(hex('10 05'))).to.throw(/missing required 'grp'/);
    });

    it('uses the shortest type reference that resolves correctly', () => {
        const s = schema([
            messageType('pkg.A', [
                fieldDef({ number: 1, name: 'b', type: { kind: 'message', name: 'pkg.A.B' } }),
                fieldDef({ number: 2, name: 'c', type: { kind: 'message', name: 'pkg.C' } })
            ]),
            messageType('pkg.A.B', [fieldDef({ number: 1, name: 'outer_c', type: { kind: 'message', name: 'pkg.C' } })]),
            messageType('pkg.A.C', []),
            messageType('pkg.C', []),
            messageType('pkg.D', [fieldDef({ number: 1, name: 'missing', type: { kind: 'message', name: 'other.Missing' } })])
        ], { package: 'pkg' });
        const text = printProto(s);
        expect(text).to.include('  B b = 1;');
        // A has its own nested C, so "C" from inside A (or A.B) would resolve to A.C
        expect(text).to.include('  pkg.C c = 2;');
        expect(text).to.include('    pkg.C outer_c = 1;');
        expect(text).to.include('  message C {}');
        expect(text).to.include('  other.Missing missing = 1;');
        const root = parse(text.replace('other.Missing missing = 1;', 'int32 missing = 1;'));
        expect(root.lookupType('pkg.A.B').fields['outer_c']!.resolve().resolvedType!.fullName).to.equal('.pkg.C');
    });

    it('produces schemas protobufjs can use to decode the real captures', async () => {
        for (const name of ['pixelstarships', 'hearthstone']) {
            const bytes = await readFile(new URL(`./fixtures/${name}.bin`, import.meta.url));
            const result = decode(bytes, { rootName: 'Capture' });
            const root = parse(printProto(result.schema));
            const type = root.lookupType('Capture');
            const decoded = type.decode(bytes);
            expect(type.verify(decoded)).to.equal(null);
            expect(Object.keys(type.toObject(decoded)).length).to.equal(result.message.fields.size);
        }
    });
});
