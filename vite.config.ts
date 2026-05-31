import gasPlugin from "gas-vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    gasPlugin({
      manifest: "static/appsscript.json",
      include: ["static/*.html"],
    }),
  ],
  build: {
    lib: {
      entry: "src/main.ts",
      formats: ["es"],
      fileName: () => "Code.js",
    },
    minify: false,
    outDir: "dist",
  },
});
