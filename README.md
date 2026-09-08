# Unproto [![Build Status](https://github.com/httptoolkit/unproto/workflows/CI/badge.svg)](https://github.com/httptoolkit/unproto/actions) [![Available on NPM](https://img.shields.io/npm/v/unproto.svg)](https://npmjs.com/package/unproto)

> _Part of [HTTP Toolkit](https://httptoolkit.com): powerful tools for building, testing & debugging HTTP(S)_

With no schema, decode protobuf, infer a schema, test it, and re-encode again to reverse engineer protobuf from real HTTP traffic.

Unproto decodes protobuf messages with or without a schema, in Node and in the browser. Without a schema it infers one from the bytes, using heuristics that score every plausible reading of each field (message, string, packed list, bytes...) rather than taking the first that parses.

Through Unproto, malformed input never throws: whatever could be decoded is returned, with every issue listed alongside. That makes it unsuitable for reliable parsing generally, but extremely useful for reverse engineering & debugging, where you want to incrementally explore and understand a protobuf message.

Every integer is returned as a `bigint`, whatever its declared width, so values never lose precision and callers deal with one predictable type. Field numbers up to the protobuf maximum (536,870,911) are handled correctly.

## Getting started

```bash
npm install unproto
```

### Decode without a schema

```typescript
import { decode, toObject } from 'unproto';

const result = decode(bytes);

// A plain object keyed by field number, with repeated fields as arrays:
const object = toObject(result.message);
// e.g. { '1': 42n, '2': 'Jane Doe', '3': { '1': 'jane@example.com' }, '7': [1n, 2n, 3n] }

// Everything that went wrong, if anything:
result.problems; // [] for a clean decode

// The schema that was inferred and used:
result.schema;
```

The decoded `result.message` keeps far more than the plain object: every field has its typed values (`{ kind: 'int64', value: 42n }`, `{ kind: 'string', value: '...' }`, ...), the raw wire records it came from with their byte offsets, the field definition that was used, and the other readings that were considered plausible (a short string that also parses as a message, a fixed64 that could be a double, and so on).

To print as JSON, give `JSON.stringify` a replacer for bigints and bytes:

```typescript
JSON.stringify(object, (key, value) =>
    typeof value === 'bigint' ? value.toString() :
    value instanceof Uint8Array ? Array.from(value) :
    value
, 2);
```

### Decode with a schema

```typescript
import { decode, toObject, schema, messageType, fieldDef, scalar } from 'unproto';

const person = schema([
    messageType('Person', [
        fieldDef({ number: 1, name: 'id', type: scalar('int32') }),
        fieldDef({ number: 2, name: 'name', type: scalar('string') }),
        fieldDef({ number: 3, name: 'tags', type: scalar('string'), cardinality: 'repeated' })
    ])
]);

const result = decode(bytes, { schema: person, type: 'Person' });
toObject(result.message); // { id: 42n, name: 'Jane Doe', tags: ['a', 'b'] }
```

The schema is applied leniently. Fields the schema does not mention are decoded heuristically, fields whose encoding contradicts the schema are kept raw, and each such case is reported in `result.problems` with the path to the field. Parsing `.proto` files and binary descriptor sets into this schema model is coming next.

### Check whether bytes are protobuf at all

```typescript
import { isValidProtobuf } from 'unproto';

isValidProtobuf(bytes); // true if every byte is a well-formed field and there is at least one
```

## API

- `decode(bytes, options?)`: decodes a message, inferring a schema if none is given. Options: `schema`, `type` (full name of the message type), `rootName` (for the inferred root type), `recursionLimit`.
- `toObject(message, options?)`: flattens a decoded message to a plain object. Options: `keys` (`'auto'`, `'name'` or `'number'`), `prefix`.
- `inferSchema(samples, options?)`: infers a schema from one or more messages of the same type.
- `isValidProtobuf(bytes)`: wire-level validity check.
- `schema`, `messageType`, `enumType`, `fieldDef`, `scalar`: helpers for building schemas by hand.

