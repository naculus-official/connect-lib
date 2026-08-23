import { defineConfig } from "tsup";

/**
 * Second build pass, for the Web Worker asset only.
 *
 * isolated-signer.ts loads it with `new URL("./crypto-worker.js",
 * import.meta.url)`, which resolves relative to dist/index.js — so the file has
 * to land at dist/crypto-worker.js, not dist/signers/. A named entry forces
 * that; an array entry preserves the source directory and would miss.
 *
 * `noExternal` is the load-bearing part. @noble/* are real dependencies, so the
 * main build externalises them and leaves bare specifiers behind. A module
 * worker created from a URL has no bundler and no import map, so a bare
 * specifier is unresolvable and the worker fails to load — the same broken
 * feature as a missing file, reached by a different route. It is scoped to this
 * config deliberately: applying it to the main entry would inline a second copy
 * of @noble alongside the one connect-core already bundles.
 *
 * `platform: "browser"` is not cosmetic either. tsup defaults to "node", which
 * makes esbuild pick the Node condition of @noble/hashes' `crypto` export and
 * emit `import ... from "crypto"` — a builtin no browser worker can resolve.
 * A Web Worker is a browser environment, so the browser condition is the
 * correct one here.
 *
 * `clean: false` matters too. This runs after the main build, and cleaning here
 * would delete dist/index.js.
 */
export default defineConfig({
  entry: { "crypto-worker": "src/signers/crypto-worker.ts" },
  format: ["esm"],
  platform: "browser",
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: false,
  minify: true,
  noExternal: [/^@noble\//],
  onSuccess: () => {
    console.log("@naculus/wallet-engine crypto worker built successfully");
  },
});
