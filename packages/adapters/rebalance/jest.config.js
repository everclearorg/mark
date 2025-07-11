module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.spec.ts', '**/test/**/*.integration.spec.ts'],
    testTimeout: 30000,
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/index.ts',
        '!src/**/types.ts',
        '!src/adapters/across/utils.ts' // taken from across sdk
    ],
    coverageProvider: 'babel',
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    modulePathIgnorePatterns: ['<rootDir>/dist/'],
    moduleNameMapper: {
        '^@mark/core$': '<rootDir>/../../core/src',
        '^@mark/core/(.*)$': '<rootDir>/../../core/src/$1',
        '^@mark/(.*)$': '<rootDir>/../$1/src',
    },
    // Make Jest resolve .ts before .js
    moduleFileExtensions: [
        'ts', 'tsx',   // ← first in the list
        'js', 'jsx',
        'json', 'node'
    ],
    rootDir: './',
    coverageThreshold: {
        global: {
            branches: 70,
            functions: 85,
            lines: 85,
            statements: 85
        }
    }
};