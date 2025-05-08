module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.spec.ts'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/index.ts'
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    modulePathIgnorePatterns: ['<rootDir>/dist/'],
    moduleNameMapper: {
        '^@mark/(.*)$': '<rootDir>/../$1/src',
    },
    // Make Jest resolve .ts before .js
    moduleFileExtensions: [
        'ts', 'tsx',   // ← first in the list
        'js', 'jsx',
        'json', 'node'
    ],
    rootDir: './',
    coverageProvider: 'babel',
    coverageThreshold: {
        global: {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80,
        }
    },
}; 