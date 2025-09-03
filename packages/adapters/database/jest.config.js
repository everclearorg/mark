module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/setup.ts',
  setupFilesAfterEnv: ['<rootDir>/../../../jest.setup.shared.js'],
  testMatch: ['**/test/**/*.spec.ts'],
  testTimeout: 30000,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/**/index.ts',
    '!src/**/types.ts'
  ],
  coverageProvider: 'babel',
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov'],
  modulePathIgnorePatterns: ['<rootDir>/dist/'],
  silent: false,
  verbose: false,
  moduleNameMapper: {
    '^@mark/core$': '<rootDir>/../../core/src',
    '^@mark/core/(.*)$': '<rootDir>/../../core/src/$1',
    '^@mark/(.*)$': '<rootDir>/../$1/src',
  },
  rootDir: './',
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 85,
      lines: 85,
      statements: 85,
    },
  },
};
