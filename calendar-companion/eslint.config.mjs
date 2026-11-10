import { fileURLToPath } from "node:url";
import globals from "globals";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import obsidianmd from "eslint-plugin-obsidianmd";

export default [
  {
    ignores: [
      "main.js",
      "mcp-server.js",
      "node_modules/**"
    ]
  },
  ...obsidianmd.configs.recommended,
  // The shipped child manifest follows the same official checks as the root payload.
  ...obsidianmd.configs.recommended.filter(config => config.files?.includes("manifest.json")).map(config => ({ ...config, files: ["calendar-companion/manifest.json"] })),
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: fileURLToPath(new URL("./tsconfig.json", import.meta.url)),
        tsconfigRootDir: import.meta.dirname,
        ecmaVersion: "latest",
        sourceType: "module"
      },
      globals: {
        ...globals.browser,
        ...globals.node,
        __YOOFLOE_PLUGIN_VERSION__: "readonly"
      }
    },
    plugins: {
      "@typescript-eslint": tseslint
    },
    rules: {
      "obsidianmd/ui/sentence-case": ["error", {
        enforceCamelCaseLower: true,
        brands: ["Yoofloe Calendar Companion", "Yoofloe Calendar Inbox", "Android", "MiB", "OpenAI", "ChatGPT", "Calendar", "GPT", "Luna", "Terra", "Sol", "Astra", "Flash", "Flash-Lite", "Argon", "Yoofloe", "Obsidian", "Gemini", "Google", "Vertex", "BYOK", "MCP", "Markdown", "Claude Code", "Supabase"],
        acronyms: ["AI", "PAT", "ID", "URL", "JSON", "API", "YYYY-MM-DD"]
      }],
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: true } }],
      "@typescript-eslint/require-await": "error"
    }
  },
  {
    files: ["src/mcp/**/*.ts"],
    rules: {
      "import/no-nodejs-modules": "off"
    }
  }
];
