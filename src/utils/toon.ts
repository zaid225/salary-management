import { encode, decode, type EncodeOptions, type DecodeOptions } from "@toon-format/toon";

/**
 * TOON (Token-Oriented Object Notation) is a compact, LLM-friendly
 * serialization of JSON - typically 30-60% fewer tokens than JSON for the
 * same data, especially uniform arrays of objects (tabular data). Use this
 * when building prompt context from structured data (DB rows, API
 * responses) to send to OpenRouter - not for wire format between services,
 * where JSON stays the right choice.
 */
export function jsonToToon(data: unknown, options?: EncodeOptions): string {
  return encode(data, options);
}

export function toonToJson<T = unknown>(toon: string, options?: DecodeOptions): T {
  return decode(toon, options) as T;
}
