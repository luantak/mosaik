import { randomUUID } from "node:crypto";
import type { JSHandle, Page } from "playwright";

const INSTALL_REVISION = `(id) => {
  let revision = 0;
  const changed = () => { revision++; };
  const observer = new MutationObserver(changed);
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  document.addEventListener("load", changed, true);
  document.addEventListener("input", changed, true);
  window.addEventListener("resize", changed);
  return {
    read() {
      // Document observers cannot see shadow-root mutations, and animations can
      // alter visibility without a DOM mutation. Re-capture in either case.
      if (Array.from(document.querySelectorAll("*")).some((node) => node.shadowRoot) ||
          document.getAnimations().some((animation) => animation.playState === "running")) return null;
      if (observer.takeRecords().length) revision++;
      return id + ":" + revision;
    },
    close() {
      observer.disconnect();
      document.removeEventListener("load", changed, true);
      document.removeEventListener("input", changed, true);
      window.removeEventListener("resize", changed);
    },
  };
}`;

/** A document-local revision prevents reuse across replacements or navigations. */
export class DomRevision {
  private page: Page | undefined;
  private handle: JSHandle<{ read(): string | null; close(): void }> | undefined;

  async read(page: Page): Promise<string | null> {
    if (this.page === page && this.handle) {
      try {
        return await this.handle.evaluate((state) => state.read());
      } catch {
        await this.close();
      }
    } else {
      await this.close();
    }
    this.page = page;
    this.handle = await page.evaluateHandle(
      `(${INSTALL_REVISION})(${JSON.stringify(randomUUID())})`,
    );
    return this.handle.evaluate((state) => state.read());
  }

  async close() {
    if (this.handle) {
      await this.handle.evaluate((state) => state.close()).catch(() => {});
      await this.handle.dispose().catch(() => {});
    }
    this.handle = undefined;
    this.page = undefined;
  }
}
