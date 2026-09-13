import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  // Keep optional chain verifiers in lazy chunks. Inlining them into the main
  // entry makes browser bundlers resolve every optional peer even when a
  // consumer only imports the chain-agnostic SIWx helpers.
  splitting: true,
  sourcemap: true,
  clean: true,
  minify: true,
  // Must match what the chain verifiers actually import. @polkadot/keyring was
  // missing here while @polkadot/api — never imported — was listed; the build
  // only stayed correct because the package is not installed, so esbuild left
  // the bare specifier alone. Installing it transitively would have vendored it
  // into the artifact.
  external: ["@cosmjs/amino", "starknet", "@polkadot/util-crypto"],
});
