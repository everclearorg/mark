module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/../../jest.setup.shared.js'],
  testMatch: ['**/test/**/*.spec.ts'],
  moduleNameMapper: {
    // Allow importing from src
    '^@mark/core$': '<rootDir>/src',
  },
  collectCoverage: false,
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },
  coveragePathIgnorePatterns: ['/node_modules/', '/test/'],
};
