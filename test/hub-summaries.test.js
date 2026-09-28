// V5.1 screen summaries: one true sentence from data the page already has.
import assert from 'node:assert/strict';
import test from 'node:test';
import { attentionSummary, employeesSummary, projectsSummary, tasksSummary } from '../src/hub-ui/summaries.js';

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
