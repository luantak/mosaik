import type { LocatorDefinition } from "../core/index.js";
import {
  DEFAULT_DISCOVERY_CONSTRAINTS,
  type DiscoveryProposal,
  type DiscoveryRequest,
} from "./types.js";
import type { DiscoveryTools } from "./tools.js";

export const QUOTES_HOME = "https://quotes.toscrape.com/";
export const QUOTES_TASK = "Filter quotes by humor and open Jane Austen's author page.";

const humorRole: LocatorDefinition = {
  strategy: "role",
  role: "link",
  name: "humor",
  exact: true,
};
const humorSidebar: LocatorDefinition = {
  strategy: "css",
  selector: ".tags-box a[href*='/tag/humor']",
};
const authorLink: LocatorDefinition = {
  strategy: "role",
  role: "link",
  name: "Jane Austen",
  exact: true,
};
const authorHref: LocatorDefinition = {
  strategy: "css",
  selector: "a[href*='/author/Jane-Austen']",
};

export function quotesDiscoveryRequest(startUrl: string): DiscoveryRequest {
  return {
    id: "quotes-humor",
    task: QUOTES_TASK,
    startUrl,
    goal: { type: "url", matches: "/author/Jane-Austen" },
    constraints: DEFAULT_DISCOVERY_CONSTRAINTS,
  };
}

export async function discoverQuotesWorkflow(
  tools: DiscoveryTools,
  startUrl: string,
): Promise<DiscoveryProposal | null> {
  const opened = await tools.exploreNavigate({ url: startUrl });
  if (!opened.ok) throw new Error(opened.error ?? "navigate failed");

  const humor = (await tools.testLocator({ locator: humorRole })).unique ? humorRole : humorSidebar;
  const humorTest = await tools.testLocator({ locator: humor });
  if (!humorTest.unique) {
    throw new Error(`humor tag is not unique (${humorTest.matches} matches)`);
  }
  const filtered = await tools.exploreClick({ locator: humor });
  if (!filtered.ok) throw new Error(filtered.error ?? "humor filter failed");

  const author = (await tools.testLocator({ locator: authorLink })).unique
    ? authorLink
    : authorHref;
  const authorTest = await tools.testLocator({ locator: author });
  if (!authorTest.unique) {
    throw new Error(`Jane Austen link is not unique (${authorTest.matches} matches)`);
  }
  const openedAuthor = await tools.exploreClick({ locator: author });
  if (!openedAuthor.ok) throw new Error(openedAuthor.error ?? "author click failed");

  const goal = await tools.checkGoal();
  if (!goal.reached) {
    throw new Error(`goal not reached: ${goal.detail ?? "unknown page"}`);
  }

  await tools.addStep({
    step: { id: "open", type: "navigate", safety: "browser-local", url: startUrl },
  });
  await tools.addStep({
    step: { id: "filter-humor", type: "click", safety: "read-only", locator: humor },
  });
  await tools.addStep({
    step: { id: "open-author", type: "click", safety: "read-only", locator: author },
  });
  return tools.finish({ status: "discovered" });
}
