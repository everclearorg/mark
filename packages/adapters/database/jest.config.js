module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/../../../jest.setup.shared.js'],
  testMatch: ['**/test/**/*.spec.ts'],
  moduleNameMapper: {
    '^@mark/core$': '<rootDir>/../../core/src',
    '^@mark/logger$': '<rootDir>/../logger/src',
  },
};
