export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export class JsonValueValidationError extends Error {}

export function normalizeJsonValue(value: unknown, label = "JSON value"): JsonValue {
  return deepFreezeJson(normalizeJsonValueInternal(value, label, new WeakSet()));
}

function normalizeJsonValueInternal(
  value: unknown,
  label: string,
  ancestors: WeakSet<object>
): JsonValue {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new JsonValueValidationError(`${label} 包含非有限数值`
      );
    }
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== "object" || value === null) {
    throw new JsonValueValidationError(`${label} 不是 JSON-safe 值`
    );
  }
  if (ancestors.has(value)) {
    throw new JsonValueValidationError(`${label} 包含循环引用`
    );
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          throw new JsonValueValidationError(`${label}[${index}] 是稀疏数组空位`
          );
        }
        result.push(normalizeJsonValueInternal(
          value[index],
          `${label}[${index}]`,
          ancestors
        ));
      }
      return result;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new JsonValueValidationError(`${label} 包含非普通对象`
      );
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new JsonValueValidationError(`${label} 包含 Symbol 字段`
      );
    }
    const ownNames = Object.getOwnPropertyNames(value);
    const enumerableKeys = Object.keys(value);
    if (ownNames.length !== enumerableKeys.length) {
      throw new JsonValueValidationError(`${label} 包含不可枚举字段`
      );
    }
    const result: Record<string, JsonValue> = {};
    for (const key of enumerableKeys.sort()) {
      Object.defineProperty(result, key, {
        value: normalizeJsonValueInternal(
          (value as Record<string, unknown>)[key],
          `${label}.${key}`,
          ancestors
        ),
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function deepFreezeJson(value: JsonValue): JsonValue {
  if (value !== null && typeof value === "object") {
    for (const child of (Array.isArray(value) ? value : Object.values(value)) as readonly JsonValue[]) {
      deepFreezeJson(child);
    }
    Object.freeze(value);
  }
  return value;
}
