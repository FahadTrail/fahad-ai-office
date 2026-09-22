// Server-side entry point for a Fahad request. The service-role key remains in
// the VPS environment and is never accepted as a command-line argument.
import { store } from './db.js';

const goal = process.argv.slice(2).join(' ').trim();
if (!goal) {
  console.error('Usage: node src/submit-job.js <goal>');
  process.exit(2);
}
if (goal.length > 8000) {
  console.error('Goal is too long');
  process.exit(2);
}

const job = await store.createJob({ title: goal.slice(0, 120), goal });
console.log(JSON.stringify({ ok: true, jobId: job.id, status: job.status }));
