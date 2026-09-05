import { createHash } from "node:crypto";

/** Full content stays outside model messages and can be retrieved in bounded pages. */
export class EvidenceStore {
  constructor(readonly entries: Record<string, string> = {}) {}

  add(text: string): string {
    const id = createHash("sha256").update(text).digest("hex");
    this.entries[id] = text;
    return id;
  }

  present(value: unknown): unknown {
    const seen = new Set<string>();
    const visit = (item: unknown): unknown => {
      if (typeof item === "string" && item.length > 4000) {
        const id = this.add(item);
        const repeated = seen.has(id);
        seen.add(id);
        return {
          evidenceId: id,
          length: item.length,
          ...(repeated ? {} : { preview: item.slice(0, 2000) }),
          truncated: true,
        };
      }
      if (Array.isArray(item)) return item.map(visit);
      if (item && typeof item === "object")
        return Object.fromEntries(
          Object.entries(item).map(([key, content]) => [key, visit(content)]),
        );
      return item;
    };
    return visit(value);
  }

  read(id: string, offset = 0, limit = 8000) {
    const text = this.entries[id];
    if (text === undefined) throw new Error("Unknown evidence ID");
    if (
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 16000
    )
      throw new Error("Use a nonnegative integer offset and a limit from 1 to 16000");
    const end = Math.min(text.length, offset + limit);
    return {
      evidenceId: id,
      offset,
      text: text.slice(offset, end),
      length: text.length,
      ...(end < text.length ? { nextOffset: end } : {}),
    };
  }
}
