import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: true,
  // Kit is the consumer's copy (peer); bundling one would split its nominal
  // types and codecs from the app's.
  external: ["@naculus/connector-solana", "@solana/kit"],
});
