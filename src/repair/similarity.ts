export function similarity(left: string, right: string): number {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (a.length === 0 || b.length === 0) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.7;
  const pairsA = bigrams(a);
  const pairsB = bigrams(b);
  if (pairsA.size === 0 || pairsB.size === 0) return 0;
  let overlap = 0;
  for (const pair of pairsA) {
    if (pairsB.has(pair)) overlap += 1;
  }
  return (2 * overlap) / (pairsA.size + pairsB.size);
}

export function normalizeName(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function namesEqual(left: string, right: string): boolean {
  return normalizeName(left) === normalizeName(right);
}

export function isFuzzySubstring(left: string, right: string): boolean {
  const a = normalizeName(left);
  const b = normalizeName(right);
  if (a.length === 0 || b.length === 0 || a === b) return false;
  return a.includes(b) || b.includes(a);
}

function bigrams(value: string): Set<string> {
  const pairs = new Set<string>();
  for (let index = 0; index < value.length - 1; index += 1) {
    pairs.add(value.slice(index, index + 2));
  }
  return pairs;
}
