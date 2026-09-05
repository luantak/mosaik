import type { Page } from "playwright";
import type { ActionImplementation, SiteActionDefinition } from "../capabilities/types.js";
import type { AutomationFailure, ExecutionContextId } from "../core/types.js";
import type { BeforeValues } from "../runtime/conditions.js";

/** In-memory continuation only. The page and outputs belong to this invocation. */
export interface ActionCheckpoint {
  action: SiteActionDefinition;
  implementation: ActionImplementation;
  inputs: Record<string, unknown>;
  context: ExecutionContextId;
  completedSteps: string[];
  failedStepIndex: number;
  outputs: Record<string, unknown>;
  before: BeforeValues;
  page: Page;
  failure: AutomationFailure;
}
