import { expect } from 'chai';
import protobuf from 'protobufjs';
import {
    printProto,
    decode,
    toObject,
    type EnumType,
    type MessageType,
    type Schema,
    parseProto
} from '../src/index.ts';
import { hex, concat, lenField, varintField, expectProblem } from './test-util.ts';

function message(schema: Schema, name: string): MessageType {
    const type = schema.types.get(name);
    expect(type?.kind, `${name} in ${[...schema.types.keys()].join(', ')}`).to.equal('message');
    return type as MessageType;
}

function parse(source: string): Schema {
    const result = parseProto(source);
    expect(result.problems, JSON.stringify(result.problems)).to.deep.equal([]);
    return result.schema;
}

describe('parseProto', () => {
    it('parses proto3 scalars, labels and presence', () => {
        const schema = parse(`
            syntax = "proto3";
            package app;
            message M {
              int32 plain = 1;
              optional int32 present = 2;
              repeated int32 packed = 3;
              repeated int32 loose = 4 [packed = false];
              repeated string texts = 5;
              bytes blob = 6;
            }
        `);
        expect(schema.syntax).to.equal('proto3');
        expect(schema.package).to.equal('app');
        const fields = message(schema, 'app.M').fields;
        expect(fields.get(1)!).to.deep.include({ presence: 'implicit', cardinality: 'optional' });
        expect(fields.get(2)!.presence).to.equal('explicit');
        expect(fields.get(3)!).to.deep.include({ cardinality: 'repeated', packed: true });
        expect(fields.get(4)!.packed).to.equal(false);
        // Strings are never packed, whatever the encoding feature says
        expect(fields.get(5)!.packed).to.equal(false);
    });

    it('parses proto2 labels, defaults, groups and extensions', () => {
        const schema = parse(`
            syntax = "proto2";
            message M {
              required int32 id = 1;
              optional string name = 2 [default = "anon"];
              repeated int32 nums = 3 [packed = true];
              repeated int32 loose = 4;
              optional group Meta = 5 { optional string k = 1; }
              extensions 100 to 199;
              reserved 20, 30 to 39, 40 to max;
              reserved "gone";
            }
            extend M { optional string extra = 100; }
        `);
        const type = message(schema, 'M');
        expect(type.fields.get(1)!.cardinality).to.equal('required');
        expect(type.fields.get(2)!.defaultValue).to.equal('"anon"');
        expect(type.fields.get(3)!.packed).to.equal(true);
        expect(type.fields.get(4)!.packed).to.equal(false);
        // A group declares a nested message and a field named after it in lower case
        expect(type.fields.get(5)!).to.deep.include({ name: 'meta', delimited: true, type: { kind: 'message', name: 'M.Meta' } });
        expect(message(schema, 'M.Meta').fields.get(1)!.name).to.equal('k');
        expect(type.extensionRanges).to.deep.equal([{ start: 100, end: 199 }]);
        expect(type.reservedRanges).to.deep.equal([{ start: 20, end: 20 }, { start: 30, end: 39 }, { start: 40, end: 536870911 }]);
        expect(type.reservedNames).to.deep.equal(['gone']);
        expect(schema.extensions?.map(e => [e.extendee, e.field.name, e.field.number])).to.deep.equal([['M', 'extra', 100]]);
    });

    it('parses editions and resolves features through their scopes', () => {
        const schema = parse(`
            edition = "2023";
            option features.field_presence = IMPLICIT;
            message M {
              int32 inherits = 1;
              int32 overrides = 2 [features.field_presence = EXPLICIT];
              N delimited = 3 [features.message_encoding = DELIMITED];
              message N {
                option features.field_presence = EXPLICIT;
                int32 from_message = 1;
              }
            }
            enum E { option features.enum_type = CLOSED; E_A = 0; }
        `);
        expect(schema.syntax).to.equal('editions');
        expect(schema.edition).to.equal('2023');
        const fields = message(schema, 'M').fields;
        expect(fields.get(1)!.presence).to.equal('implicit');
        expect(fields.get(2)!.presence).to.equal('explicit');
        expect(fields.get(3)!.delimited).to.equal(true);
        expect(message(schema, 'M.N').fields.get(1)!.presence).to.equal('explicit');
        expect((schema.types.get('E') as EnumType).open).to.equal(false);
    });

    it('parses oneofs, maps, enums and services', () => {
        const schema = parse(`
            syntax = "proto3";
            message M {
              oneof choice { int32 a = 1; string b = 2; }
              map<string, Inner> lookup = 3;
              map<int32, int32> counts = 4;
              Kind kind = 5;
              message Inner { bool flag = 1; }
              enum Kind { option allow_alias = true; K_A = 0; K_B = 1; K_ALIAS = 1; }
            }
            service S {
              rpc Get (M) returns (M);
              rpc Chat (stream M) returns (stream M) { option deprecated = true; }
            }
        `);
        const type = message(schema, 'M');
        expect(type.oneofs).to.deep.equal(['choice']);
        expect(type.fields.get(1)!.oneof).to.equal('choice');
        expect(type.fields.get(1)!.presence).to.equal('explicit');
        expect(type.fields.get(3)!).to.deep.include({
            cardinality: 'repeated',
            type: { kind: 'map', key: 'string', value: { kind: 'message', name: 'M.Inner' } }
        });
        expect(type.fields.get(4)!.type).to.deep.equal({ kind: 'map', key: 'int32', value: { kind: 'scalar', scalar: 'int32' } });
        expect((schema.types.get('M.Kind') as EnumType).values.map(v => v.number)).to.deep.equal([0, 1, 1]);
        expect(schema.services).to.deep.equal([{
            name: 'S',
            fullName: 'S',
            methods: [
                { name: 'Get', inputType: 'M', outputType: 'M', clientStreaming: false, serverStreaming: false },
                { name: 'Chat', inputType: 'M', outputType: 'M', clientStreaming: true, serverStreaming: true }
            ]
        }]);
    });

    it('resolves type names the way protoc does', () => {
        const schema = parse(`
            syntax = "proto3";
            package pkg;
            message A {
              B b = 1;
              C shadowed = 2;
              .pkg.C absolute = 3;
              message B { C inner = 1; }
              message C { int32 x = 1; }
            }
            message C { int32 y = 1; }
        `);
        const a = message(schema, 'pkg.A').fields;
        expect(a.get(1)!.type).to.deep.equal({ kind: 'message', name: 'pkg.A.B' });
        // C resolves to the nested type, not the outer one
        expect(a.get(2)!.type).to.deep.equal({ kind: 'message', name: 'pkg.A.C' });
        expect(a.get(3)!.type).to.deep.equal({ kind: 'message', name: 'pkg.C' });
        expect(message(schema, 'pkg.A.B').fields.get(1)!.type).to.deep.equal({ kind: 'message', name: 'pkg.A.C' });
    });

    it('resolves bundled well-known type imports', () => {
        const schema = parse(`
            syntax = "proto3";
            import "google/protobuf/timestamp.proto";
            import "google/protobuf/struct.proto";
            message M {
              google.protobuf.Timestamp at = 1;
              google.protobuf.Struct data = 2;
            }
        `);
        expect(message(schema, 'M').fields.get(1)!.type).to.deep.equal({ kind: 'message', name: 'google.protobuf.Timestamp' });
        expect(schema.types.has('google.protobuf.Value')).to.equal(true);

        const bytes = concat(lenField(1, concat(varintField(1, 1700000000), varintField(2, 250))));
        expect(toObject(decode(bytes, { schema, type: 'M' }).message)).to.deep.equal({ at: { seconds: 1700000000n, nanos: 250n } });
    });

    it('accepts keywords used as identifiers', () => {
        const schema = parse(`
            syntax = "proto2";
            message message {
              optional string message = 1;
              optional int32 optional = 2;
              repeated int32 to = 3;
              optional bool max = 4;
            }
        `);
        const fields = message(schema, 'message').fields;
        expect([...fields.values()].map(f => f.name)).to.deep.equal(['message', 'optional', 'to', 'max']);
    });

    it('parses signed enum values, reserved ranges and literal bases', () => {
        const schema = parse(`
            syntax = "proto2";
            enum E {
              OK = 0;
              BAD = -1;
              NEG_OCTAL = -010;
              POS_OCTAL = 010;
              NEG_HEX = -0x10;
              reserved -20 to -10, -5;
            }
        `);
        const type = schema.types.get('E') as EnumType;
        expect(type.values).to.deep.equal([
            { name: 'OK', number: 0 },
            { name: 'BAD', number: -1 },
            { name: 'NEG_OCTAL', number: -8 },
            { name: 'POS_OCTAL', number: 8 },
            { name: 'NEG_HEX', number: -16 }
        ]);
        expect(type.reservedRanges).to.deep.equal([{ start: -20, end: -10 }, { start: -5, end: -5 }]);
    });

    it('joins adjacent string literals, as protobuf does', () => {
        const schema = parse(`
            syntax = "proto2";
            option java_package = "com." "example" ".app";
            message M { optional string a = 1 [default = "one" "two", json_name = "x" "y"]; }
        `);
        expect(schema.options?.[0]!.value).to.equal('"com." "example" ".app"');
        const field = message(schema, 'M').fields.get(1)!;
        expect(field.jsonName).to.equal('xy');
        // The default keeps its source spelling, which re-parses to the same value
        expect(field.defaultValue).to.equal('"one" "two"');
    });

    it('decodes string option values rather than keeping their escapes', () => {
        const schema = parse('syntax = "proto3"; message M { int32 a = 1 [json_name = "a\\tb"]; }');
        expect(message(schema, 'M').fields.get(1)!.jsonName).to.equal('a\tb');
    });

    it('points at the line and column of a problem', () => {
        const result = parseProto('syntax = "proto3";\nmessage M {\n  int32 a = ;\n}\n', { name: 'api.proto' });
        expect(result.problems).to.have.length(1);
        expect(result.problems[0]!.message).to.match(/^api\.proto:3:13: /);
        expect(result.problems[0]!.offset).to.equal('syntax = "proto3";\nmessage M {\n  int32 a = '.length);
    });

    it('reports an unterminated string literal', () => {
        expectProblem(parseProto('syntax = "proto3').problems, 'parse-error');
        expectProblem(parseProto('syntax = "proto3"; message M { optional string a = 1 [default = "oops]; }').problems, 'parse-error');
    });

    it('stores options exactly as written', () => {
        const schema = parse('syntax = "proto3"; option a = "x"; message M { int32 f = 1 [deprecated = true]; }');
        expect(schema.options).to.deep.equal([{ name: 'a', value: '"x"' }]);
        expect(message(schema, 'M').fields.get(1)!.options).to.deep.equal([{ name: 'deprecated', value: 'true' }]);
    });

    it('gives well-known message fields explicit presence', () => {
        const schema = parse(`
            syntax = "proto3";
            import "google/protobuf/struct.proto";
            message M { google.protobuf.Struct s = 1; }
        `);
        const entry = schema.types.get('google.protobuf.Struct.FieldsEntry') as MessageType;
        expect(entry.fields.get(2)!.presence).to.equal('explicit');
        expect((schema.types.get('google.protobuf.Timestamp') as MessageType | undefined)).to.equal(undefined);
        expect((schema.types.get('google.protobuf.ListValue') as MessageType).fields.get(1)!.presence).to.equal('implicit');
    });

    it('reads comments, string escapes and number formats', () => {
        const schema = parse(`
            syntax = "proto2"; // trailing
            /* block
               comment */
            message M {
              optional string quoted = 0x10 [default = "a\\n\\"b\\x41"];
              optional int32 octal = 010;
              optional int32 plain = 3;
            }
        `);
        const fields = message(schema, 'M').fields;
        expect([...fields.keys()].sort((a, b) => a - b)).to.deep.equal([3, 8, 16]);
        expect(fields.get(16)!.defaultValue).to.equal('"a\\n\\"b\\x41"');
    });

    it('recovers from a bad declaration and keeps the rest of the file', () => {
        const result = parseProto(`
            syntax = "proto3";
            message Good { int32 a = 1; }
            message Broken { int32 b = ; string c = 2; }
            message AlsoGood { int32 d = 1; }
        `);
        expectProblem(result.problems, 'parse-error');
        expect(message(result.schema, 'Good').fields.size).to.equal(1);
        expect(message(result.schema, 'AlsoGood').fields.size).to.equal(1);
        // The rest of the broken message still parses
        expect(message(result.schema, 'Broken').fields.get(2)!.name).to.equal('c');
    });

    it('reports unresolved types but keeps the field', () => {
        const result = parseProto(`
            syntax = "proto3";
            import "other.proto";
            message M { other.Thing t = 1; int32 n = 2; }
        `);
        expectProblem(result.problems, 'unresolved-type');
        const fields = message(result.schema, 'M').fields;
        expect(fields.get(1)!.type).to.deep.equal({ kind: 'message', name: 'other.Thing' });
        expect(fields.size).to.equal(2);
    });

    it('reports a missing syntax statement and reads the file as proto2', () => {
        const result = parseProto('message M { required int32 a = 1; }');
        expectProblem(result.problems, 'unsupported');
        expect(result.schema.syntax).to.equal('proto2');
        expect(message(result.schema, 'M').fields.get(1)!.cardinality).to.equal('required');
    });

    it('reports duplicate field numbers', () => {
        const result = parseProto('syntax = "proto3"; message M { int32 a = 1; int32 b = 1; }');
        expectProblem(result.problems, 'duplicate-name');
    });

    it('parses custom options and keeps them for round trips', () => {
        const schema = parse(`
            syntax = "proto3";
            option java_package = "com.example";
            option (my.file_opt) = { a: 1 b: "two" };
            message M {
              option (my.msg_opt) = true;
              int32 a = 1 [deprecated = true, (my.field_opt) = "x"];
            }
        `);
        expect(schema.options?.map(o => o.name)).to.deep.equal(['java_package', '(my.file_opt)']);
        expect(message(schema, 'M').options?.map(o => o.name)).to.deep.equal(['(my.msg_opt)']);
        expect(message(schema, 'M').fields.get(1)!.options?.map(o => o.name)).to.deep.equal(['deprecated', '(my.field_opt)']);
    });

    it('decodes messages against a parsed schema', () => {
        const schema = parse(`
            syntax = "proto2";
            message M {
              required int32 id = 1;
              optional string name = 2;
              repeated int32 nums = 3 [packed = true];
              optional group G = 4 { optional int32 x = 1; }
              optional Kind kind = 5;
              enum Kind { K_A = 0; K_B = 1; }
            }
        `);
        const bytes = concat(varintField(1, 7), lenField(2, 'hi'), hex('1a 03 01 02 03'), hex('23 08 09 24'), varintField(5, 1));
        const result = decode(bytes, { schema, type: 'M' });
        expect(result.problems).to.deep.equal([]);
        expect(toObject(result.message)).to.deep.equal({ id: 7n, name: 'hi', nums: [1n, 2n, 3n], g: { x: 9n }, kind: 'K_B' });
    });

    it('round trips its own printed output', () => {
        const source = `
            syntax = "proto2";
            package round.trip;
            message M {
              required int32 id = 1;
              optional string name = 2 [default = "x"];
              repeated int32 nums = 3 [packed = true];
              oneof pick { int32 a = 4; Inner b = 5; }
              map<string, int32> counts = 6;
              reserved 20 to 29;
              reserved "old";
              extensions 100 to max;
              message Inner { optional bool flag = 1; }
              enum Kind { K_A = 0; }
              optional Kind kind = 7;
            }
        `;
        const first = parse(source);
        const printed = printProto(first);
        const second = parseProto(printed);
        expect(second.problems, printed).to.deep.equal([]);
        expect(printProto(second.schema)).to.equal(printed);

        const summarize = (schema: Schema) => [...schema.types.values()].map(type => type.kind === 'enum'
            ? `enum ${type.fullName} ${type.open}`
            : `message ${type.fullName} ` + [...type.fields.values()].map(f =>
                [f.number, f.name, JSON.stringify(f.type), f.cardinality, f.presence, f.packed, f.delimited, f.oneof].join(':')).join('|'));
        expect(summarize(second.schema)).to.deep.equal(summarize(first));
    });

    it('produces schemas protobufjs agrees with', () => {
        const source = `
            syntax = "proto3";
            package agree;
            message M {
              int32 a = 1;
              repeated string b = 2;
              map<string, int32> c = 3;
              oneof pick { bool d = 4; double e = 5; }
              Inner f = 6;
              message Inner { bytes g = 1; }
            }
        `;
        const schema = parse(source);
        const root = protobuf.parse(printProto(schema), { keepCase: true }).root;
        const M = root.lookupType('agree.M');
        const bytes = M.encode(M.fromObject({ a: 5, b: ['x', 'y'], c: { k: 1 }, e: 2.5, f: { g: new Uint8Array([9]) } })).finish();

        const result = decode(bytes, { schema, type: 'agree.M' });
        expect(result.problems).to.deep.equal([]);
        expect(toObject(result.message)).to.deep.equal({
            a: 5n, b: ['x', 'y'], c: { k: 1n }, e: 2.5, f: { g: new Uint8Array([9]) }
        });
    });
});
