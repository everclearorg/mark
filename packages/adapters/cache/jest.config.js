module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.spec.ts'],
    collectCoverageFrom: [
        'dist/**/*.js',
        '!dist/**/*.d.js',
        '!dist/**/index.js'
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov'],
    modulePathIgnorePatterns: ['<rootDir>/dist/'],
    moduleNameMapper: {
        '^@mark/(.*)$': '<rootDir>/../$1/src',
    },
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: '<rootDir>/tsconfig.json',
                mapCoverage: true,
            },
        ],
    },
    rootDir: './',
    coverageProvider: 'v8',
    coverageThreshold: {
        global: {
            branches: 80,
            functions: 80,
            lines: 80,
            statements: 80,
        }
    },
}; 