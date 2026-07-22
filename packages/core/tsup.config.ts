import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  external: [],
  noExternal: [/@noble/],
  onSuccess: () => {
    console.log("Core package built successfully");
  },
});
