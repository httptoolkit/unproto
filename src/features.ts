/**
 * Editions features and their resolution. Descriptor sets and `.proto`
 * sources both carry features as written, scoped lexically, so both have
 * to resolve them against the edition's defaults before a field's wire
 * behaviour is known.
 */

export type FieldPresence = 'EXPLICIT' | 'IMPLICIT' | 'LEGACY_REQUIRED';
export type EnumTypeFeature = 'OPEN' | 'CLOSED';
export type RepeatedFieldEncoding = 'PACKED' | 'EXPANDED';
export type Utf8Validation = 'VERIFY' | 'NONE';
export type MessageEncoding = 'LENGTH_PREFIXED' | 'DELIMITED';
export type JsonFormat = 'ALLOW' | 'LEGACY_BEST_EFFORT';

/** Features as written at one scope. Anything absent is inherited. */
export interface FeatureSet {
    readonly fieldPresence?: FieldPresence;
    readonly enumType?: EnumTypeFeature;
    readonly repeatedFieldEncoding?: RepeatedFieldEncoding;
    readonly utf8Validation?: Utf8Validation;
    readonly messageEncoding?: MessageEncoding;
    readonly jsonFormat?: JsonFormat;
}

export type ResolvedFeatures = Required<FeatureSet>;

const PROTO2: ResolvedFeatures = {
    fieldPresence: 'EXPLICIT',
    enumType: 'CLOSED',
    repeatedFieldEncoding: 'EXPANDED',
    utf8Validation: 'NONE',
    messageEncoding: 'LENGTH_PREFIXED',
    jsonFormat: 'LEGACY_BEST_EFFORT'
};

const PROTO3: ResolvedFeatures = {
    fieldPresence: 'IMPLICIT',
    enumType: 'OPEN',
    repeatedFieldEncoding: 'PACKED',
    utf8Validation: 'VERIFY',
    messageEncoding: 'LENGTH_PREFIXED',
    jsonFormat: 'ALLOW'
};

const EDITION_2023: ResolvedFeatures = {
    fieldPresence: 'EXPLICIT',
    enumType: 'OPEN',
    repeatedFieldEncoding: 'PACKED',
    utf8Validation: 'VERIFY',
    messageEncoding: 'LENGTH_PREFIXED',
    jsonFormat: 'ALLOW'
};

/**
 * The feature values in force before any are written. Editions after 2023
 * have not changed any wire-affecting default, so they share its set.
 */
export function editionDefaults(edition: string): ResolvedFeatures {
    if (edition === 'proto2') return PROTO2;
    if (edition === 'proto3') return PROTO3;
    return EDITION_2023;
}

/** Applies the features written at one scope over those inherited from its parent */
export function mergeFeatures(base: ResolvedFeatures, override: FeatureSet | undefined): ResolvedFeatures {
    if (!override) return base;
    return {
        fieldPresence: override.fieldPresence ?? base.fieldPresence,
        enumType: override.enumType ?? base.enumType,
        repeatedFieldEncoding: override.repeatedFieldEncoding ?? base.repeatedFieldEncoding,
        utf8Validation: override.utf8Validation ?? base.utf8Validation,
        messageEncoding: override.messageEncoding ?? base.messageEncoding,
        jsonFormat: override.jsonFormat ?? base.jsonFormat
    };
}

const FIELD_PRESENCE: Record<number, FieldPresence> = { 1: 'EXPLICIT', 2: 'IMPLICIT', 3: 'LEGACY_REQUIRED' };
const ENUM_TYPE: Record<number, EnumTypeFeature> = { 1: 'OPEN', 2: 'CLOSED' };
const REPEATED_ENCODING: Record<number, RepeatedFieldEncoding> = { 1: 'PACKED', 2: 'EXPANDED' };
const UTF8_VALIDATION: Record<number, Utf8Validation> = { 2: 'VERIFY', 3: 'NONE' };
const MESSAGE_ENCODING: Record<number, MessageEncoding> = { 1: 'LENGTH_PREFIXED', 2: 'DELIMITED' };
const JSON_FORMAT: Record<number, JsonFormat> = { 1: 'ALLOW', 2: 'LEGACY_BEST_EFFORT' };

/** Builds a FeatureSet from the enum numbers a descriptor carries */
export function featuresFromNumbers(numbers: Partial<Record<keyof FeatureSet, number>>): FeatureSet {
    return {
        fieldPresence: lookup(FIELD_PRESENCE, numbers.fieldPresence),
        enumType: lookup(ENUM_TYPE, numbers.enumType),
        repeatedFieldEncoding: lookup(REPEATED_ENCODING, numbers.repeatedFieldEncoding),
        utf8Validation: lookup(UTF8_VALIDATION, numbers.utf8Validation),
        messageEncoding: lookup(MESSAGE_ENCODING, numbers.messageEncoding),
        jsonFormat: lookup(JSON_FORMAT, numbers.jsonFormat)
    };
}

/** Builds a FeatureSet from the names used in `.proto` source */
export function featuresFromNames(name: string, value: string): FeatureSet {
    switch (name) {
        case 'field_presence': return { fieldPresence: pick(FIELD_PRESENCE, value) };
        case 'enum_type': return { enumType: pick(ENUM_TYPE, value) };
        case 'repeated_field_encoding': return { repeatedFieldEncoding: pick(REPEATED_ENCODING, value) };
        case 'utf8_validation': return { utf8Validation: pick(UTF8_VALIDATION, value) };
        case 'message_encoding': return { messageEncoding: pick(MESSAGE_ENCODING, value) };
        case 'json_format': return { jsonFormat: pick(JSON_FORMAT, value) };
        default: return {};
    }
}

function lookup<T>(table: Record<number, T>, value: number | undefined): T | undefined {
    return value === undefined ? undefined : table[value];
}

function pick<T>(table: Record<number, T>, value: string): T | undefined {
    for (const candidate of Object.values(table)) {
        if (candidate === value) return candidate as T;
    }
    return undefined;
}
