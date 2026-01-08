// Polyfill crypto for Solana library compatibility
// Solana libraries expect Web Crypto API (crypto.getRandomValues) to be available globally
import { webcrypto } from 'crypto';
if (typeof globalThis.crypto === 'undefined') {
  // Use Node.js webcrypto which provides Web Crypto API compatibility
  globalThis.crypto = webcrypto as Crypto;
}
// Also set on global for libraries that might access it directly
if (typeof (global as typeof globalThis & { crypto?: Crypto }).crypto === 'undefined') {
  (global as typeof globalThis & { crypto: Crypto }).crypto = webcrypto as Crypto;
}

import './polyfills';
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
