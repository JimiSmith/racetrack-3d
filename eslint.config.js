import js from "@eslint/js";
import globals from "globals";

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

export default [
  js.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.browser },
    },
    rules: sharedRules,
  },
  {
    files: ["scripts/**/*.{js,mjs}", "scripts/lib/**/*.{js,mjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: sharedRules,
  },
  {
    files: ["test/**/*.js", "test-utils/**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "eqeqeq": ["error", "always", { null: "ignore" }],
      "no-var": "error",
      "prefer-const": "error",
      "object-shorthand": "error",
    },
  },
  {
    ignores: ["node_modules/**", "dist/**", "public/**"],
  },
];
