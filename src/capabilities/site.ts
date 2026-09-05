export function normalizeSiteId(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) throw new Error("siteId is required");
  try {
    const url = trimmed.includes("://") ? new URL(trimmed) : new URL(`https://${trimmed}`);
    return url.host;
  } catch {
    throw new Error(`Invalid siteId: ${value}`);
  }
}
