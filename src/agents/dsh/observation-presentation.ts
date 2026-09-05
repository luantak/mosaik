import type { EvidenceStore } from "../evidence.js";

/** Samples are planning evidence, never complete runtime extraction results. */
export function presentObservation(
  value: unknown,
  evidence: EvidenceStore,
): Record<string, unknown> {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (!item || typeof item !== "object") return evidence.present(item);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(item)) {
      if (
        Array.isArray(child) &&
        child.length > 12 &&
        !["regions", "forms", "landmarks", "collections"].includes(key)
      ) {
        result[key] = [...child.slice(0, 8), ...child.slice(-4)].map(visit);
        result[`${key}Summary`] = {
          totalItems: child.length,
          sampled: true,
          evidenceId: evidence.add(JSON.stringify(child)),
          instruction:
            "Sample only. Use readEvidence to inspect omitted entries before concluding an item is absent.",
        };
      } else {
        result[key] = visit(child);
      }
    }
    return result;
  };
  return visit(value) as Record<string, unknown>;
}

/** Planning follows observed URLs and does not need actionable DOM locators. */
export function withoutObservationLocators(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutObservationLocators);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "locator")
      .map(([key, child]) => [key, withoutObservationLocators(child)]),
  );
}
