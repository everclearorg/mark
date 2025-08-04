// Shared Jest setup to suppress console logs during tests
global.console = {
  ...console,
  log: jest.fn(),
  debug: jest.fn(),
  // Keep error and warn to see actual problems
  error: console.error,
  warn: console.warn,
  info: console.info,
};
