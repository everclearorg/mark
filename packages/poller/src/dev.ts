// Polyfill crypto for Solana library compatibility
// Solana libraries expect Web Crypto API (crypto.getRandomValues) to be available globally
import { webcrypto } from 'crypto';
if (typeof globalThis.crypto === 'undefined') {
  // Use Node.js webcrypto which provides Web Crypto API compatibility
  globalThis.crypto = webcrypto as any;
}
// Also set on global for libraries that might access it directly
if (typeof (global as any).crypto === 'undefined') {
  (global as any).crypto = webcrypto as any;
}

import { initPoller } from './init';

initPoller()
  .then((result) => {
    console.log('Poller completed:', result.statusCode === 200 ? 'success' : 'failed');
    process.exit(result.statusCode === 200 ? 0 : 1);
  })
  .catch((err) => {
    console.log('Poller failed:', err);
    process.exit(1);
  });
