import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  external: ["@naculus/connect-core", "@naculus/connect-types"],
  onSuccess: () => {
    console.log("@naculus/wallet-engine built successfully");
  },
});
