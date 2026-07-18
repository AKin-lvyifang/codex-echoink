import json from "@eslint/json";
import js from "@eslint/js";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";
import { defineConfig, globalIgnores } from "eslint/config";

const disabledJavaScriptRules = Object.fromEntries(
  Object.keys(js.configs.recommended.rules).map((rule) => [rule, "off"]),
);

export default defineConfig(
  globalIgnores([
    "node_modules",
    "dist",
    "release-assets",
    ".tmp",
    "prototypes",
    "scripts",
    "src/tests",
    "esbuild.config.mjs",
    "package-lock.json",
    "tsconfig.json",
  ]),
  ...obsidianmd.configs.recommended,
  {
    files: ["**/*.{ts,cts,mts,tsx,js,cjs,mjs,jsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "eslint-comments/no-restricted-disable": [
        "error",
        "obsidianmd/*",
        "no-eval",
        "no-implied-eval",
        "@typescript-eslint/no-implied-eval",
        "@typescript-eslint/no-floating-promises",
        "no-unsanitized/method",
        "no-unsanitized/property",
      ],
    },
  },
  {
    files: ["manifest.json"],
    language: "json/json",
    plugins: {
      json,
    },
    rules: {
      ...disabledJavaScriptRules,
      ...json.configs.recommended.rules,
      "obsidianmd/validate-manifest": "error",
    },
  },
  {
    files: ["versions.json"],
    language: "json/json",
    plugins: {
      json,
    },
    rules: {
      ...disabledJavaScriptRules,
      ...json.configs.recommended.rules,
    },
  },
);
