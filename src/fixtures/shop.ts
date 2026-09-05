import {
  automation,
  click,
  css,
  fill,
  form,
  label,
  navigate,
  role,
  select,
} from "../core/index.js";

export function shopCheckout(url: string) {
  return automation("checkout", () => [
    navigate({ id: "open", url, safety: "browser-local" }),
    fill({
      id: "email",
      locator: label("Email"),
      value: "user@example.com",
      safety: "browser-local",
    }),
    select({ id: "country", locator: label("Country"), value: "DE", safety: "browser-local" }),
    click({
      id: "continue",
      locator: role("button", { name: "Continue" }),
      safety: "browser-local",
    }),
  ]);
}

export function shopCheckoutCss(url: string) {
  return automation("checkout-css", () => [
    navigate({ id: "open", url, safety: "browser-local" }),
    click({
      id: "continue",
      locator: css("#continue-btn"),
      safety: "browser-local",
    }),
  ]);
}

export function shopUnavailable(url: string) {
  return automation("unavailable", () => [navigate({ id: "open", url, safety: "browser-local" })]);
}

export function shopCheckoutScoped(url: string) {
  return automation("checkout-scoped", () => [
    navigate({ id: "open", url, safety: "browser-local" }),
    fill({
      id: "email",
      locator: label("Email", { within: form("Checkout") }),
      value: "user@example.com",
      safety: "browser-local",
    }),
    select({ id: "country", locator: label("Country"), value: "DE", safety: "browser-local" }),
    click({
      id: "continue",
      locator: role("button", { name: "Continue" }),
      safety: "browser-local",
    }),
  ]);
}

export function shopEmailThenNext(pageUrl: string, nextUrl: string) {
  return automation("email-then-next", () => [
    navigate({ id: "open", url: pageUrl, safety: "browser-local" }),
    fill({
      id: "email",
      locator: label("Email", { within: form("Checkout") }),
      value: "user@example.com",
      safety: "browser-local",
    }),
    navigate({ id: "next", url: nextUrl, safety: "browser-local" }),
  ]);
}

export function shopBillingEmail(url: string) {
  return automation("billing", () => [
    navigate({ id: "open", url, safety: "browser-local" }),
    fill({
      id: "email",
      locator: label("Email"),
      value: "user@example.com",
      safety: "browser-local",
    }),
  ]);
}

export function shopPlaceOrder(url: string) {
  return automation("place-order", () => [
    navigate({ id: "open", url, safety: "browser-local" }),
    click({
      id: "place-order",
      locator: role("button", { name: "Place order" }),
      safety: "external-side-effect",
    }),
  ]);
}

export function shopEmailThenPlaceOrder(url: string) {
  return automation("email-then-order", () => [
    navigate({ id: "open", url, safety: "browser-local" }),
    fill({
      id: "email",
      locator: label("Email", { within: form("Checkout") }),
      value: "user@example.com",
      safety: "browser-local",
    }),
    click({
      id: "place-order",
      locator: role("button", { name: "Place order" }),
      safety: "external-side-effect",
    }),
  ]);
}
