module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/../../jest.setup.shared.js', '<rootDir>/test/jest.setup.ts'],
  testMatch: ['**/test/**/*.spec.ts'],
  moduleNameMapper: {
    '^@mark/core$': '<rootDir>/../core/src',
    '^@mark/database$': '<rootDir>/../adapters/database/src',
    '^@mark/cache$': '<rootDir>/../adapters/cache/src',
    '^@mark/everclear$': '<rootDir>/../adapters/everclear/src',
    '^@mark/logger$': '<rootDir>/../adapters/logger/src',
    '^#/(.*)$': '<rootDir>/src/$1',
  },
};
