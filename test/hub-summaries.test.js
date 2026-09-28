// V5.1 screen summaries: one true sentence from data the page already has.
import assert from 'node:assert/strict';
import test from 'node:test';
import { artifactsSummary, attentionSummary, chatsSummary, employeesSummary, integrationsSummary, modelsSummary, projectsSummary, tasksSummary } from '../src/hub-ui/summaries.js';

test('employees summary names who works, counts waiting, names who needs Fahad', () => {
  assert.equal(employeesSummary([{ label: 'FINANCE', state: 'WORKING' }, { label: 'LEGAL', state: 'THINKING' }, { label: 'SOCIAL', state: 'WAITING' }, { label: 'CODING', state: 'NEEDS FAHAD' }]),
    'FINANCE and LEGAL are working; 1 employee is waiting; CODING needs you.');
  assert.equal(employeesSummary([{ label: 'CHIEF', state: 'AVAILABLE' }]), 'Everyone is available — tell CHIEF what you need.');
});

test('attention, tasks and projects summaries', () => {
  assert.equal(attentionSummary([{ priority: 'URGENT' }, { priority: 'ACTION NEEDED' }, { priority: 'INFO' }]), '2 things need you: 1 urgent, 1 waiting for a decision or an answer.');
  assert.equal(attentionSummary([{ priority: 'INFO' }]), 'Nothing needs you right now.');
  assert.equal(tasksSummary([{ title: 'Pre-order API' }], 'running'), '1 task running. The latest is “Pre-order API”.');
  assert.equal(tasksSummary([], 'running'), 'No development task is running.');
  assert.equal(projectsSummary([{ id: 'a', name: 'Qahwa Run' }, { id: 'b', name: 'HQ' }], 'a'), '2 projects; you are in Qahwa Run.');
});

test('artifacts, integrations, models and chats summaries', () => {
  assert.equal(artifactsSummary([{ title: 'Launch budget', agentLabel: 'FINANCE' }, { title: 'Brand' }]), '2 deliverables; the latest is “Launch budget” from FINANCE.');
  assert.match(artifactsSummary([]), /^No deliverables yet/);
  assert.equal(integrationsSummary(['CONNECTED', 'CONFIGURED', 'ACCOUNT ACTION REQUIRED']), '1 of 3 tools connected; 1 needs an account action from you.');
  assert.equal(modelsSummary({ AVAILABLE: 4, COOLDOWN: 2 }, 1), '4 models are available now; 2 resting until their limits reset; 1 employee is waiting for free capacity and will resume automatically.');
  assert.equal(modelsSummary({}, 0), 'No model is available right now.');
  assert.equal(chatsSummary([{ title: 'Card fees' }]), '1 chat; the latest is “Card fees”.');
  assert.equal(chatsSummary([], true), 'No archived chats.');
});
