// eslint.config.js (CommonJS example)
const eslintPluginPrettier = require('eslint-plugin-prettier');
const prettierConfig = require('eslint-config-prettier');
const typescriptParser = require('@typescript-eslint/parser');
const typescriptPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
    // 1) Basic ignore settings
    {
        ignores: ['dist', 'node_modules', '**/zapatos/zapatos/**'],
    },

    // 2) Settings for all TypeScript files
    {
        files: ['**/*.ts', '**/*.tsx'],
        languageOptions: {
            parser: typescriptParser,
            parserOptions: {
                project: ['./packages/**/tsconfig.json'],
            },
        },
        plugins: {
            prettier: eslintPluginPrettier,
            '@typescript-eslint': typescriptPlugin,
        },
        rules: {
            ...typescriptPlugin.configs.recommended.rules,
            ...prettierConfig.rules,
            'prettier/prettier': 'warn',
            '@typescript-eslint/no-non-null-assertion': 'off',
            '@typescript-eslint/no-var-requires': 'off',
        },
    },
];
