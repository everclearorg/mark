module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: {
          exclude: ['**/ccip/**'],
        },
      },
    ],
  },
  setupFilesAfterEnv: ['<rootDir>/../../jest.setup.shared.js', '<rootDir>/test/jest.setup.ts'],
  testMatch: ['**/test/**/*.spec.ts'],
  moduleNameMapper: {
    '^@mark/core$': '<rootDir>/../core/src',
    '^@mark/database$': '<rootDir>/../adapters/database/src',
    '^@mark/cache$': '<rootDir>/../adapters/cache/src',
    '^@mark/everclear$': '<rootDir>/../adapters/everclear/src',
    '^@mark/logger$': '<rootDir>/../adapters/logger/src',
    '^@mark/rebalance$': '<rootDir>/../adapters/rebalance/src',
    '^@mark/chainservice$': '<rootDir>/../adapters/chainservice/src',
    '^@mark/prometheus$': '<rootDir>/../adapters/prometheus/src',
    '^@mark/web3signer$': '<rootDir>/../adapters/web3signer/src',
    '^#/(.*)$': '<rootDir>/src/$1',
    // Mock ESM modules that cause issues
    '^@chainlink/ccip-js$': '<rootDir>/test/mocks/ccip-js.ts',
    '^@chainlink/ccip-sdk$': '<rootDir>/test/mocks/ccip-sdk.ts',
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
  coveragePathIgnorePatterns: ['/node_modules/', '/test/', 'src/rebalance/onDemand.ts'],
};
