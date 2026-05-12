export function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function oneLine(value: string, maxChars = 220): string {
  return value.replace(/\s+/g, " ").trim().slice(0, maxChars);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Return a finite number, or undefined for null/undefined/non-finite values.
 * Useful for safely extracting optional numeric metadata fields.
 */
export function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
