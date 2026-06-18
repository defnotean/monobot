const noopRule = {
  meta: { type: "problem", schema: [] },
  create() {
    return {};
  },
};

export default [
  {
    linterOptions: {
      reportUnusedDisableDirectives: "off",
    },
  },
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      ".gcloud-config/**",
      ".local-setup/**",
      ".tools/**",
      "packages/*/agent-ui/node_modules/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    plugins: {
      "@typescript-eslint": {
        rules: {
          "no-require-imports": noopRule,
        },
      },
    },
    rules: {
      "no-undef": "off",
    },
  },
  {
    files: ["packages/eris/ai/gambling.js"],
    rules: {
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    files: ["packages/*/database/**/*.js"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CatchClause > BlockStatement > ReturnStatement:first-child",
          message: "log before swallowing a persistence error",
        },
      ],
    },
  },
];
