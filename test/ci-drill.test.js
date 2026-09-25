import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRouteId } from '../src/model-gateway/agentic/route-id.js';

// Runs on the GitHub Actions runner only (skipped elsewhere).
test('route ids format for the CI runner report', { skip: !process.env.GITHUB_ACTIONS && 'runs on GitHub Actions only' }, () => {
  // A route id is `provider:model` (docs/coding-agent.md → Routing policy) and
  // `parseRouteId` splits on the first colon, so the separator is a colon — the
  // model part may contain slashes (`openai/gpt-oss-120b`) but never becomes one.
  assert.equal(formatRouteId('groq', 'openai/gpt-oss-120b'), 'groq:openai/gpt-oss-120b');
});
