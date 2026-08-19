// FineSign ESLint (flat config). Enforces the code-style rules in FACTORY §6 —
// notably no floating promises and no `any` on our own source — with type-aware
// linting via typescript-eslint's project service on `src` (tests get syntactic
// linting only, since they are excluded from the build tsconfigs).
import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // packages/web is a JS/JSX Vite app with its OWN eslint config + gate step.
    ignores: ["**/dist/**", "**/node_modules/**", "packages/core/examples/**", "packages/web/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Allow `let { a, b } = ...` when at least one member is reassigned.
    rules: { "prefer-const": ["error", { destructuring: "all" }] },
  },
  {
    // Type-aware linting for shipped source.
    files: ["packages/*/src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-console": "error",
    },
  },
  {
    // The logger implementation is the ONE allowed console sink.
    files: ["packages/shared/src/logger.ts"],
    rules: { "no-console": "off" },
  },
  {
    // Tests: syntactic linting only (excluded from build tsconfigs, so no type
    // info); relax the source-only strictness.
    files: ["packages/*/test/**/*.ts"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  }
);
