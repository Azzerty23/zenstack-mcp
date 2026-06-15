import type { GenericResponse } from "../types.js";

/**
 * Narrows a {@link GenericResponse} to its JSON payload for assertions.
 * Throws if the handler returned an HTML response instead of JSON.
 */
export function jsonData(res: GenericResponse): Record<string, unknown> {
  if (res.type !== "json") {
    throw new Error(`expected a json response, got "${res.type}"`);
  }
  return res.data as Record<string, unknown>;
}
