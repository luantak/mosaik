const chains = new Map<string, Promise<unknown>>();

export async function withKeyedLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => undefined).then(() => held);
  chains.set(key, chain);
  try {
    await previous.catch(() => undefined);
    return await run();
  } finally {
    release();
    if (chains.get(key) === chain) chains.delete(key);
  }
}
