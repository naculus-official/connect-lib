import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  external: ["@safe-global/safe-apps-sdk"],
  onSuccess: () => {
    console.log("Safe connector package built successfully");
  },
});
