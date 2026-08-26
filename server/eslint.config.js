import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';

export default [
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**'] },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2023, sourceType: 'module' },
      globals: { process: 'readonly', console: 'readonly', Buffer: 'readonly' },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      ...tsPlugin.configs.recommended.rules,

      // Unused args are common in Express signatures; allow the _ convention.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],

      // Guard the rules the spec cares about most.
      'no-console': 'error', // use the redacting logger, never console
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "MemberExpression[object.name='prisma'][property.name='auditLog'] ~ *",
          message: 'Audit entries are append-only — write them through recordAudit().',
        },
      ],
    },
  },
  {
    // Tests may reach for looser constructs than production code.
    files: ['**/*.test.ts', 'tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
];
