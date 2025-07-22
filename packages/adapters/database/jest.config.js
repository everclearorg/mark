const base = require('../../../jest.config.base.js');

module.exports = {
  ...base,
  displayName: 'Database Adapter',
  testMatch: ['<rootDir>/test/**/*.spec.ts'],
  setupFiles: ['<rootDir>/test/setup.ts'],
};