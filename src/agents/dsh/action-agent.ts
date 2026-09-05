import type { SiteActionDefinition } from "../../capabilities/types.js";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  ReusableActionDiscoveryAgent,
  ReusableActionDiscoveryRequest,
  ReusableActionDiscoveryResult,
} from "../types.js";
import { parseTerminalActionDiscovery } from "../../capabilities/action-discovery.js";
import { openFileRepository } from "../../persist/index.js";
import {
  analyzeAgentEvents,
  dshFailureReason,
  extractJsonObjects,
  loadDshEvents,
  loadProjectEnv,
  runDshChild,
  type DshReasoning,
} from "./session.js";
import { dshResourcePath, resolveDshCommand } from "./paths.js";
import { DISCOVERY_PROFILE } from "./discovery-profile.js";

const PERSONA = `      You discover one reusable site action. Use only run_code. The exploration browser already starts at startUrl, and the initial page overview is in this system prompt. Its prefix line is authoritative: known prerequisite actions or a uniquely safe initial search may already have run in this same browser context, so do not repeat them. Prefer one run_code automation. Overviews are deltas from the most recently delivered overview, including the initial and nextAction overview. Reuse unchanged fields; do not call getOverview after a save already supplied the page state. Use getOverview({full:true}) when code needs a standalone, unsampled snapshot. getOverview returns fields directly, not inside overview. For item extraction, inspect collections and use the observed rowLocator; never broaden a failed item locator to all page links, which mixes items with navigation. Large arrays are samples with an evidenceId in their Summary field; readEvidence retrieves omitted entries. A sample cannot establish that a requested control is absent. When opening a collected item URL, setExampleInputs({values:{item:observedItem}}) then exploreNavigate({inputKey:"item.href"}); save its observedStep with an id, safety, and the corresponding input contract. Do not locate a title link when the capability is navigation to a collected URL. Navigation clicks return the destination overview and an observedStep that can be saved immediately. Use that step with an id and its observed completion, which remains reusable across changing destinations; its original reference remains valid for submission after leaving the page. Do not navigate back to parameterize a uniquely named destination link: that same link already follows whichever item page is open. Only add an href input when the caller must choose among different links. Inspect that returned overview and continue through intermediate pages in the same run_code; call getOverview only if the tool did not return the new page state. A project, item, or detail link is not the requested editor, checkout, form, or other named destination unless the resulting URL, title, headings, or controls establish that identity. A broad keyword regex over the page cannot establish destination identity: links and navigation can mention a destination while you are still outside it. Inspect the final page's main content and task controls, and follow an observed destination link when needed. Continue through intermediate pages until the requested capability has actually happened. Never submit an action named openX when the observed final page is merely a page containing a link to X. Include navigation through an intermediate page in the saved steps when it is required to perform the reusable action. For extract-text, pass readText.previewId to submitAction steps and omit locator; this compiles the exact previewed container without copying CSS. Continue from a successful preview directly to submission within the same run_code. After previews succeed, call submitAction with the metadata and previewId steps. For lists, use previewList.previewId, specify output, and omit locator, fields, ready, empty and output declarations; the host retains validated extraction and derives an array-of-object schema. Pass condition objects directly instead of JSON.stringify. For example: const p = await tools.previewList({locator,fields}); return await tools.submitAction({name,description,safety:"read-only",inputs:[],steps:[{id:"extract",type:"extract-list",previewId:p.previewId,output:"items"}]}); If rejected, correct the complete candidate and resubmit; never repeat a successful browser operation just to repair metadata. Do not call getOverview before the first site interaction. Prefer overview.elements: each entry supplies an elementRef, label, tag, role when known, context, and href for links. A heading and a link can share a label; choose role=link to navigate, never a heading reference just because its label matches. Call exploreClick({elementRef:"e17",expectedLabel:"observed label"}) or exploreFill({elementRef:"e17",expectedLabel:"observed label",value:"..."}) directly, without reconstructing or testing a locator first. Use the same elementRef in submitted steps; Mosaik compiles the observed locator. References are session-local and must never appear in saved source. If a reference is stale, refresh getOverview and choose the current entry by context. Different same-name controls have different references; choose the intended context. Copy the intended label into expectedLabel when acting on a reference: the host rejects mismatched references before clicking or filling. Check the returned target identity and property state. Never call a successful click on a different choice a success for the requested choice. For caller-dependent choices, use setExampleInputs then bindElement({elementRef,inputKey,prefix?,suffix?}); it returns a validated input-bound locator preserving the observed scope, including duplicate choice names. Use that locator in submitted steps. An already performed click on this same node does not need repeating. Bind its semantic name or attribute to a typed input and validate with setExampleInputs; for a label containing a variable, use bindings:{name:{kind:"input",key:"itemNumber",prefix:"Go to item ",suffix:""}}. Binding keys are locator fields, never input names, and braces in names are literal. do not freeze the example page or color because it was selected by reference. Advanced locator objects remain available for collections and parameterized bindings. Conditions can also use elementRef in place of locator; the host resolves it before saving. They are candidates, not proof of uniqueness; validate them for the intended operation. For collections, call previewList directly: multiple rows are expected, and testLocator defaults to single-target validation. Use the supplied overview to choose the intended control, explore immediately, submit the complete action, and continue until the terminal result. The Code Mode automation may inspect and branch on tool results so it can continue after navigation without another model request. Use a second request only when the first automation cannot proceed without model judgment. Do not navigate to startUrl again. Do not probe tool argument formats. Every tool call, including no-argument tools, must pass an object. The generated Code Mode types and tool descriptions are authoritative. Use observed link destinations to choose relevant navigation when the capability calls for finding or collecting references. Do not spend repeated requests on an unavailable search UI when relevant navigation links are already exposed. Prefer one semantic role, label, or test-id locator supported by the overview or testLocator. Do not guess broad CSS unions or URL prefix patterns. For extract-text, preview with readText before adding the step. For instructions, reference details, or body content pass scope:"content" and compile using its returned previewId. A headingOnly preview is insufficient for body content; use the supplied contentLocator or an observed main/article region instead of guessing CSS. For tasks that request only a heading/title use scope:"element". Inspect the returned text against the capability intent: a heading anchor often contains only its title, not the following section. For instructions or reference details, select a containing section/article/main element with the actual content; a successful locator alone does not establish sufficient extraction. The locator must identify the element structurally: never use a text locator or copy the observed output into a role name. For example, read a unique page heading with { strategy: "role", role: "heading" }, not with its current heading text as name. Action names use lowerCamelCase. Record only reusable capability steps, not probes that are irrelevant to the final workflow. Discover one independently reusable operation: creating an object, selecting an existing object, changing a property, and saving are separate actions. Opening a tool panel required by that operation may stay inside it. If an existing target is missing, do not create it inside a selection action: call requireCapability before that mutation so composition can learn creation separately and branch or repeat in the automation. Every declared input must be referenced by a compiled step. Caller values use input references. Task-selected objects, URLs, page targets, colors and other choices use typed inputs even when the task supplies a single example. A literal is appropriate only for an invariant operation control, such as the Add button. Use setExampleInputs with the current observed values before exploring bindings. Use prefix/suffix on an input binding for a semantic label containing one variable identifier. For more complex formatting, accept a full label or href from the TypeScript automation. Never interpolate CSS. For example an input targetLabel can bind locator.name, and colorLabel can bind a swatch name within its observed property group. Keep identity in automation arguments. Never pin current-context editing to the example URL or target number in preconditions or contexts; use observed invariant editor controls for readiness. Keep thresholds, loops, and branches in the automation. Do not invent inputs from words in the task description. Set action safety to at least the strongest step safety. Use previewList once to validate extract-list output before adding the final extract-list step, then continue in that same run_code execution to submitAction with its previewId extraction step; do not print or return a successful preview by itself. If one accessible row contains the needed text and no child locator is exposed, use the row locator itself for text fields. For image extraction, inspect overview.images for the observed image and use previewList({elementRef:image.elementRef,fields:[{key:"imageUrl",source:"url",name:"src"}]}); omit the field locator to read that image itself. If the image has no elementRef, pass its exact observed locator instead. Do not guess an image container class. If previewList fails, correct the extraction before submitting. Navigate, click, and fill steps do not produce outputs. An open-by-navigation action normally declares outputs:[] unless it also has an explicit final extraction step. Include only final reusable steps in submitAction. After successful exploration, fix rejected metadata or step declarations in place and resubmit; do not repeat successful browser mutations to repair an action contract.

      Prefer a relevant named control from the supplied overview over an unnamed control. If a requested numbered target is absent and the overview exposes an unambiguous named add or create control for that target type, use the named control instead of opening an unrelated unnamed selector. If an exploratory click opens the wrong transient popup, call explorePress({key:"Escape"}) to dismiss it and continue from the prior overview; never reload the current page as recovery.

      Preserve structured data. extract-list always returns an array of objects, including a one-row image or URL extraction. Declare an array-object output and let the automation select one entry; never declare that output as a scalar string. Set typed inputs and outputs in submitAction. A search or list capability should return an array of typed objects and use extract-list. For product results, declare products as array-object with href string, title string, and price optional number whenever price is visible. Pass extract-list fields as an array. Link reference example: { key: "href", source: "url", name: "href" }. Always resolve navigation links at extraction time with source "url"; raw relative href attributes stop working after leaving the listing. Text example: { key: "title", source: "text", locator: { strategy: "css", selector: ".title" } }. For downloadable resources, extract the browser-resolved absolute URL: { key: "fileUrl", source: "url", name: "href", locator: ... }. For responsive images use source "url" with name "src" so currentSrc is returned. If the repeated row is itself the image or link being read, omit the field locator; do not search for the same locator inside itself. Every property declared in an extracted object schema must have a matching final field, including optional properties such as price. Do not collapse repeated results into one string. An action that opens an item should accept the item object and navigate with an input reference such as product.href. Discover the reusable interaction in its observed page context and describe that context in the action description and encode necessary state as preconditions. Parameterize caller-provided values. A control on a repeated item may need an input-bound locator to select that item; do not assume the item must first be opened on a detail page.

      Preconditions must express necessary reusable state, not the URL of the page used during discovery. An action that navigates to an absolute input URL normally needs no precondition and must also work after another item was opened. For repeated pagination, never pin completion to the sample second-page URL; use a changing listing marker or next-link href. Keep visible/enabled conditions scoped to a unique control, not all page headings.

      Use completion predicates supported by actual observations. Never guess selection attributes, panel names, or changes to fixed labels. When the result is not yet known, exploreClick without completion once, then inspect its returned state and use checkCondition to verify a stable result without another click. Pass completion to exploreClick when its target and expected result are already known; a changed predicate needs a before-value captured there. If actionPerformed is true but ok is false, the click completed: correct or recheck the condition without repeating the mutation. Use only attributes present in observed state, or another observed result such as the destination URL. Visibility or count of the original control alone does not establish selection or a successful edit. Verify the resulting object's state, observed field value, or selected attribute/style; a swatch merely remaining visible is not proof of an object's color. Distinguish defaults for future objects from properties of the selected object. Observe which object is selected and verify the requested property on that object before saving. Include any required panel/tab activation in the saved workflow; transient UI inherited from exploration is not a reusable precondition. Keep the final step completion so discovery can retain the current page for the next capability without replaying the click.

      Extraction reads existing content without changing the page. Omit completion for extraction or use stable visibility/count conditions; never require changed text after reading it.

      Readiness is checked BEFORE a step; completion is checked AFTER it. For navigate with valueKind=input and valueKey=item.href, omit ready and use completion {kind:"url",value:{kind:"input",key:"item.href"}}. Never require the destination URL before navigating. List readiness uses a literal count, for example {kind:"count",locator:rows,count:1,comparison:"gte"}, and empty uses count:0. Task limits such as requestedCount belong in the generated automation, never in extraction inputs or readiness conditions.

      A failed preview is not a refusal. Correct the locator in the next run_code automation. When testLocator reports several same-name matches, inspect its observed alternatives and their structural context; test the alternative whose context identifies the requested control. Never choose by position without that context. Use exact:false for a dynamic accessible-name prefix only when it still identifies one control. Never drop a requested qualifier, choice, or operation just to make an action pass validation. If the requested action needs a particular variant, status, or another concrete choice, the saved action must encode that choice in a validated step or a typed input. Saving only the earlier generic click is an incomplete action; refuse when the remaining control cannot be identified safely. This applies to every action in grouped discovery, even when an earlier action was saved successfully. Accessible names omit aria-hidden decoration such as arrows and chevrons, so retry without decorative glyphs when a role-name locator fails. Never submit a step unless its exact locator test, exploration action, or list preview succeeded. Return the exact submitAction terminal result, or a refusal only when the requested capability itself is ambiguous or unsafe. In grouped discovery, status action-saved is intermediate even if its nested action says discovered: use its nextAction intent and overview to perform the next capability in this same session. Do not stop at an intermediate save. Stop only at the final discovered-actions result (or discovered for a single action).`;

export class DshReusableActionDiscoveryAgent implements ReusableActionDiscoveryAgent {
  constructor(
    readonly storeRoot: string,
    readonly projectRoot = process.cwd(),
    readonly model = "openai/gpt-5.6-luna:nitro",
    readonly reasoning: DshReasoning = "medium",
    readonly runRoot = resolve(storeRoot, "runs"),
  ) {}

  async discoverReusableAction(
    request: ReusableActionDiscoveryRequest,
    related: ReusableActionDiscoveryRequest[] = [],
  ): Promise<ReusableActionDiscoveryResult & { actions?: SiteActionDefinition[] }> {
    await loadProjectEnv(this.projectRoot);
    const existingActions = await openFileRepository({
      dataRoot: this.storeRoot,
      libraryRoot: this.projectRoot,
    }).siteActions.list(request.siteId);
    const startedAt = performance.now();
    const startedWallAt = Date.now();
    const runDirectory = resolve(this.runRoot, randomUUID());
    await mkdir(runDirectory, { recursive: true });
    const template = DISCOVERY_PROFILE;
    const plugin = dshResourcePath("action-discovery-tools.js");
    const profile = template
      .replace("__DSH_DISCOVERY_PLUGIN__", JSON.stringify(plugin))
      .replace(/model: openai\/gpt-5\.6-luna:nitro/g, `model: ${this.model}`)
      .replace("        reasoning: high", `        reasoning: ${this.reasoning}`)
      .replace(
        /      You discover a browser automation[\s\S]*?      After finishDiscovery returns discovered, STOP\./,
        PERSONA +
          (related.length
            ? "\n      Discover all requested capabilities in order in this single session. Each action-saved result automatically includes nextAction; continue from its intent and overview. Do not stop at action-saved. Return the exact discovered-actions result only after all capabilities are saved. Each action must contain only its own reusable steps."
            : ""),
      );
    const profilePath = join(runDirectory, "profile.cordis.yml");
    await writeFile(profilePath, profile, "utf8");
    const prompt = `Discover one reusable site action for this missing capability. The model must write the run_code automation. Existing site actions must remain separate and be called by the generated automation; never copy their steps into this action.\n${JSON.stringify({ request, related, existingActions: existingActions.map(({ implementation: _implementation, ...summary }) => summary) })}`;
    const dsh = resolveDshCommand();
    const child = await runDshChild(
      dsh.executable,
      [...dsh.prefixArgs, "--profile", "headless", "--patch", profilePath, prompt],
      {
        ...process.env,
        MOSAIK_ACTION_DISCOVERY_INPUT: JSON.stringify({
          related: related.map((next) => ({
            siteId: next.siteId,
            startUrl: next.startUrl,
            task: `${next.task}\nMissing reusable capability: ${next.capabilityIntent}`,
            inputs: next.inputs,
            prerequisiteActions: next.prerequisiteActions ?? [],
            expectedActionName: next.capabilityName,
            allowRepresentativeItem: next.allowRepresentativeItem,
            allowedSafety: next.safety.allowedActionSafety.filter(
              (safety) => safety !== "external-side-effect" || next.safety.allowExternalSideEffects,
            ),
          })),
          storeRoot: this.storeRoot,
          libraryRoot: this.projectRoot,
          projectRoot: this.projectRoot,
          siteId: request.siteId,
          startUrl: request.startUrl,
          task: `${request.task}\nMissing reusable capability: ${request.capabilityIntent}`,
          allowedSafety: request.safety.allowedActionSafety.filter(
            (safety) =>
              safety !== "external-side-effect" || request.safety.allowExternalSideEffects,
          ),
          inputs: request.inputs,
          prerequisiteActions: request.prerequisiteActions ?? [],
          allowRepresentativeItem: request.allowRepresentativeItem,
          ...(request.capabilityName === undefined
            ? {}
            : { expectedActionName: request.capabilityName }),
        }),
        DSH_POC_SESSION_DIR: runDirectory,
        DSH_TELEMETRY_DISABLED: "1",
        DSH_TOOLS_MODE: "code",
      },
      () => hasActionTerminal(runDirectory, request, related.length + 1),
    );
    const analyzed = analyzeAgentEvents(
      await loadDshEvents(runDirectory),
      performance.now() - startedAt,
    );
    const firstBrowserActionAt = await loadFirstBrowserActionAt(runDirectory);
    if (firstBrowserActionAt !== undefined) {
      analyzed.metrics.firstBrowserActionMs = Math.max(0, firstBrowserActionAt - startedWallAt);
      analyzed.metrics.firstBrowserActionKind = "discovery-navigation";
    }
    const firstSemanticActionAt = await loadMarkerAt(
      runDirectory,
      "mosaik-first-semantic-action.json",
    );
    if (firstSemanticActionAt !== undefined) {
      analyzed.metrics.firstActionMs = Math.max(0, firstSemanticActionAt - startedWallAt);
      analyzed.metrics.firstActionKind = "discovery";
    }
    const budgetFailure = budgetExceeded(request, analyzed.metrics);
    if (budgetFailure !== undefined) {
      return {
        status: "failed",
        reason: budgetFailure,
        metrics: analyzed.metrics,
        trajectory: analyzed.trajectory,
      };
    }
    const candidates = [...analyzed.terminalValues, ...extractJsonObjects(child.stdout)];
    const refusal = candidates.map(asRefusal).find((value) => value !== undefined);
    if (refusal !== undefined) {
      return {
        status: "refused",
        reason: refusal,
        metrics: analyzed.metrics,
        trajectory: analyzed.trajectory,
      };
    }
    for (const candidate of candidates) {
      try {
        const terminals = batchTerminals(candidate, related.length + 1);
        const terminal = terminals[0]!;
        const repository = openFileRepository({
          dataRoot: this.storeRoot,
          libraryRoot: this.projectRoot,
        });
        const actions = await Promise.all(
          terminals.map((item) => repository.siteActions.get(item.action.id)),
        );
        if (actions.some((item) => item === undefined)) continue;
        const requests = [request, ...related];
        if (
          terminals.some(
            (item, index) =>
              requests[index]?.capabilityName &&
              item.action.name !== requests[index]!.capabilityName,
          )
        )
          continue;
        const action = await openFileRepository({
          dataRoot: this.storeRoot,
          libraryRoot: this.projectRoot,
        }).siteActions.get(terminal.action.id);
        if (action === undefined) continue;
        return {
          status: "discovered",
          action,
          actions: actions as SiteActionDefinition[],
          ...(terminal.observedPage === undefined ? {} : { observedPage: terminal.observedPage }),
          metrics: { ...analyzed.metrics, repairSucceeded: true },
          trajectory: analyzed.trajectory,
        };
      } catch {
        continue;
      }
    }
    const reason = dshFailureReason(child, candidates, `DSH exited ${child.exitCode}`);
    return { status: "failed", reason, metrics: analyzed.metrics, trajectory: analyzed.trajectory };
  }
}

async function loadFirstBrowserActionAt(runDirectory: string): Promise<number | undefined> {
  return loadMarkerAt(runDirectory, "mosaik-first-browser-action.json");
}

async function loadMarkerAt(runDirectory: string, filename: string): Promise<number | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(runDirectory, filename), "utf8"));
    if (value === null || typeof value !== "object") return undefined;
    const at = (value as Record<string, unknown>).at;
    return typeof at === "number" ? at : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function hasActionTerminal(
  runDirectory: string,
  request: ReusableActionDiscoveryRequest,
  count = 1,
): Promise<boolean> {
  const analyzed = analyzeAgentEvents(await loadDshEvents(runDirectory), 0);
  if (budgetExceeded(request, analyzed.metrics) !== undefined) return true;
  const values = analyzed.terminalValues;
  for (const value of values) {
    if (asRefusal(value) !== undefined) return true;
    try {
      batchTerminals(value, count);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

function budgetExceeded(
  request: ReusableActionDiscoveryRequest,
  metrics: ReturnType<typeof analyzeAgentEvents>["metrics"],
): string | undefined {
  if (metrics.modelRequests > request.budgets.maxModelRequests)
    return "Model request budget exceeded";
  if (metrics.codeExecutions > request.budgets.maxRunCodeExecutions) {
    return "run_code execution budget exceeded";
  }
  if (metrics.nestedToolCalls > request.budgets.maxNestedToolCalls) {
    return "Nested tool-call budget exceeded";
  }
  return undefined;
}

function asRefusal(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = "result" in value ? (value as { result: unknown }).result : value;
  if (record === null || typeof record !== "object") return undefined;
  const body = record as Record<string, unknown>;
  return body.status === "refused" && typeof body.reason === "string" ? body.reason : undefined;
}

function batchTerminals(value: unknown, count: number) {
  if (count === 1) return [parseTerminalActionDiscovery(value)];
  const raw = value && typeof value === "object" && "result" in value ? value.result : value;
  if (
    !raw ||
    typeof raw !== "object" ||
    !("status" in raw) ||
    raw.status !== "discovered-actions" ||
    !("actions" in raw) ||
    !Array.isArray(raw.actions) ||
    raw.actions.length !== count
  )
    throw new Error("Discovery batch is incomplete");
  return raw.actions.map(parseTerminalActionDiscovery);
}
