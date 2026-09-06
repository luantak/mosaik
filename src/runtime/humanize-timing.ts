export const HUMANIZED_CURSOR_TIMING = {
  moveSpeed: [500, 750] as const,
  routeDurationScale: 0.8,
} as const;

export function humanizedCursorRouteDurationMs(distance: number): number {
  return Math.round(
    Math.min(850, 180 + distance * 0.45) * HUMANIZED_CURSOR_TIMING.routeDurationScale,
  );
}
