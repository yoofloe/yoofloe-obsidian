import globals from "globals";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

const sentenceCaseBrands = [
  ...DEFAULT_BRANDS,
  "Claude Code",
  "Google Account",
  "Google Cloud",
  "OAuth",
  "gemini-2.5-flash-lite",
  "my-google-cloud-project",
  "us-central1"
];

export default [
  {
    ignores: [
      "main.js",
      "mcp-server.js",
      "node_modules/**"
    ]
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: "latest",
        sourceType: "module"
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    plugins: {
      "@typescript-eslint": tseslint
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["error", {
        brands: sentenceCaseBrands,
        enforceCamelCaseLower: true
      }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: true } }],
      "@typescript-eslint/require-await": "error"
    }
  }
];
