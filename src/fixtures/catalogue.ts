import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { defineAction } from "../capabilities/define.js";
import type { SiteActionDefinition } from "../capabilities/types.js";
import { bindAutomationDependencies } from "../automations/dependencies.js";
import { automationSourcePath } from "../library/paths.js";
import { openFileRepository } from "../persist/repository.js";

export const CATALOGUE_CATEGORIES = ["books", "games", "music"] as const;
export type CatalogueCategory = (typeof CATALOGUE_CATEGORIES)[number];
export interface CatalogueRecord {
  id: string;
  title: string;
  category: CatalogueCategory;
}
export interface CatalogueResult extends CatalogueRecord {
  sourceUrl: string;
}

// This is the independent oracle. Expected results never come from the browser,
// saved automation, or an agent's assessment of its output.
export const CATALOGUE_RECORDS: readonly Readonly<CatalogueRecord>[] = Object.freeze(
  Array.from({ length: 1_200 }, (_, index) =>
    Object.freeze({
      id: `record-${String(index + 1).padStart(4, "0")}`,
      title: `Catalogue item ${String(index + 1).padStart(4, "0")}`,
      category: CATALOGUE_CATEGORIES[index % CATALOGUE_CATEGORIES.length]!,
    }),
  ),
);
const byId = new Map(CATALOGUE_RECORDS.map((record) => [record.id, record]));

export interface CatalogueControls {
  unavailableIds: Set<string>;
  /** Remaining HTTP 503 responses, decremented per detail request. */
  transientFailures: Map<string, number>;
  /** Successful HTTP responses containing an empty required title. */
  malformedIds: Set<string>;
  /** Omit references entirely to demonstrate a source exhausted before the requested count. */
  omittedIds: Set<string>;
  layout: "old" | "new";
  newLayoutIds: Set<string>;
  delayMs: number;
}

export function createCatalogueControls(): CatalogueControls {
  return {
    unavailableIds: new Set(),
    transientFailures: new Map(),
    malformedIds: new Set(),
    omittedIds: new Set(),
    layout: "old",
    newLayoutIds: new Set(),
    delayMs: 0,
  };
}

export function expectedCatalogueRecords(
  origin: string,
  category: string = "all",
  requestedCount?: number,
): CatalogueResult[] {
  return CATALOGUE_RECORDS.filter((record) => category === "all" || record.category === category)
    .slice(0, requestedCount)
    .map((record) => ({ ...record, sourceUrl: `${origin}/record/${record.id}` }));
}

export interface CatalogueFixture {
  origin: string;
  url: string;
  controls: CatalogueControls;
  requests: { listing: number; details: Map<string, number> };
  close(): Promise<void>;
}

export async function startCatalogueFixture(
  options: {
    port?: number;
    pageSize?: number;
    overlap?: number;
    controls?: CatalogueControls;
  } = {},
): Promise<CatalogueFixture> {
  const pageSize = options.pageSize ?? 40;
  const overlap = options.overlap ?? 5;
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50)
    throw new Error("Fixture pageSize must be an integer from 1 to 50");
  if (!Number.isSafeInteger(overlap) || overlap < 0 || overlap >= pageSize)
    throw new Error("Fixture overlap must be an integer below pageSize");
  const controls = options.controls ?? createCatalogueControls();
  const requests = { listing: 0, details: new Map<string, number>() };
  let origin = "";
  const server = createServer((request, response) => {
    if (request.method !== "GET") {
      respond(response, 405, "This fixture supports read-only GET requests.");
      return;
    }
    const url = new URL(request.url ?? "/", origin);
    const render = () => {
      if (url.pathname === "/" || url.pathname === "/catalogue") {
        requests.listing++;
        const category = url.searchParams.get("category") ?? "all";
        const query = url.searchParams.get("q") ?? "";
        const offset = Number(url.searchParams.get("offset") ?? "0");
        if (!Number.isSafeInteger(offset) || offset < 0) {
          respond(response, 400, "Invalid pagination offset");
          return;
        }
        const records = CATALOGUE_RECORDS.filter(
          (record) =>
            (category === "all" || record.category === category) &&
            record.title.toLowerCase().includes(query.toLowerCase()) &&
            !controls.omittedIds.has(record.id),
        );
        const page = records.slice(offset, offset + pageSize);
        const next = new URL("/catalogue", origin);
        next.searchParams.set("category", category);
        if (query) next.searchParams.set("q", query);
        next.searchParams.set("offset", String(offset + pageSize - overlap));
        const hasNext = offset + pageSize < records.length;
        respond(
          response,
          200,
          document(
            `Catalogue — ${category}`,
            `<main id="catalogue">
            <h1>Local catalogue</h1>
            <p>Read-only fixture. ${records.length} matching records; each page contains at most ${pageSize} records with ${overlap} overlapping references.</p>
            <form action="/catalogue" method="get">
              <label>Category <select name="category">${["all", ...CATALOGUE_CATEGORIES].map((value) => `<option value="${value}"${value === category ? " selected" : ""}>${value}</option>`).join("")}</select></label>
              <label>Title filter <input name="q" value="${escapeHtml(query)}"></label>
              <button type="submit">Apply filters</button>
            </form>
            <ul>${page.map((record) => `<li><a class="catalogue-item" data-id="${record.id}" href="/record/${record.id}">${record.title}</a> <span>${record.category}</span></li>`).join("")}</ul>
            ${page.length ? "" : '<p class="no-results">No matching records</p>'}
            <nav aria-label="Pagination">${hasNext ? `<a rel="next" href="${escapeHtml(next.href)}">Next page</a>` : '<span class="end-of-catalogue">End of catalogue</span>'}</nav>
          </main>`,
          ),
        );
        return;
      }
      const id = url.pathname.match(/^\/record\/([^/]+)$/)?.[1];
      const record = id === undefined ? undefined : byId.get(id);
      if (!record) {
        respond(response, 404, document("Not found", "<h1>No such record</h1>"));
        return;
      }
      requests.details.set(record.id, (requests.details.get(record.id) ?? 0) + 1);
      if (controls.unavailableIds.has(record.id)) {
        respond(response, 503, document("Unavailable", "<h1>Record temporarily unavailable</h1>"));
        return;
      }
      const failures = controls.transientFailures.get(record.id) ?? 0;
      if (failures > 0) {
        controls.transientFailures.set(record.id, failures - 1);
        respond(response, 503, document("Try again", "<h1>Controlled transient failure</h1>"));
        return;
      }
      const layout =
        controls.layout === "new" || controls.newLayoutIds.has(record.id) ? "entry" : "record";
      const title = controls.malformedIds.has(record.id) ? "" : record.title;
      respond(
        response,
        200,
        document(
          record.title,
          `<main class="detail-page">
        <article class="${layout}" data-id="${record.id}" data-title="${title}" data-category="${record.category}" data-source-url="/record/${record.id}">
          <h1>${title}</h1><p>Category: ${record.category}</p>
          <a rel="canonical" href="/record/${record.id}">Source record</a>
        </article>
        <a href="/catalogue?category=${record.category}">Back to category</a>
      </main>`,
        ),
      );
    };
    if (controls.delayMs > 0) setTimeout(render, controls.delayMs);
    else render();
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    url: `${origin}/catalogue`,
    controls,
    requests,
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
        server.closeAllConnections();
      }),
  };
}

/** Hand-authored fixture library. This is deterministic setup, not agent discovery. */
export async function seedCatalogueAutomation(projectDirectory: string, origin: string) {
  const project = resolve(projectDirectory);
  const store = openFileRepository({ dataRoot: resolve(project, ".mosaik"), libraryRoot: project });
  const siteId = new URL(origin).host;
  const existing = await store.getAutomation(siteId, "catalogue");
  if (existing) {
    return {
      store,
      automation: existing,
      actions: await store.siteActions.list(siteId),
      siteId,
      sourcePath: automationSourcePath(project, siteId, existing.id),
      created: false,
    };
  }
  const actions = catalogueActions(siteId);
  for (const action of actions) await store.siteActions.save(action);
  const automation = bindAutomationDependencies(
    {
      id: "catalogue",
      siteId,
      version: 1,
      inputs: { category: { type: "string" }, requestedCount: { type: "number" } },
      startUrl: `${origin}/catalogue`,
      source: catalogueAutomationSource(origin),
    },
    actions,
  );
  await store.saveAutomation(automation);
  // Return the actual formatted source used by the repository, for fingerprints.
  return {
    store,
    automation: (await store.getAutomation(siteId, automation.id))!,
    actions,
    siteId,
    sourcePath: automationSourcePath(project, siteId, automation.id),
    created: true,
  };
}

export function catalogueActions(siteId: string): SiteActionDefinition[] {
  return [
    defineAction({
      id: "catalogue.open-page",
      siteId,
      name: "openPage",
      description: "Open an observed catalogue listing or record URL",
      inputs: { url: { type: "string" } },
      outputs: {},
      safety: "browser-local",
      steps: [
        {
          id: "navigate",
          type: "navigate",
          url: { kind: "input", key: "url" },
          safety: "browser-local",
        },
      ],
      completion: { kind: "url", value: { kind: "input", key: "url" }, comparison: "equals" },
    }),
    defineAction({
      id: "catalogue.list-records",
      siteId,
      name: "listRecords",
      description:
        "Read record references and the next page URL from the current catalogue listing",
      inputs: {},
      outputs: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, href: { type: "string" } },
          },
        },
        next: {
          type: "array",
          items: { type: "object", properties: { href: { type: "string" } } },
        },
      },
      safety: "read-only",
      precondition: {
        kind: "count",
        locator: { strategy: "css", selector: "#catalogue" },
        count: 1,
      },
      completion: { kind: "count", locator: { strategy: "css", selector: "#catalogue" }, count: 1 },
      steps: [
        {
          id: "references",
          type: "extract-list",
          safety: "read-only",
          locator: { strategy: "css", selector: ".catalogue-item" },
          output: "items",
          fields: {
            id: { source: "attr", name: "data-id" },
            href: { source: "url", name: "href" },
          },
          empty: { kind: "count", locator: { strategy: "css", selector: ".no-results" }, count: 1 },
        },
        {
          id: "next-page",
          type: "extract-list",
          safety: "read-only",
          locator: { strategy: "css", selector: 'a[rel="next"]' },
          output: "next",
          fields: { href: { source: "url", name: "href" } },
          empty: {
            kind: "count",
            locator: { strategy: "css", selector: ".end-of-catalogue" },
            count: 1,
          },
        },
      ],
    }),
    defineAction({
      id: "catalogue.read-record",
      siteId,
      name: "readRecord",
      description: "Read the current catalogue record including its source URL",
      inputs: {},
      outputs: {
        records: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              title: { type: "string" },
              category: { type: "string" },
              sourceUrl: { type: "string" },
            },
          },
        },
      },
      safety: "read-only",
      precondition: {
        kind: "count",
        locator: { strategy: "css", selector: ".detail-page" },
        count: 1,
      },
      completion: {
        kind: "count",
        locator: { strategy: "css", selector: ".detail-page" },
        count: 1,
      },
      steps: [
        {
          id: "record",
          type: "extract-list",
          safety: "read-only",
          locator: { strategy: "css", selector: ".record" },
          output: "records",
          fields: {
            id: { source: "attr", name: "data-id" },
            title: { source: "attr", name: "data-title" },
            category: { source: "attr", name: "data-category" },
            sourceUrl: { source: "url", name: "data-source-url" },
          },
        },
      ],
    }),
  ];
}

export function catalogueAutomationSource(origin: string): string {
  return `// Hand-authored fixture seed; no agent discovery was performed.
import { defineAutomation } from "mosaik/automations";
import { openPage } from "../actions/openPage.js";
import { listRecords } from "../actions/listRecords.js";
import { readRecord } from "../actions/readRecord.js";

export default defineAutomation(import.meta.url, async (ctx, input: { category: string; requestedCount: number }) => {
  return ctx.batch.run({
    key: "records",
    initialCursor: ${JSON.stringify(`${origin}/catalogue?category=`)} + encodeURIComponent(input.category),
    acceptance: {
      requiredFields: ["id", "title", "category", "sourceUrl"],
      idField: "id",
      sourceUrlField: "sourceUrl",
      requestedCount: input.requestedCount,
    },
    retry: { maxAttempts: 3, baseDelayMs: 20, maxDelayMs: 100 },
    list: async (cursor) => {
      await openPage(ctx, { url: cursor });
      const page = await listRecords(ctx, {});
      return {
        items: page.items.map(item => ({ id: item.id, input: item })),
        nextCursor: page.next[0]?.href ?? null,
        exhausted: page.next.length === 0,
      };
    },
    extract: async (item) => {
      await openPage(ctx, { url: String(item.href) });
      const result = await readRecord(ctx, {});
      if (result.records.length !== 1) throw new Error("Expected one record per detail page");
      return result.records[0];
    },
  });
});
`;
}

function document(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body>${body}</body></html>`;
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

function respond(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}
