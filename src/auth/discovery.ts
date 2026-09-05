import type { Page } from "playwright";
import type { AuthChallenge, AuthField } from "./types.js";

export const AUTH_FIELD_ATTRIBUTE = "data-mosaik-auth-field";
export const AUTH_SUBMIT_ATTRIBUTE = "data-mosaik-auth-submit";

interface MarkedAuthChallenge extends AuthChallenge {
  hasSubmit: boolean;
}

const DISCOVER_AUTH_FORM = `(() => {
  const fieldAttribute = "${AUTH_FIELD_ATTRIBUTE}";
  const submitAttribute = "${AUTH_SUBMIT_ATTRIBUTE}";
  for (const node of document.querySelectorAll("[" + fieldAttribute + "]")) node.removeAttribute(fieldAttribute);
  for (const node of document.querySelectorAll("[" + submitAttribute + "]")) node.removeAttribute(submitAttribute);

  const normalized = (value) => (value || "").trim().replace(/\\s+/g, " ");
  const visible = (element) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.visibility !== "hidden"
      && style.display !== "none"
      && Number(style.opacity || "1") > 0
      && bounds.width > 0
      && bounds.height > 0
      && !element.hasAttribute("hidden");
  };
  const fieldKind = (input) => {
    const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
    const autocompleteTokens = autocomplete.split(/\\s+/);
    const type = (input.getAttribute("type") || "text").toLowerCase();
    if (type === "password" || autocompleteTokens.includes("current-password") || autocompleteTokens.includes("new-password")) return "password";
    if (autocompleteTokens.includes("one-time-code")) return "one-time-code";
    if (autocompleteTokens.includes("username") || autocompleteTokens.includes("email") || type === "email") return "username";
    return "text";
  };
  const labelFor = (input) => {
    const direct = input.labels && input.labels[0] && normalized(input.labels[0].innerText);
    if (direct) return direct;
    const aria = normalized(input.getAttribute("aria-label"));
    if (aria) return aria;
    const labelledBy = input.getAttribute("aria-labelledby");
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => {
        const node = document.getElementById(id);
        return node && normalized(node.textContent);
      }).filter(Boolean).join(" ");
      if (text) return text;
    }
    const placeholder = normalized(input.getAttribute("placeholder"));
    if (placeholder) return placeholder;
    const name = normalized(input.getAttribute("name") || input.id);
    if (name) return name.replace(/[-_]+/g, " ").replace(/\\b\\w/g, (letter) => letter.toUpperCase());
    return fieldKind(input) === "password" ? "Password" : "Login value";
  };
  const editableInputs = (root) => [...root.querySelectorAll("input")].filter((input) => {
    const type = (input.getAttribute("type") || "text").toLowerCase();
    return ["text", "email", "tel", "number", "password"].includes(type)
      && !input.disabled
      && !input.readOnly
      && visible(input);
  });
  const submitControls = (root) => [...root.querySelectorAll("button, input[type='submit']")]
    .filter((control) => !control.disabled && visible(control));
  const submitText = (control) => normalized(
    control.getAttribute("aria-label") || control.innerText || control.getAttribute("value")
  );
  const roots = [...document.querySelectorAll("form, [role='form']")];
  roots.push(document.body);
  const candidates = roots.map((root) => {
    const inputs = editableInputs(root);
    const submits = submitControls(root);
    const context = normalized([
      root.getAttribute("aria-label"),
      root.getAttribute("name"),
      root.getAttribute("action"),
      root.id,
      root.className,
      root.querySelector("h1, h2, h3, legend")?.textContent,
    ].filter(Boolean).join(" ")).toLowerCase();
    const submit = submits.find((control) => /sign[ -]?in|log[ -]?in|continue|next|verify/i.test(submitText(control))) || submits[0];
    let score = root === document.body ? -20 : 10;
    for (const input of inputs) {
      const kind = fieldKind(input);
      const autocomplete = (input.getAttribute("autocomplete") || "").toLowerCase();
      const autocompleteTokens = autocomplete.split(/\\s+/);
      if (kind === "password") score += 120;
      else if (kind === "one-time-code") score += 110;
      else if (autocompleteTokens.includes("username") || autocompleteTokens.includes("email")) score += 80;
      else if ((input.getAttribute("type") || "").toLowerCase() === "email") score += 15;
    }
    if (/sign[ -]?in|log[ -]?in|auth|account|password|verification/.test(context)) score += 40;
    if (submit && /sign[ -]?in|log[ -]?in|continue|next|verify/i.test(submitText(submit))) score += 35;
    return { root, inputs, submit, score };
  }).filter((candidate) => candidate.inputs.length > 0);
  candidates.sort((left, right) => right.score - left.score || left.inputs.length - right.inputs.length);
  const scoped = candidates.find((candidate) => candidate.root !== document.body && candidate.score >= 70);
  const selected = scoped || candidates.find((candidate) => candidate.root === document.body);
  if (!selected || selected.score < 70) return undefined;

  const fields = selected.inputs.map((input, index) => {
    const id = "auth-field-" + index;
    const kind = fieldKind(input);
    input.setAttribute(fieldAttribute, id);
    const autocomplete = normalized(input.getAttribute("autocomplete"));
    return {
      id,
      label: labelFor(input),
      kind,
      required: input.required,
      secret: kind === "password" || kind === "one-time-code",
      ...(autocomplete ? { autocomplete } : {}),
    };
  });
  if (selected.submit) selected.submit.setAttribute(submitAttribute, "true");
  return {
    fields,
    submitLabel: selected.submit ? submitText(selected.submit) : undefined,
    hasSubmit: Boolean(selected.submit),
  };
})()`;

export async function discoverAuthChallenge(page: Page, step = 1): Promise<AuthChallenge | null> {
  const challenge = await discoverMarkedAuthChallenge(page, step);
  if (challenge === null) return null;
  const { hasSubmit: _, ...safe } = challenge;
  return safe;
}

export async function discoverMarkedAuthChallenge(
  page: Page,
  step: number,
): Promise<MarkedAuthChallenge | null> {
  const discovered = (await page.evaluate(DISCOVER_AUTH_FORM)) as
    | {
        fields: AuthField[];
        submitLabel?: string;
        hasSubmit: boolean;
      }
    | undefined;
  if (discovered === undefined) return null;
  return {
    url: page.url(),
    title: await page.title(),
    step,
    fields: discovered.fields,
    ...(discovered.submitLabel === undefined ? {} : { submitLabel: discovered.submitLabel }),
    hasSubmit: discovered.hasSubmit,
  };
}
