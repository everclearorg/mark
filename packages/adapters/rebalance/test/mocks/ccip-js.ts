/**
 * Mock for @chainlink/ccip-js module
 * This mock is used in tests to avoid ESM import issues
 */

export const createClient = () => ({
  getTransferStatus: async () => null,
});

export default {
  createClient,
};
