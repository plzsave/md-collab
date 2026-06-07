/**
 * Postbuild step: inline the compiled Tailwind CSS into dist/index.html.
 *
 * GAS HtmlService serves a single HTML file, so we can't ship a separate
 * stylesheet. Vite copies static/index.html (with a <!--TAILWIND_CSS-->
 * placeholder) into dist/, the Tailwind CLI emits dist/.tw.css, and this script
 * swaps the placeholder for an inline <style> block and removes the temp CSS.
 */
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const htmlPath = resolve(root, "dist/index.html");
const cssPath = resolve(root, "dist/.tw.css");
const PLACEHOLDER = "<!--TAILWIND_CSS-->";

if (!existsSync(cssPath)) {
  throw new Error(`Compiled CSS not found at ${cssPath}. Did "tailwindcss" run?`);
}

const css = readFileSync(cssPath, "utf8").trim();
let html = readFileSync(htmlPath, "utf8");

if (!html.includes(PLACEHOLDER)) {
  throw new Error(`Placeholder ${PLACEHOLDER} not found in dist/index.html`);
}

// Escape any literal `</style` so it can't terminate the inline <style> early
// (the `\/` is a no-op in CSS, so the styles are unchanged).
const safeCss = css.replace(/<\/(style)/gi, "<\\/$1");
// Use a function replacer: a string replacement would expand `$$`, `$&`, `` $` ``
// and `$'` tokens if they ever occur in the compiled CSS.
html = html.replace(PLACEHOLDER, () => `<style>\n${safeCss}\n</style>`);
writeFileSync(htmlPath, html);
unlinkSync(cssPath);

console.log(`Inlined Tailwind CSS (${(css.length / 1024).toFixed(1)} kB) into dist/index.html`);
