module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  setupFilesAfterEnv: ['<rootDir>/../../jest.setup.shared.js', '<rootDir>/test/jest.setup.ts'],
  testMatch: ['**/test/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.json',
      },
    ],
  },
  moduleNameMapper: {
    '^@mark/core$': '<rootDir>/../core/src',
    '^@mark/logger$': '<rootDir>/../adapters/logger/src',
    '^@mark/database$': '<rootDir>/../adapters/database/src',
    '^@mark/cache$': '<rootDir>/../adapters/cache/src',
    '^@mark/everclear$': '<rootDir>/../adapters/everclear/src',
    '^@mark/rebalance$': '<rootDir>/../adapters/rebalance/src',
    '^@mark/chainservice$': '<rootDir>/../adapters/chainservice/src',
    '^@mark/prometheus$': '<rootDir>/../adapters/prometheus/src',
    '^@mark/web3signer$': '<rootDir>/../adapters/web3signer/src',
    '^@mark/webhooks$': '<rootDir>/../adapters/webhooks/src',
    '^@mark/poller$': '<rootDir>/../poller/src',
    '^@mark/agent$': '<rootDir>/../agent/src',
    '^#/(.*)$': '<rootDir>/src/$1',
    '^zapatos/schema$': '<rootDir>/../adapters/database/src/zapatos/zapatos/schema',
    '^zapatos/db$': '<rootDir>/../adapters/database/node_modules/zapatos/dist/db',
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
