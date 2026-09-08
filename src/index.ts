export type { Problem, ProblemCode } from './problem.ts';
export type {
    ByteRange,
    WireEndGroup,
    WireField,
    WireGroup,
    WireI32,
    WireI64,
    WireLen,
    WireMessage,
    WireType,
    WireVarint
} from './wire.ts';
export {
    describeType,
    enumType,
    fieldDef,
    isPackable,
    messageType,
    scalar,
    scalarWireType,
    schema,
    type AlternativeType,
    type Cardinality,
    type EnumType,
    type EnumValue,
    type FieldDef,
    type FieldType,
    type InferenceNotes,
    type MessageType,
    type NamedType,
    type Presence,
    type ScalarType,
    type Schema,
    type NumberRange,
    type OptionDecl,
    type ImportDecl,
    type MethodDecl,
    type ServiceDecl,
    type ExtensionDecl
} from './schema.ts';
export type { Alternative, Field, IntKind, Message, Value } from './values.ts';
export { SchemaInferrer, inferSchema, type SchemaInferrerOptions } from './schema-inferrer.ts';
export { printProto, type PrintProtoOptions } from './print.ts';
export { parseProto, type ParseProtoOptions, type ParseProtoResult } from './proto-parser.ts';
export { WELL_KNOWN_TYPES } from './well-known.ts';
export {
    schemaFromDescriptorSet,
    DESCRIPTOR_SCHEMA,
    type DescriptorSetOptions,
    type DescriptorSetResult
} from './descriptor.ts';
export { decode, type DecodeOptions, type DecodeResult } from './decode.ts';
export { toObject, type PlainObject, type PlainValue, type ToObjectOptions } from './object.ts';
export { isValidProtobuf } from './validate.ts';
export {
    encodeMessage,
    encodeObject,
    type EncodeMessageOptions,
    type EncodeResult
} from './encode.ts';
export {
    editionDefaults,
    mergeFeatures,
    type FeatureSet,
    type ResolvedFeatures
} from './features.ts';
