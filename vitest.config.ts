import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      starknet: path.resolve(__dirname, "test-utils/module-stub.js"),
      "@cosmjs/amino": path.resolve(__dirname, "test-utils/module-stub.js"),
      "@polkadot/api": path.resolve(__dirname, "test-utils/module-stub.js"),
      "@polkadot/keyring": path.resolve(__dirname, "test-utils/module-stub.js"),
      wagmi: path.resolve(__dirname, "test-utils/wagmi-stub.js"),
      viem: path.resolve(__dirname, "test-utils/viem-stub.js"),

      "@naculus/connect-core": path.resolve(__dirname, "packages/core/src"),
      "@naculus/connector-walletconnect": path.resolve(
        __dirname,
        "packages/connector-walletconnect/src",
      ),
      "@naculus/connector-embedded": path.resolve(
        __dirname,
        "packages/connector-embedded/src",
      ),
      "@naculus/connector-evm-injected": path.resolve(
        __dirname,
        "packages/connector-evm-injected/src",
      ),
      "@naculus/connector-solana": path.resolve(
        __dirname,
        "packages/connector-solana/src",
      ),
      "@naculus/connector-xrpl": path.resolve(
        __dirname,
        "packages/connector-xrpl/src",
      ),
      "@naculus/connector-passkeys": path.resolve(
        __dirname,
        "packages/connector-passkeys/src",
      ),
      "@naculus/connector-safe": path.resolve(
        __dirname,
        "packages/connector-safe/src",
      ),
      "@naculus/connector-wagmi": path.resolve(
        __dirname,
        "packages/connector-wagmi/src",
      ),
      "@naculus/connector-reown": path.resolve(
        __dirname,
        "packages/connector-reown/src",
      ),
      "@naculus/siwx": path.resolve(__dirname, "packages/siwx/src"),
      "@naculus/wallet-engine": path.resolve(
        __dirname,
        "packages/wallet-engine/src",
      ),

      "@naculus/test-utils": path.resolve(__dirname, "test-utils"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["packages/**/*.test.ts", "packages/**/*.test.tsx"],
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/out/**",
      "**/coverage/**",
    ],
    testTimeout: 120_000,
    env: { PBKDF2_ITER: "100" }, // ponytail: test speed over real iterations; 600k used in production
    coverage: {
      provider: "v8",
      thresholds: {
        statements: 38,
        branches: 32,
        functions: 40,
        lines: 39,
      },
      reporter: ["text", "json", "html"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "**/node_modules/**",
        "**/dist/**",
        "**/test-utils/**",
        "**/*.stories.*",
      ],
    },
  },
});
