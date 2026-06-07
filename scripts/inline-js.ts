/**
 * Postbuild step: bundle the client script and inline it into dist/index.html.
 *
 * GAS HtmlService serves a single HTML file, so the front-end code can't ship
 * as a separate URL. We author it as src/client/main.ts, bundle it here (IIFE
 * so its top-level names stay scoped, matching the old inline <script>), and
 * swap the <!--CLIENT_JS--> placeholder for an inline <script> block. This
 * mirrors scripts/inline-css.ts, which does the same for Tailwind CSS.
 *
 * The placeholder sits at the end of <body>, so the script still runs after the
 * markup is parsed — same position as before.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const entry = resolve(root, "src/client/main.ts");
const htmlPath = resolve(root, "dist/index.html");
const PLACEHOLDER = "<!--CLIENT_JS-->";

if (!existsSync(htmlPath)) {
  throw new Error(`dist/index.html not found. Did "vite build" run?`);
}

let html = readFileSync(htmlPath, "utf8");

if (!html.includes(PLACEHOLDER)) {
  throw new Error(`Placeholder ${PLACEHOLDER} not found in dist/index.html`);
}

const result = await Bun.build({
  entrypoints: [entry],
  target: "browser",
  format: "iife",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("Failed to bundle src/client/main.ts");
}

const js = (await result.outputs[0].text()).trim();

html = html.replace(PLACEHOLDER, `<script>\n${js}\n</script>`);
writeFileSync(htmlPath, html);

console.log(`Inlined client JS (${(js.length / 1024).toFixed(1)} kB) into dist/index.html`);
