import { createHash } from "node:crypto";

/** Deltas refer only to snapshots already delivered in this discovery session. */
export class OverviewHistory {
  private previous: Record<string, unknown> | undefined;
  private previousId: string | undefined;

  present(snapshot: unknown, full = false): Record<string, unknown> {
    const current = structuredClone(snapshot) as Record<string, unknown>;
    const overviewId = createHash("sha256")
      .update(JSON.stringify(current))
      .digest("hex")
      .slice(0, 16);
    const baseOverviewId = this.previousId;
    const previous = this.previous;
    this.previous = current;
    this.previousId = overviewId;
    if (full || !previous) return { ...current, overviewId, full: true };
    const changed = Object.fromEntries(
      Object.entries(current).filter(
        ([key, value]) => JSON.stringify(value) !== JSON.stringify(previous[key]),
      ),
    );
    const removedFields = Object.keys(previous).filter((key) => !(key in current));
    return {
      overviewId,
      baseOverviewId,
      full: false,
      unchanged: overviewId === baseOverviewId,
      // Always supply page identity, including fragment-only navigation changes.
      url: current.url,
      title: current.title,
      ...changed,
      ...(removedFields.length ? { removedFields } : {}),
    };
  }
}
