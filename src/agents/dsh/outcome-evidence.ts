import { EvidenceStore } from "../evidence.js";

/** Summarize repeated records, retaining exact counts and access to every row. */
export function compactOutcomeEvidence(value: unknown, evidence: EvidenceStore): unknown {
  const failed = (item: unknown): boolean => {
    if (!item || typeof item !== "object") return false;
    if (Array.isArray(item)) return item.some(failed);
    const record = item as Record<string, unknown>;
    return (
      Boolean(record.error) ||
      record.success === false ||
      record.status === "failed" ||
      record.status === "incomplete" ||
      Object.values(record).some(
        (child) => child !== null && typeof child === "object" && failed(child),
      )
    );
  };
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      if (item.length <= 8) return item.map(visit);
      const failures = item.filter(failed);
      return {
        totalItems: item.length,
        sample: [...item.slice(0, 3), item.at(-1)].map(visit),
        recordsWithErrors: failures.length,
        ...(failures.length ? { errorSample: failures.slice(0, 3).map(visit) } : {}),
        evidenceId: evidence.add(JSON.stringify(item)),
        instruction:
          "Sample only. Counts describe these records, not task completeness. Retrieve omitted records when their contents are needed.",
      };
    }
    if (!item || typeof item !== "object") return evidence.present(item);
    return Object.fromEntries(Object.entries(item).map(([key, child]) => [key, visit(child)]));
  };
  return visit(value);
}

export function summarizeOutputFiles(
  files: Array<{ relativePath: string; bytes: number }> | undefined,
  evidence: EvidenceStore,
): unknown {
  if (!files) return undefined;
  const extensions: Record<string, number> = {};
  for (const file of files) {
    const extension = file.relativePath.match(/\.([^./]+)$/)?.[1]?.toLowerCase() ?? "(none)";
    extensions[extension] = (extensions[extension] ?? 0) + 1;
  }
  return {
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    emptyFiles: files.filter((file) => file.bytes === 0).length,
    uniquePaths: new Set(files.map((file) => file.relativePath)).size,
    extensions,
    records: compactOutcomeEvidence(files, evidence),
  };
}
