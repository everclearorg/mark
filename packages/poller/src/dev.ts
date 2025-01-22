import { initPoller } from './init';

initPoller().catch((err) => {
  console.log('Poller failed:', err);
  process.exit(1);
});
