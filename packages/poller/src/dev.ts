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
