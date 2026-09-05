import type { RunEvent, RunEventType } from "./types.js";

export class RunLog {
  readonly events: RunEvent[] = [];
  readonly startedAt = Date.now();

  constructor(readonly runId: string) {}

  emit(type: RunEventType, extra: Record<string, unknown> = {}): RunEvent {
    const event: RunEvent = {
      t: Date.now() - this.startedAt,
      type,
      runId: this.runId,
      ...extra,
    };
    this.events.push(event);
    return event;
  }
}
