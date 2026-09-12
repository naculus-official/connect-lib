import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  // @noble packages expose separate Node/browser crypto entry points. Without
  // this, tsup selects Node's `crypto` module for the ESM build and Vite turns
  // it into an empty browser shim, so CSPRNG calls fail only at runtime.
  platform: "browser",
  external: [],
  noExternal: [/@noble/],
  onSuccess: () => {
    console.log("Core package built successfully");
  },
});
