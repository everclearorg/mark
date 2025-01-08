// eslint.config.js (Flat Config example)
import eslintPluginPrettier from 'eslint-plugin-prettier';
import prettierConfig from 'eslint-config-prettier';
import typescriptParser from '@typescript-eslint/parser';
import typescriptPlugin from '@typescript-eslint/eslint-plugin';

export default [
    // 1) Basic ignore settings
    {
        ignores: ['dist', 'node_modules'],
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
