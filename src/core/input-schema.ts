import type { SkillManifest } from "./skill-registry.js";
import { l } from "./i18n.js";

type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  default?: unknown;
  enum?: unknown[];
  items?: JsonSchema;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export function validateSkillArgs(manifest: SkillManifest, args: Record<string, unknown>): Record<string, unknown> {
  try {
    const value = validateValue(args, manifest.input?.schema || { type: "object" }, "input");
    if (!isPlainObject(value)) {
      throw new Error(l("input must be an object", "input は object である必要があります"));
    }
    return value as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(l(`Invalid input for ${manifest.id}: ${message}`, `${manifest.id} の入力が不正です: ${message}`));
  }
}

function validateValue(value: unknown, schema: JsonSchema, label: string): unknown {
  if (value === undefined) {
    if ("default" in schema) {
      return schema.default;
    }
    return value;
  }

  if (schema.enum && !schema.enum.some((item) => deepEqual(item, value))) {
    throw new Error(l(`${label} must be one of: ${schema.enum.map(String).join(", ")}`, `${label} は次のいずれかである必要があります: ${schema.enum.map(String).join(", ")}`));
  }

  const type = firstType(schema);
  if (!type && (schema.properties || schema.required)) {
    return validateObject(value, schema, label);
  }

  switch (type) {
    case "object":
      return validateObject(value, schema, label);
    case "array":
      return validateArray(value, schema, label);
    case "string":
      return validateString(value, schema, label);
    case "integer":
      return validateNumber(value, schema, label, true);
    case "number":
      return validateNumber(value, schema, label, false);
    case "boolean":
      return validateBoolean(value, label);
    case undefined:
      return value;
    default:
      throw new Error(l(`${label} uses unsupported schema type: ${type}`, `${label} は未対応の schema type です: ${type}`));
  }
}

function validateObject(value: unknown, schema: JsonSchema, label: string): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new Error(l(`${label} must be an object`, `${label} は object である必要があります`));
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const properties = schema.properties || {};
  const required = schema.required || [];

  for (const key of required) {
    if (!(key in source) || source[key] === undefined) {
      throw new Error(l(`${label}.${key} is required`, `${label}.${key} は必須です`));
    }
  }

  for (const [key, itemSchema] of Object.entries(properties)) {
    if (key in source) {
      result[key] = validateValue(source[key], itemSchema, `${label}.${key}`);
    } else if ("default" in itemSchema) {
      result[key] = itemSchema.default;
    }
  }

  for (const [key, item] of Object.entries(source)) {
    if (key in properties) {
      continue;
    }
    if (schema.additionalProperties === false) {
      throw new Error(l(`${label}.${key} is not allowed`, `${label}.${key} は許可されていません`));
    }
    result[key] = item;
  }

  return result;
}

function validateArray(value: unknown, schema: JsonSchema, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(l(`${label} must be an array`, `${label} は array である必要があります`));
  }
  if (schema.minItems !== undefined && value.length < schema.minItems) {
    throw new Error(l(`${label} must contain at least ${schema.minItems} item(s)`, `${label} は最低 ${schema.minItems} 件必要です`));
  }
  if (schema.maxItems !== undefined && value.length > schema.maxItems) {
    throw new Error(l(`${label} must contain at most ${schema.maxItems} item(s)`, `${label} は最大 ${schema.maxItems} 件までです`));
  }
  if (!schema.items) {
    return value;
  }
  return value.map((item, index) => validateValue(item, schema.items as JsonSchema, `${label}[${index}]`));
}

function validateString(value: unknown, schema: JsonSchema, label: string): string {
  let normalized: string;
  if (typeof value === "string") {
    normalized = value;
  } else if (typeof value === "number" || typeof value === "boolean") {
    normalized = String(value);
  } else {
    throw new Error(l(`${label} must be a string`, `${label} は string である必要があります`));
  }
  if (schema.minLength !== undefined && normalized.length < schema.minLength) {
    throw new Error(l(`${label} must be at least ${schema.minLength} character(s)`, `${label} は最低 ${schema.minLength} 文字必要です`));
  }
  if (schema.maxLength !== undefined && normalized.length > schema.maxLength) {
    throw new Error(l(`${label} must be at most ${schema.maxLength} character(s)`, `${label} は最大 ${schema.maxLength} 文字までです`));
  }
  return normalized;
}

function validateNumber(value: unknown, schema: JsonSchema, label: string, integer: boolean): number {
  let normalized = value;
  if (typeof normalized === "string" && normalized.trim() !== "") {
    normalized = Number(normalized);
  }
  if (typeof normalized !== "number" || !Number.isFinite(normalized)) {
    throw new Error(l(`${label} must be a ${integer ? "integer" : "number"}`, `${label} は ${integer ? "integer" : "number"} である必要があります`));
  }
  if (integer && !Number.isInteger(normalized)) {
    throw new Error(l(`${label} must be an integer`, `${label} は integer である必要があります`));
  }
  if (schema.minimum !== undefined && normalized < schema.minimum) {
    throw new Error(l(`${label} must be at least ${schema.minimum}`, `${label} は ${schema.minimum} 以上である必要があります`));
  }
  if (schema.maximum !== undefined && normalized > schema.maximum) {
    throw new Error(l(`${label} must be at most ${schema.maximum}`, `${label} は ${schema.maximum} 以下である必要があります`));
  }
  return normalized;
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(l(`${label} must be a boolean`, `${label} は boolean である必要があります`));
}

function firstType(schema: JsonSchema): string | undefined {
  if (Array.isArray(schema.type)) {
    return schema.type[0];
  }
  return schema.type;
}

function isPlainObject(value: unknown): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
