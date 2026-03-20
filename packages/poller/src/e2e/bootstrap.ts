// Bootstrap: loads .env.e2e BEFORE any other module is imported.
// This file must be the entry point — it uses dynamic import() so that
// @mark/core's top-level dotenv.config() sees our env vars already set.

import { config as dotenvConfig } from 'dotenv';
import { existsSync } from 'fs';
import { resolve } from 'path';

const e2eEnvPath = resolve(__dirname, '../../.env.e2e');
if (existsSync(e2eEnvPath)) {
  dotenvConfig({ path: e2eEnvPath, override: true });
} else {
  dotenvConfig();
}

// Now safe to load the runner — all imports inside runner.ts will see our env vars.
import('./runner').catch((err) => {
  console.error('E2E runner failed to load:', err);
  process.exit(1);
});
