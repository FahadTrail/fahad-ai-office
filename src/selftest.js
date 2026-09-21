// Intentionally read-only. Never claim a real job or invoke Claude in a test.
import { main } from './healthcheck.js';
await main();
