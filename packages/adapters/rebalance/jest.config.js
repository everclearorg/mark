module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.spec.ts'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/index.ts',
        '!src/**/types.ts',
        '!src/adapters/across/utils.ts' // taken from across sdk
    ],
    coverageProvider: 'babel',
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    moduleNameMapper: {
        '^@mark/(.*)$': '<rootDir>/../$1/src',
    },
    // Make Jest resolve .ts before .js
    moduleFileExtensions: [
        'ts', 'tsx',   // ← first in the list
        'js', 'jsx',
        'json', 'node'
    ],
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: '<rootDir>/tsconfig.json',
            },
        ],
    },
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