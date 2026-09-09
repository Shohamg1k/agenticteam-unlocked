// @ts-check
import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['**/dist/**', '**/out/**', '**/node_modules/**', '**/coverage/**', 'web/public/**'] },
  js.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsparser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module', ecmaFeatures: { jsx: true } },
      globals: {
        console: 'readonly', process: 'readonly', Buffer: 'readonly', URL: 'readonly',
        setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly',
        clearInterval: 'readonly', fetch: 'readonly', AbortSignal: 'readonly',
        AbortController: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
        __dirname: 'readonly', structuredClone: 'readonly', queueMicrotask: 'readonly',
        window: 'readonly', document: 'readonly', localStorage: 'readonly',
        WebSocket: 'readonly', HTMLElement: 'readonly', Element: 'readonly',
        MouseEvent: 'readonly', KeyboardEvent: 'readonly', Event: 'readonly',
        performance: 'readonly', crypto: 'readonly', navigator: 'readonly',
        ResizeObserver: 'readonly', MutationObserver: 'readonly', requestAnimationFrame: 'readonly',
        HTMLIFrameElement: 'readonly', HTMLInputElement: 'readonly', HTMLTextAreaElement: 'readonly',
        HTMLDivElement: 'readonly', getComputedStyle: 'readonly', CustomEvent: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tseslint },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-undef': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      'no-console': 'off',
    },
  },
  prettier,
];
