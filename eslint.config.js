import js from "@eslint/js";
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import importX from "eslint-plugin-import-x";

const sharedRules = {
  // Correctness
  "no-unused-vars": ["error", { argsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
  "eqeqeq": ["error", "always", { null: "ignore" }],
  "no-throw-literal": "error",
  "no-promise-executor-return": "error",
  "prefer-promise-reject-errors": "error",
  "no-unused-expressions": "error",

  // Modern JS — enforce what the codebase already does
  "no-var": "error",
  "prefer-const": "error",
  "prefer-template": "error",
  "object-shorthand": "error",
  "prefer-spread": "error",
  "prefer-rest-params": "error",
  "no-implicit-coercion": "error",

  // Clarity & safety
  "curly": ["error", "all"],
  "no-else-return": "error",
  "no-lonely-if": "error",
  "no-useless-return": "error",
  "no-param-reassign": ["error", { props: false }],

  "no-console": "off",
};

// DOM globals that must not appear in pure computation modules
const DOM_GLOBALS = [
  "document",
  "window",
  "HTMLElement",
  "navigator",
  "location",
  "localStorage",
  "sessionStorage",
  "alert",
  "confirm",
  "prompt",
];

export default [
  js.configs.recommended,
  {
    files: ["scripts/**/*.ts"],
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...sharedRules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    files: ["test/**/*.ts", "test-utils/**/*.ts"],
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: { ...globals.node },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "object-shorthand": "error",
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: {
      "@typescript-eslint": tsPlugin,
      "import-x": importX,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: { ...globals.browser },
    },
    settings: {
      "import-x/resolver": {
        typescript: true,
        node: true,
      },
      "import-x/parsers": {
        "@typescript-eslint/parser": [".ts"],
      },
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // Disable base rule in favour of TypeScript-aware version
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" }],
      // Warn on any — legacy code may still use it during migration
      "@typescript-eslint/no-explicit-any": "warn",
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-throw-literal": "error",
      "no-promise-executor-return": "error",
      "prefer-promise-reject-errors": "error",
      "no-unused-expressions": "error",
      "no-var": "error",
      "prefer-const": "error",
      "prefer-template": "error",
      "object-shorthand": "error",
      "prefer-spread": "error",
      "prefer-rest-params": "error",
      "no-implicit-coercion": "error",
      "curly": ["error", "all"],
      "no-else-return": "error",
      "no-lonely-if": "error",
      "no-useless-return": "error",
      "no-param-reassign": ["error", { props: false }],
      "no-console": "off",
      // No circular dependencies
      "import-x/no-cycle": "error",
      // Import ordering: external → internal absolute → relative (warn — existing code has violations)
      "import-x/order": [
        "warn",
        {
          "groups": ["builtin", "external", "internal", "parent", "sibling", "index"],
          "newlines-between": "never",
        },
      ],
    },
  },
  // Pure computation modules must not access DOM globals
  {
    files: [
      "src/geometry/**/*.ts",
      "src/model/**/*.ts",
      "src/text/**/*.ts",
      "src/export/**/*.ts",
    ],
    rules: {
      // Warn on DOM globals in pure modules — error in new code, warn during migration
      "no-restricted-globals": [
        "warn",
        ...DOM_GLOBALS.map((name) => ({
          name,
          message: `Pure modules must not access DOM globals. Move DOM access to src/main.ts, src/preview/, or src/elevation/.`,
        })),
      ],
    },
  },
  {
    ignores: ["node_modules/**", "dist/**", "public/**", "src/**/*.js"],
  },
];
