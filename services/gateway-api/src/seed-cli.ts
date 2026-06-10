import { migrate, closePool } from '@conductor/db';
import { assertConfig } from './config.js';
import { seed } from './seed.js';

// Standalone seed runner: `npm run seed -w @conductor/gateway-api`
assertConfig();
await migrate();
await seed();
await closePool();
process.exit(0);
