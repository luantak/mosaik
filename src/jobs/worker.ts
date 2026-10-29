/** Runs in the bounded worker. Only JSON crosses into the durable host. */
export const BATCH_WORKER = `
let batchUsed = false;
async function runBatch(config) {
  if (batchUsed) throw new Error("Only one durable collection is supported per automation execution");
  batchUsed = true;
  if (typeof config.list !== "function" || typeof config.extract !== "function")
    throw new Error("batch.run requires deterministic list and extract callbacks");
  await batch.configure({
    key: config.key, initialCursor: config.initialCursor, acceptance: config.acceptance,
    ...(config.retry === undefined ? {} : { retry: config.retry }),
    ...(config.limits === undefined ? {} : { limits: config.limits }),
  });
  while (true) {
    const work = await batch.next({});
    if (work.kind === "done") return work.summary;
    if (work.kind === "wait") { await batch.wait({ delayMs: work.delayMs }); continue; }
    try {
      if (work.kind === "page") {
        const page = await config.list(work.cursor);
        await batch.page({ work, page });
      } else {
        const record = await config.extract(work.input);
        await batch.commit({ work, record });
      }
    } catch (error) {
      await batch.fail({ work, error: String(error && error.message || error) });
    }
  }
}
`;
