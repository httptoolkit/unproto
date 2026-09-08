import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import protobuf from 'protobufjs';
import {
    schemaFromDescriptorSet,
    parseProto,
    printProto,
    decode,
    toObject,
    type MessageType,
    type EnumType,
    type Schema
} from '../src/index.ts';
import { hex } from './test-util.ts';

// The .pb fixtures are protoc output for the .proto file of the same name:
//   protoc -I . --descriptor_set_out=x.pb [--include_imports] x.proto

function fixture(name: string): Promise<Uint8Array> {
    return readFile(new URL(`./fixtures/${name}`, import.meta.url));
}

function message(schema: Schema, name: string): MessageType {
    const type = schema.types.get(name);
    expect(type?.kind, `${name} in ${[...schema.types.keys()].join(', ')}`).to.equal('message');
    return type as MessageType;
}

describe('schemaFromDescriptorSet', () => {
    it('resolves editions features through their lexical scopes', async () => {
        const { schema, problems } = schemaFromDescriptorSet(await fixture('editions.pb'));
        expect(problems).to.deep.equal([]);
        expect(schema.syntax).to.equal('editions');
        expect(schema.edition).to.equal('2023');
        expect(schema.package).to.equal('t');

        const fields = message(schema, 't.M').fields;
        // The file sets IMPLICIT, so a field with no features of its own inherits it
        expect(fields.get(1)!.presence).to.equal('implicit');
        expect(fields.get(2)!.presence).to.equal('explicit');
        expect(fields.get(3)!).to.deep.include({ cardinality: 'repeated', packed: true });
        expect(fields.get(4)!).to.deep.include({ cardinality: 'repeated', packed: false });
        expect(fields.get(5)!).to.deep.include({ delimited: true, type: { kind: 'message', name: 't.M.N' } });
        // Nested messages inherit the file's features too
        expect(message(schema, 't.M.N').fields.get(1)!.presence).to.equal('implicit');
    });

    it('maps proto2 labels and group encoding onto the model', async () => {
        const { schema, problems } = schemaFromDescriptorSet(await fixture('proto2.pb'));
        expect(problems).to.deep.equal([]);
        expect(schema.syntax).to.equal('proto2');

        const fields = message(schema, 't2.M2').fields;
        expect(fields.get(1)!.cardinality).to.equal('required');
        expect(fields.get(2)!).to.deep.include({ delimited: true, name: 'grp' });
        expect(fields.get(3)!.packed).to.equal(true);
        expect(fields.get(4)!.packed).to.equal(false);
    });

    it('reads every construct of a proto3 file, including imports', async () => {
        const { schema, problems } = schemaFromDescriptorSet(await fixture('cross.pb'));
        expect(problems).to.deep.equal([]);
        expect(schema.syntax).to.equal('proto3');
        expect(schema.package).to.equal('cross');
        expect(schema.imports?.map(i => i.path)).to.deep.equal(['google/protobuf/timestamp.proto']);

        const sample = message(schema, 'cross.Sample');
        expect(sample.fields.get(1)!.presence).to.equal('implicit');
        expect(sample.fields.get(2)!.presence).to.equal('explicit');
        expect(sample.fields.get(9)!.type).to.deep.equal({ kind: 'map', key: 'string', value: { kind: 'scalar', scalar: 'int32' } });
        expect(sample.fields.get(10)!.type).to.deep.equal({ kind: 'message', name: 'google.protobuf.Timestamp' });
        expect(sample.fields.get(11)!.oneof).to.equal('pick');
        expect(sample.reservedRanges).to.deep.equal([{ start: 50, end: 60 }]);
        expect((schema.types.get('cross.Sample.Kind') as EnumType).values).to.deep.equal([
            { name: 'K_ZERO', number: 0 }, { name: 'K_ONE', number: 1 }
        ]);

        // The dependency's own types come along, and the synthetic map entry does not
        expect(schema.types.has('google.protobuf.Timestamp')).to.equal(true);
        expect(schema.types.has('cross.Sample.CountsEntry')).to.equal(false);
    });

    it('agrees with the parser on the same source', async () => {
        const [descriptorBytes, source] = await Promise.all([fixture('cross.pb'), readFile(new URL('./fixtures/cross.proto', import.meta.url), 'utf8')]);
        const fromDescriptor = schemaFromDescriptorSet(descriptorBytes).schema;
        const fromSource = parseProto(source, { name: 'cross.proto' });
        expect(fromSource.problems).to.deep.equal([]);

        const summarize = (schema: Schema) => [...schema.types.values()]
            .filter(type => type.fullName.startsWith('cross.'))
            .map(type => type.kind === 'enum'
                ? `enum ${type.fullName} open=${type.open} ${type.values.map(v => `${v.name}=${v.number}`).join(',')}`
                : `message ${type.fullName} ` + [...type.fields.values()].map(field =>
                    [field.number, field.name, JSON.stringify(field.type), field.cardinality, field.presence,
                        field.packed, field.delimited, field.oneof].join(':')).join(' | '))
            .sort();
        expect(summarize(fromSource.schema)).to.deep.equal(summarize(fromDescriptor));
    });

    it('decodes real messages with a schema read from a descriptor set', async () => {
        const { schema } = schemaFromDescriptorSet(await fixture('cross.pb'));
        // protobufjs does not follow imports from a source string, so the dependency goes in first
        const root = new protobuf.Root();
        protobuf.parse('syntax = "proto3"; package google.protobuf; message Timestamp { int64 seconds = 1; int32 nanos = 2; }', root, { keepCase: true });
        protobuf.parse(await readFile(new URL('./fixtures/cross.proto', import.meta.url), 'utf8'), root, { keepCase: true });
        const Sample = root.lookupType('cross.Sample');
        const bytes = Sample.encode(Sample.fromObject({
            plain: 7, opt: 0, packed: [1, 2, 3], loose: [4, 5], text: 'hi',
            blob: new Uint8Array([1, 2]), kind: 1, nested: { d: 1.5 },
            counts: { a: 1 }, at: { seconds: 100, nanos: 5 }, y: 'chosen', many: [{ d: 2.5 }]
        })).finish();

        const result = decode(bytes, { schema, type: 'cross.Sample' });
        expect(result.problems).to.deep.equal([]);
        expect(toObject(result.message)).to.deep.equal({
            plain: 7n, opt: 0n, packed: [1n, 2n, 3n], loose: [4n, 5n], text: 'hi',
            blob: new Uint8Array([1, 2]), kind: 'K_ONE', nested: { d: 1.5 },
            counts: [{ key: 'a', value: 1n }], at: { seconds: 100n, nanos: 5n },
            y: 'chosen', many: [{ d: 2.5 }]
        });
    });

    it('round trips through the printer back into an equivalent schema', async () => {
        const { schema } = schemaFromDescriptorSet(await fixture('cross.pb'));
        const reparsed = parseProto(printProto(schema), { name: 'printed.proto' });
        expect(reparsed.problems).to.deep.equal([]);
        const fields = message(reparsed.schema, 'cross.Sample').fields;
        expect(fields.get(9)!.type).to.deep.equal({ kind: 'map', key: 'string', value: { kind: 'scalar', scalar: 'int32' } });
        expect(fields.get(11)!.oneof).to.equal('pick');
        expect(fields.get(2)!.presence).to.equal('explicit');
    });

    it('reports a descriptor set it cannot read', () => {
        const empty = schemaFromDescriptorSet(new Uint8Array(0));
        expect(empty.problems.map(p => p.code)).to.deep.equal(['unknown-type']);
        expect(empty.schema.types.size).to.equal(0);
        // One file, named but otherwise empty
        expect(schemaFromDescriptorSet(hex('0a 09 0a 07 78 2e 70 72 6f 74 6f')).problems).to.deep.equal([]);
    });

    it('takes the package and syntax from a named file when asked', async () => {
        const bytes = await fixture('cross.pb');
        expect(schemaFromDescriptorSet(bytes, { file: 'google/protobuf/timestamp.proto' }).schema.package).to.equal('google.protobuf');
        const missing = schemaFromDescriptorSet(bytes, { file: 'nope.proto' });
        expect(missing.problems.map(p => p.code)).to.deep.equal(['unknown-type']);
        expect(missing.schema.package).to.equal('cross');
    });
});
