import type { Mosaik } from "../mosaik.js";

export interface AutomationOutputFile {
  path: string;
  relativePath: string;
  bytes: number;
}

export interface AutomationDownloadedFile extends AutomationOutputFile {
  sourceUrl: string;
  contentType: string;
}

export interface AutomationDownloadRequest {
  url: string;
  path: string;
  reuseOnly?: boolean;
  onConflict?: "rename" | "error";
}

export interface AutomationContext<
  TInput extends Record<string, unknown> = Record<string, unknown>,
> {
  input: TInput;
  output?: unknown;
  log: (message: unknown) => void;
  actions: Record<string, (args?: Record<string, unknown>) => Promise<unknown>>;
  files: {
    write: (path: string, data: unknown) => Promise<AutomationOutputFile>;
    /** Transfers may overlap sequential browser actions; the runtime runs at most four.
     * Await their results before writing a manifest. Outstanding transfers drain before return. */
    download: (request: AutomationDownloadRequest) => Promise<AutomationDownloadedFile>;
  };
}

export type AutomationHandler<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
> = (ctx: AutomationContext<TInput>, input: TInput) => Promise<TOutput> | TOutput;

export interface ImportedAutomation<TInput extends Record<string, unknown>, TOutput> {
  (mosaik: Mosaik, input: TInput): Promise<Awaited<TOutput>>;
  (ctx: AutomationContext, input: TInput): Promise<Awaited<TOutput>>;
}

export function defineAutomation<TInput extends Record<string, unknown>, TOutput>(
  moduleUrl: string,
  handler: AutomationHandler<TInput, TOutput>,
): ImportedAutomation<TInput, TOutput>;
export function defineAutomation<
  TInput extends Record<string, unknown> = Record<string, unknown>,
  TOutput = unknown,
>(handler: AutomationHandler<TInput, TOutput>): AutomationHandler<TInput, TOutput>;
export function defineAutomation(
  locationOrHandler: string | AutomationHandler<any, any>,
  _handler?: AutomationHandler<any, any>,
): any {
  if (typeof locationOrHandler !== "string") return locationOrHandler;
  return (mosaik: Mosaik, input: Record<string, unknown>) => {
    if (!mosaik || typeof mosaik.execute !== "function") {
      throw new Error("Call an imported automation with a Mosaik instance");
    }
    return mosaik.execute(locationOrHandler, input);
  };
}
