import type { BrowserContext, Page, Request, Response } from "playwright";

export const MAX_CAPTURED_RESPONSE_BYTES = 10 * 1024 * 1024;
const MAX_CAPTURED_TOTAL_BYTES = 64 * 1024 * 1024;
const RESPONSE_START_GRACE_MS = 250;
const IN_FLIGHT_RESPONSE_TIMEOUT_MS = 5_000;
const CONTEXT_REQUEST_TIMEOUT_MS = 15_000;

export interface CapturedBrowserResponse {
  url: string;
  contentType: string;
  bytes: Uint8Array;
}

type CaptureResult =
  | { response: CapturedBrowserResponse; error?: undefined }
  | { response?: undefined; error: string; retryable?: boolean };

class ResponseBodyUnavailableError extends Error {}

export class BrowserResponseCache {
  readonly #entries = new Map<string, Promise<CaptureResult>>();
  readonly #inFlight = new Set<string>();
  readonly #loads = new Map<string, Promise<CaptureResult>>();
  readonly #sizes = new Map<string, number>();
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #networkOrigin: string | undefined;
  readonly #onResponse: (response: Response) => void;
  readonly #onRequest: (request: Request) => void;
  readonly #onRequestSettled: (request: Request) => void;
  #capturedBytes = 0;
  #closed = false;

  constructor(page: Page, options: { networkOrigin?: string } = {}) {
    this.#context = page.context();
    this.#page = page;
    this.#networkOrigin = options.networkOrigin;
    this.#onRequest = (request) => {
      const url = optionalHttpUrl(request.url());
      if (url !== undefined) this.#inFlight.add(normalizedResponseUrl(url));
    };
    this.#onRequestSettled = (request) => {
      const url = optionalHttpUrl(request.url());
      if (url !== undefined) this.#inFlight.delete(normalizedResponseUrl(url));
    };
    this.#onResponse = (response) => this.#remember(response);
    this.#page.on("request", this.#onRequest);
    this.#page.on("requestfinished", this.#onRequestSettled);
    this.#page.on("requestfailed", this.#onRequestSettled);
    this.#page.on("response", this.#onResponse);
  }

  async read(
    value: string,
    options: { reuseOnly?: boolean } = {},
  ): Promise<CapturedBrowserResponse> {
    if (this.#closed) throw new Error("Browser response cache is closed");
    const url = parseDownloadUrl(value);
    const key = normalizedResponseUrl(url);
    const waitMs = this.#inFlight.has(key)
      ? IN_FLIGHT_RESPONSE_TIMEOUT_MS
      : RESPONSE_START_GRACE_MS;
    const captured = await (this.#entries.get(key) ?? this.#waitForResponseStart(key, waitMs));
    if (captured !== undefined) {
      if (captured.response !== undefined) {
        const size = this.#sizes.get(key);
        if (size !== undefined) {
          this.#sizes.delete(key);
          this.#sizes.set(key, size);
        }
        return captured.response;
      }
      if (captured.retryable !== true || options.reuseOnly === true) return unwrapCapture(captured);
    }
    if (options.reuseOnly === true) {
      throw new Error(`Response was not loaded by the browser: ${url.href}`);
    }
    const allowedOrigin = this.#allowedOrigin();
    if (allowedOrigin !== undefined && url.origin !== allowedOrigin) {
      throw new Error(
        `Browser download cache missed and cross-origin loading is blocked: ${url.origin}`,
      );
    }
    // Share the fallback and retain its bytes, so later downloads do not
    // repeatedly request a resource whose original response was discarded.
    const loading = this.#loads.get(key);
    if (loading !== undefined) return unwrapCapture(await loading);
    const pending = this.#store(
      key,
      this.#loadThroughBrowser(url).then(
        (response): CaptureResult => ({ response }),
        (error: unknown): CaptureResult => ({
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
    this.#loads.set(key, pending);
    try {
      return unwrapCapture(await pending);
    } finally {
      this.#loads.delete(key);
    }
  }

  close(): void {
    this.#closed = true;
    this.#page.off("request", this.#onRequest);
    this.#page.off("requestfinished", this.#onRequestSettled);
    this.#page.off("requestfailed", this.#onRequestSettled);
    this.#page.off("response", this.#onResponse);
    this.#entries.clear();
    this.#sizes.clear();
    this.#loads.clear();
    this.#inFlight.clear();
    this.#capturedBytes = 0;
  }

  #remember(response: Response): void {
    const url = optionalHttpUrl(response.url());
    if (!url || this.#closed) return;
    const key = normalizedResponseUrl(url);
    this.#store(
      key,
      this.#capture(response).then(
        (captured) => ({ response: captured }),
        (error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
          retryable: error instanceof ResponseBodyUnavailableError,
        }),
      ),
    );
  }

  async #capture(response: Response): Promise<CapturedBrowserResponse> {
    const status = response.status();
    if (status < 200 || status >= 300) {
      throw new Error(`Response returned HTTP ${status}: ${response.url()}`);
    }
    let body: Buffer;
    try {
      const failure = await response.finished();
      if (failure !== null) throw failure;
      body = await response.body();
    } catch (error) {
      throw new ResponseBodyUnavailableError(
        error instanceof Error ? error.message : String(error),
      );
    }
    this.#validateSize(body.byteLength, response.url());
    return {
      url: response.url(),
      contentType: responseContentType(response),
      bytes: body,
    };
  }

  async #loadThroughBrowser(url: URL): Promise<CapturedBrowserResponse> {
    const response = await this.#context.request.get(url.href, {
      failOnStatusCode: false,
      timeout: CONTEXT_REQUEST_TIMEOUT_MS,
    });
    try {
      if (!response.ok()) {
        throw new Error(`Response returned HTTP ${response.status()}: ${response.url()}`);
      }
      const finalUrl = parseDownloadUrl(response.url());
      const allowedOrigin = this.#allowedOrigin();
      if (allowedOrigin !== undefined && finalUrl.origin !== allowedOrigin) {
        throw new Error(
          `Browser download redirected outside the allowed origin: ${finalUrl.origin}`,
        );
      }
      const bytes = await response.body();
      this.#validateSize(bytes.byteLength, finalUrl.href);
      return {
        url: finalUrl.href,
        contentType:
          response.headers()["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ??
          "application/octet-stream",
        bytes,
      };
    } finally {
      await response.dispose();
    }
  }

  async #waitForResponseStart(key: string, timeoutMs: number): Promise<CaptureResult | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pending = this.#entries.get(key);
      if (pending !== undefined) return pending;
      await timeout(10);
    }
    return this.#entries.get(key);
  }

  #validateSize(bytes: number, url: string): void {
    if (bytes > MAX_CAPTURED_RESPONSE_BYTES) {
      throw new Error(`Response exceeds the 10 MB file limit: ${url}`);
    }
  }

  #remove(key: string): void {
    this.#capturedBytes -= this.#sizes.get(key) ?? 0;
    this.#sizes.delete(key);
    this.#entries.delete(key);
  }

  #store(key: string, capture: Promise<CaptureResult>): Promise<CaptureResult> {
    // Replacements release their old bytes. Late responses must not overwrite a
    // newer capture or repopulate a closed cache.
    this.#remove(key);
    const pending = capture.then((result) => {
      if (this.#closed || this.#entries.get(key) !== pending) return result;
      if (result.response) {
        const bytes = result.response.bytes.byteLength;
        while (this.#capturedBytes + bytes > MAX_CAPTURED_TOTAL_BYTES) {
          const oldest = this.#sizes.keys().next().value;
          if (oldest === undefined) break;
          this.#remove(oldest);
        }
        this.#sizes.set(key, bytes);
        this.#capturedBytes += bytes;
      }
      return result;
    });
    this.#entries.set(key, pending);
    return pending;
  }

  #allowedOrigin(): string | undefined {
    return this.#networkOrigin ?? optionalHttpUrl(this.#page.url())?.origin;
  }
}

function parseDownloadUrl(value: string): URL {
  const url = optionalHttpUrl(value);
  if (url === undefined) {
    throw new Error(`Download URL must be an absolute HTTP(S) URL: ${value}`);
  }
  return url;
}

function optionalHttpUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url;
  } catch {
    return undefined;
  }
}

function normalizedResponseUrl(url: URL): string {
  url.hash = "";
  return url.href;
}

function responseContentType(response: Response): string {
  return (
    response.headers()["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() ??
    "application/octet-stream"
  );
}

function unwrapCapture(result: CaptureResult): CapturedBrowserResponse {
  if (result.response !== undefined) return result.response;
  throw new Error(`Browser response could not be saved: ${result.error}`);
}

function timeout(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
