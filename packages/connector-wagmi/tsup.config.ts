import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  external: ["viem", "wagmi"],
  onSuccess: () => {
    console.log("Wagmi connector package built successfully");
  },
});
