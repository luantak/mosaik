import type { FixtureRoute } from "../runtime/fixtures.js";

const PRODUCTS = [
  { href: "/mug", title: "Ceramic mug", price: "€18.00" },
  { href: "/travel-mug", title: "Travel mug", price: "€12.00" },
  { href: "/studio-mug", title: "Studio mug", price: "€22.00" },
  { href: "/bowl", title: "Mixing bowl", price: "€24.00" },
];

export function compositionShopRoutes(): Record<string, FixtureRoute> {
  return {
    "/": { html: catalogHtml() },
    ...Object.fromEntries(
      PRODUCTS.map((product) => [
        product.href,
        { html: productHtml(product.title, product.price) },
      ]),
    ),
  };
}

function catalogHtml(): string {
  const rows = PRODUCTS.map(
    (product) => `<li data-product-row>
  <a href="${product.href}" data-testid="product">
    <span data-testid="title">${product.title}</span>
    <span data-testid="price">${product.price}</span>
  </a>
</li>`,
  ).join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Catalog</title></head>
<body><main><form aria-label="Catalog search"><label>Search <input name="q"></label>
<button type="submit">Search</button></form><ul>${rows}</ul></main>
<script>document.querySelector("form").addEventListener("submit", event => {
event.preventDefault(); const query = String(new FormData(event.target).get("q") || "").toLowerCase();
for (const row of document.querySelectorAll("[data-product-row]")) {
if (query && !row.querySelector("[data-testid=title]").textContent.toLowerCase().includes(query)) row.remove();
}});</script></body></html>`;
}

function productHtml(title: string, price: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><main aria-label="Product"><h1>${title}</h1><p data-testid="price">${price}</p>
<button type="button" id="add">Add to cart</button></main><script>
document.getElementById("add").addEventListener("click", () => {
const key = "mosaik-cart"; const items = JSON.parse(localStorage.getItem(key) || "[]");
items.push({ href: location.pathname, title: document.querySelector("h1").textContent });
localStorage.setItem(key, JSON.stringify(items)); document.getElementById("add").textContent = "In cart";
});</script></body></html>`;
}
