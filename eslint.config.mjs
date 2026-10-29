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
    "src/home/magic-ui/provenance/**",
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
      "@typescript-eslint/no-deprecated": "error",
      "@typescript-eslint/no-explicit-any": ["error",{"fixToUnknown":true}],
      "@typescript-eslint/no-unused-vars": ["error",{"args":"none","ignoreRestSiblings":true}],
      "obsidianmd/no-global-this": "error",
      "obsidianmd/no-tfile-tfolder-cast": "error",
      "obsidianmd/prefer-create-el": "error",
      "@typescript-eslint/no-this-alias": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-base-to-string": "error",
      "@typescript-eslint/no-unnecessary-type-assertion": "error",
      "@typescript-eslint/no-redundant-type-constituents": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "no-useless-escape": "error",
      "import/no-extraneous-dependencies": "error",
      "obsidianmd/commands/no-plugin-name-in-command-name": "error",
      "obsidianmd/prefer-file-manager-trash-file": "error",
      "obsidianmd/prefer-window-timers": "error",
      "obsidianmd/prefer-instanceof": "error",
      "obsidianmd/object-assign": "error",
      "obsidianmd/no-nodejs-modules": "error",
      "eslint-comments/no-restricted-disable": [
        "error",
        "obsidianmd/*",
        "@typescript-eslint/no-deprecated",
        "@typescript-eslint/no-explicit-any",
        "@typescript-eslint/no-unused-vars",
        "@typescript-eslint/no-this-alias",
        "@typescript-eslint/no-unsafe-assignment",
        "@typescript-eslint/no-unsafe-member-access",
        "@typescript-eslint/no-unsafe-argument",
        "@typescript-eslint/no-unsafe-return",
        "@typescript-eslint/no-base-to-string",
        "import/no-extraneous-dependencies",
        "@typescript-eslint/no-unnecessary-type-assertion",
        "@typescript-eslint/no-redundant-type-constituents",
        "@typescript-eslint/no-misused-promises",
        "@typescript-eslint/no-unsafe-call",
        "no-useless-escape",
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
