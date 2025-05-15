module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testMatch: ['**/test/**/*.spec.ts'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/types.ts', // Usually, type definitions are not included in coverage
        '!src/index.ts',
    ],
};