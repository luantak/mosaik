import type { Page } from "playwright";
import { resolveLocator } from "../runtime/locators.js";
import type { DiscoveryGoal } from "./types.js";

export interface GoalCheck {
  reached: boolean;
  goalReached: boolean;
  goal: DiscoveryGoal;
  detail?: string;
}

export function goalCheck(reached: boolean, goal: DiscoveryGoal, detail?: string): GoalCheck {
  return {
    reached,
    goalReached: reached,
    goal,
    ...(detail === undefined ? {} : { detail }),
  };
}

export async function evaluateGoal(page: Page, goal: DiscoveryGoal): Promise<GoalCheck> {
  if (goal.type === "agent-confirmed") {
    return goalCheck(false, goal, "agent-confirmed requires finishDiscovery");
  }
  if (goal.type === "url") {
    const url = page.url();
    return goalCheck(url.includes(goal.matches), goal, url);
  }
  if (goal.type === "text") {
    const text = await page.locator("body").innerText();
    return goalCheck(text.includes(goal.contains), goal);
  }
  const locator = resolveLocator(page, goal.locator);
  const matches = await locator.count().catch(() => 0);
  const visible = matches === 1 && (await locator.isVisible().catch(() => false));
  return goalCheck(visible, goal, `${matches} matches`);
}

export function effectiveGoal(goal: DiscoveryGoal | undefined): DiscoveryGoal {
  return goal ?? { type: "agent-confirmed" };
}
