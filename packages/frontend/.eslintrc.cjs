/**
 * ESLint config for the frontend — the Vite React-TS template's config
 * (eslint 8 / .eslintrc format), which is what the `lint` script
 * (`eslint . --ext ts,tsx --report-unused-disable-directives --max-warnings 0`)
 * was written for.
 *
 * `root: true` stops ESLint from cascading into a parent config; the
 * backend has its own, unrelated `.eslintrc.js`.
 */
module.exports = {
  root: true,
  env: { browser: true, es2020: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  // Build output, plus the plain-JS tool configs (CommonJS / Node, not app
  // code; `--ext ts,tsx` skips them anyway, this just makes it explicit
  // for editors and direct `eslint <file>` runs).
  ignorePatterns: ['dist', 'node_modules', '*.cjs', '*.config.js'],
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 'latest', sourceType: 'module' },
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    // `_`-prefixed names are the codebase's (and TypeScript's) convention
    // for intentionally-unused bindings, e.g. omitting a key via rest
    // destructuring: `const { conditionalOn: _, ...rest } = question`.
    // tsc's noUnusedLocals/noUnusedParameters already enforce the rest.
    '@typescript-eslint/no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
    ],
  },
  overrides: [
    {
      // Runs in Node under Vite, not in the browser.
      files: ['vite.config.ts'],
      env: { browser: false, node: true },
    },
    {
      // Context modules deliberately colocate a Provider component with
      // its consumer hook (useAuth/useToastContext) and default adapter.
      // Splitting them would churn every importer for a dev-only cost:
      // editing one of these two files does a full reload instead of a
      // fast refresh.
      files: ['src/context/AuthContext.tsx', 'src/components/Toast.tsx'],
      rules: { 'react-refresh/only-export-components': 'off' },
    },
  ],
};
