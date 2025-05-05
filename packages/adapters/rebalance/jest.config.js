module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.spec.ts'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/**/index.ts',
        '!src/**/types.ts'
    ],
    coverageDirectory: 'coverage',
    coverageReporters: ['text', 'lcov', 'html'],
    moduleNameMapper: {
        '^@mark/(.*)$': '<rootDir>/../$1/src',
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