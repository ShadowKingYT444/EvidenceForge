import { types as utilTypes } from "node:util";

const SAFE_RATE_INTERVAL =
  /^(?:0|[1-9]\d{0,8})(?:\.\d{1,6})?(?:ms|s|m|h|d)$/u;

const PASSIVE_SNAPSHOT_ERROR =
  "retrieval configuration contains unsupported values";

function passiveSnapshot(value: unknown, ancestors: Set<object>): unknown {
  if (
    value === null ||
    (typeof value !== "object" && typeof value !== "function")
  ) {
    return value;
  }
  if (typeof value === "function") {
    if (utilTypes.isProxy(value)) {
      throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
    }
    // Dependency callbacks are capabilities, not data. Capture their identity once.
    return value;
  }
  if (utilTypes.isProxy(value) || ancestors.has(value)) {
    throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
  }

  let prototype: object | null;
  let descriptors: PropertyDescriptorMap;
  try {
    prototype = Object.getPrototypeOf(value) as object | null;
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
  }
  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    prototype !== Array.prototype
  ) {
    throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
  }

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    const lengthDescriptor = descriptors.length;
    if (
      lengthDescriptor === undefined ||
      !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number"
    ) {
      throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
    }
    const result: unknown[] = [];
    for (let index = 0; index < lengthDescriptor.value; index += 1) {
      const key = String(index);
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.enumerable !== true
      ) {
        throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
      }
      result.push(passiveSnapshot(descriptor.value, nextAncestors));
      delete descriptors[key];
    }
    delete descriptors.length;
    if (Object.keys(descriptors).length > 0) {
      throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
    }
    return Object.freeze(result);
  }

  const result = Object.create(null) as Record<string, unknown>;
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      writable: false,
      value: passiveSnapshot(descriptor.value, nextAncestors),
    });
  }
  return Object.freeze(result);
}

export function snapshotPassiveValue<T>(value: T): T {
  return passiveSnapshot(value, new Set()) as T;
}

export function validatedOptionalCallback<Callback extends (...args: never[]) => unknown>(
  value: Callback | undefined,
): Callback | undefined {
  if (value !== undefined && typeof value !== "function") {
    throw new TypeError(PASSIVE_SNAPSHOT_ERROR);
  }
  return value;
}

export function requestExceptionOutcome(
  error: unknown,
  signalAborted = false,
): "timeout" | "network_error" {
  if (signalAborted) {
    return "timeout";
  }
  if (
    typeof error !== "object" ||
    error === null ||
    utilTypes.isProxy(error)
  ) {
    return "network_error";
  }

  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(error, "name");
  } catch {
    return "network_error";
  }
  const name =
    descriptor !== undefined &&
    "value" in descriptor &&
    typeof descriptor.value === "string"
      ? descriptor.value
      : null;
  return name === "AbortError" || name === "TimeoutError"
    ? "timeout"
    : "network_error";
}

export function publicExternalUrl(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return null;
    }
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function safeRateLimitInterval(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim();
  return SAFE_RATE_INTERVAL.test(normalized) ? normalized : null;
}

export function emitOptionalTelemetry<Event>(
  sink: ((event: Event) => unknown) | undefined,
  event: Event,
): void {
  if (sink === undefined) {
    return;
  }
  let completion: unknown;
  try {
    completion = sink(event);
  } catch {
    return;
  }
  void (async () => {
    try {
      await completion;
    } catch {
      // Optional telemetry cannot change the retrieval result.
    }
  })();
}

export async function completeBackoff(
  sleep: (milliseconds: number) => Promise<void>,
  milliseconds: number,
): Promise<boolean> {
  try {
    await sleep(milliseconds);
    return true;
  } catch {
    return false;
  }
}
