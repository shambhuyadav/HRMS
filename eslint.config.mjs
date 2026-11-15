// ESLint for the whole repository (improvement plan C4): the recommended JavaScript and TypeScript rules, and React's rules of hooks
// for the web app. TypeScript itself (npm run typecheck) already refuses unused locals and parameters and implicit any, so the rules
// here add what the compiler does not check. Run: npm run lint (CI runs it too).
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '.dev-pg/**', '.dev-files/**', 'coverage/**', 'load/**', 'docs/**'],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
    rules: {
      // The compiler checks these (noUnusedLocals, noUnusedParameters, noImplicitAny); ESLint would only repeat them.
      '@typescript-eslint/no-unused-vars': 'off',
      // Deliberate in a few places (narrow casts of parsed JSON, test doubles); kept visible as warnings, not errors.
      '@typescript-eslint/no-explicit-any': 'warn',
      // Control characters are matched on purpose: free text, file names and CSV cells are refused or cleaned of them.
      'no-control-regex': 'off',
      // `let x = null` before a try whose every path sets it reads clearer than a bare declaration.
      'no-useless-assignment': 'off',
      // `cond ? a() : b()` as a statement is used deliberately in the data-migration analysers.
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true, allowShortCircuit: true }],
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    // Tests stub and cast freely.
    files: ['**/*.test.{ts,tsx}', '**/test/**/*.ts', 'db/tests/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
