module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  displayName: 'Database Adapter',
  testMatch: ['<rootDir>/test/**/*.test.ts'],
  globalSetup: '<rootDir>/test/jest.setup.ts',
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
};
