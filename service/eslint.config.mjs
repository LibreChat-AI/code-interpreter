import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import importPlugin from 'eslint-plugin-import';
import globals from 'globals';

export default [
    {
        ignores: [
            'dist/**',
            'config/**',
            'routes/**',
            'src/proto/**',
            'src/scripts/**',
            'scripts/**',
            '.build/**',
            '.build-service/**',
            '**/*.js',
            '**/*.mjs',
            '**/*.test.ts',
            '**/*.spec.ts',
        ],
    },
    js.configs.recommended,
    ...tsPlugin.configs['flat/recommended'],
    importPlugin.flatConfigs.recommended,
    importPlugin.flatConfigs.typescript,
    {
        files: ['**/*.ts'],
        languageOptions: {
            parser: tsParser,
            parserOptions: {
                project: './tsconfig.json',
                ecmaVersion: 2021,
                sourceType: 'module',
            },
            globals: {
                ...globals.node,
                ...globals.es2021,
            },
        },
        settings: {
            'import/resolver': {
                typescript: {
                    alwaysTryTypes: true,
                },
            },
        },
        rules: {
            semi: ['error', 'always'],
            'no-console': 'warn',
            'prefer-const': 'error',
            'no-nested-ternary': 'off',
            'no-useless-escape': 'off',
            '@typescript-eslint/no-unused-vars': [
                'error',
                {
                    argsIgnorePattern: '^_',
                    varsIgnorePattern: '^_',
                    caughtErrorsIgnorePattern: '^_',
                },
            ],
            '@typescript-eslint/no-unnecessary-condition': 'warn',
            '@typescript-eslint/strict-boolean-expressions': 'warn',
            '@typescript-eslint/consistent-type-assertions': 'error',
            '@typescript-eslint/explicit-function-return-type': 'error',
            '@typescript-eslint/no-explicit-any': 'error',
        },
    },
    {
        files: ['src/stream.ts', 'src/utils/logging.ts'],
        rules: {
            'no-console': 'off',
        },
    },
];
