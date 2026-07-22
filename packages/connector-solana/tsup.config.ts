import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  minify: true,
  external: ["react", "@naculus/connect-core", "@solana/web3.js", "tweetnacl"],
  onSuccess: () => {
    console.log("Solana connector built successfully");
  },
});
