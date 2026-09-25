// Child process for the crash/restart test: runs one worker pass over the
// file-backed session store, exactly as a real worker process would.
import { CodingWorker } from '../../src/coding-agent/runtime.js';
import { fakeApis, localRuntime, scriptedPool } from './coding-agent-harness.js';

const [root, storePath, bare, pauseFile] = process.argv.slice(2);
const { fetchFn } = fakeApis({ bare });
const { runtime, sessionStore } = localRuntime({ root, storePath, pool: scriptedPool({ pauseFile }), fetchFn });
const worker = new CodingWorker({ runtime, sessionStore, workerId: `child-${process.pid}` });
const outcome = await worker.runOnce();
process.stdout.write(JSON.stringify(outcome || { status: 'idle' }));
