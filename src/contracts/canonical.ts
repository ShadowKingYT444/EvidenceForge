import { createHash } from "node:crypto";

type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

function assertValidUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("RFC 8785 input contains an unpaired surrogate");
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("RFC 8785 input contains an unpaired surrogate");
    }
  }
}

function serialize(value: unknown): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }

  if (typeof value === "string") {
    assertValidUnicode(value);
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("RFC 8785 input numbers must be finite");
    }
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    const serialized: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value) || value[index] === undefined) {
        throw new TypeError("RFC 8785 input arrays cannot be sparse or undefined");
      }
      serialized.push(serialize(value[index]));
    }
    return `[${serialized.join(",")}]`;
  }

  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("RFC 8785 input must contain plain JSON objects");
    }

    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => {
        const entry = record[key];
        if (entry === undefined) {
          throw new TypeError(
            "RFC 8785 input objects cannot contain undefined values",
          );
        }
        assertValidUnicode(key);
        return `${JSON.stringify(key)}:${serialize(entry)}`;
      });
    return `{${entries.join(",")}}`;
  }

  throw new TypeError(`RFC 8785 cannot serialize ${typeof value}`);
}

export function canonicalizeJson(value: unknown): string {
  return serialize(value);
}

export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}
