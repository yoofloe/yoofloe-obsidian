import test from 'node:test';
import assert from 'node:assert/strict';
import { AiWorkspace } from '../dist/workspace.js';
import { prepareCalendarChangeDraft } from '../dist/calendar-change-draft.js';

const vaultId = '815b9a69-7a8f-496d-abcb-2699e5481d75';
const datasetId = '4ac45c5b-d48b-4d1a-9a15-9b983b73a04c';
const operation = (fields = {}) => ({
  action: 'create', kind: 'task', record: null, title: 'Synthetic task', description: null,
  start: null, end: null, allDay: null, timezone: null, dueDate: null, clearDueDate: false, status: null, ...fields,
});
const response = output => ({ status: 200, text: JSON.stringify({ status: 'completed', output }) });
const result = text => ({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });

test('Calendar edit and deletion targets resolve only from the approved lookup', async () => {
  const lookup = {
    datasetId, records: [
      { kind: 'event', sourceId: 'native-event', title: 'Existing event', revision: 5 },
      { kind: 'task', sourceId: 'native-task', title: 'Existing task', revision: 9 },
    ],
  };
  const operations = [
    operation({ action: 'update', record: 'C2', title: null, clearDueDate: true }),
    operation({ action: 'delete', kind: 'event', record: 'C1', title: null }),
  ];
  const { draft, titles } = await prepareCalendarChangeDraft({ operations }, lookup);
  assert.equal(draft.datasetId, datasetId);
  assert.deepEqual(draft.operations.map(op => op.target), [{ id: 'native-task', revision: 9 }, { id: 'native-event', revision: 5 }]);
  assert.deepEqual(draft.operations.map(op => op.values), [{ dueDate: null }, null]);
  assert.deepEqual(Object.values(titles), ['Existing task', 'Existing event']);
  await assert.rejects(prepareCalendarChangeDraft({ operations }, null), /current Calendar lookup/);
  await assert.rejects(prepareCalendarChangeDraft({ operations: [operation({ action: 'update', record: 'native-task' })] }, lookup), /look up/i);
  await assert.rejects(prepareCalendarChangeDraft({ operations: [operation({ action: 'update', record: 'C1' })] }, lookup), /matching event or task/);
});

test('a Calendar draft is local until user review, then an authenticated result enables a separate undo', async () => {
  let saved, calls = 0, replies = 0, launches = 0, nextStatus = 'applied', requestId = null;
  let failMarker = false;
  const changes = [];
  const userNote = { path: 'Original.md', title: 'Original', size: 17, text: 'PRIVATE NOTE TEXT', identity: {} };
  const host = {
    files: () => [userNote], read: async () => { throw Error('Calendar mode should not read the note'); },
    replace: async () => { throw Error('Calendar mode should not write the note'); },
  };
  const bridge = {
    get requestId() { return requestId; },
    start: async (draft, options) => {
      if (failMarker) throw Error('The Calendar change marker could not be verified.');
      launches++; requestId = crypto.randomUUID(); changes.push({ draft, ...options });
      return 'yoofloe-calendar://obsidian/change?version=4';
    },
    receive: async id => {
      assert.equal(id, requestId);
      replies++; requestId = null;
      return { status: nextStatus, datasetId };
    },
    dispose: async () => { requestId = null; },
  };
  const options = {
    current: () => true, configDir: '.obsidian', gate: { busy: false }, inboxHint: () => '',
    host: () => host, calendarChange: () => bridge,
    preferences: { read: async () => ({model:'gpt-6-luna',effort:'none'}), hasKey: async () => true, key: async () => 'sk-synthetic-agent-key', vaultId: async () => vaultId },
    storage: { load: async () => ({ source:'Original.md', mode:'edit' }), save: async value => { saved = structuredClone(value); }, history: async () => [] },
    transport: async req => {
      const body = JSON.parse(req.body);
      assert.deepEqual(body.tools.map(t => t.name), ['draft_calendar_changes']);
      assert(!req.body.includes('PRIVATE NOTE TEXT'));
      assert.equal(await work.submitFollowUp('queue'), false);
      assert.equal(await work.submitFollowUp('steer'), false);
      if (++calls === 1) return response([{ type:'function_call', call_id:'propose', name:'draft_calendar_changes',
        arguments:JSON.stringify({ operations:[operation()] }) }]);
      return response([result('Review this proposal in Calendar.')]);
    },
  };
  const work = new AiWorkspace(options);
  await work.initialize();
  work.calendarChanges.setEnabled(true);
  work.setPrompt('Add a test task');
  work.setFollowUpDraft('Preserve this unsent follow-up locally');
  assert.equal(await work.submitFollowUp('queue'), false);
  await work.run();
  assert.equal(work.followUpDraft, 'Preserve this unsent follow-up locally');
  assert.equal(work.followUps.length, 0);
  assert.equal(work.calendarChanges.state.status, 'draft');
  assert.equal(saved.calendarChange.status, 'draft');
  assert.equal(launches, 0);
  assert.equal(calls, 2);
  assert.equal(await work.calendarChanges.open('undo'), null);
  assert(await work.calendarChanges.open('review'));
  assert.equal(changes[0].action, 'review');
  assert.equal(changes[0].datasetId, null);
  assert.equal(changes[0].vaultId, vaultId);
  assert.equal(saved.calendarChange.status, 'waiting');
  assert.equal(await work.calendarChanges.receive(crypto.randomUUID()), false);
  assert.equal(replies, 0);
  assert(await work.calendarChanges.receive(requestId));
  assert.equal(saved.calendarChange.status, 'applied');
  assert.equal(saved.calendarChange.datasetId, datasetId);
  failMarker = true;
  assert.equal(await work.calendarChanges.open('undo'), null);
  assert.equal(saved.calendarChange.status, 'applied');
  assert.equal(work.calendarChanges.canOpen('undo'), true);
  failMarker = false;
  assert(await work.calendarChanges.open('undo'));
  assert.equal(changes[1].datasetId, datasetId);
  assert.equal(changes[1].draft.proposalId, changes[0].draft.proposalId);
  nextStatus = 'cancelled';
  assert(await work.calendarChanges.receive(requestId));
  assert.equal(work.calendarChanges.canOpen('review'), false);
  assert(await work.calendarChanges.open('undo'));
  nextStatus = 'conflict';
  assert(await work.calendarChanges.receive(requestId));
  assert.equal(work.calendarChanges.state.applied, true);
  assert(await work.calendarChanges.open('undo'));
  nextStatus = 'undone';
  assert(await work.calendarChanges.receive(requestId));
  assert.equal(saved.calendarChange.status, 'undone');
  assert.equal(saved.calendarChange.applied, false);
  assert.equal(calls, 2);
  const desktop = new AiWorkspace({ ...options, calendarChange: undefined, storage: { ...options.storage, load: async () => saved } });
  await desktop.initialize();
  assert.equal(desktop.calendarChanges.state.status, 'undone');
  assert.equal(await desktop.calendarChanges.open('status'), null);
});


test('changing Calendar proposal mode clears the visible data preview and invalidates an in-flight note preview', async () => {
  let readStarted, finishRead;
  const whenReading = new Promise(resolve => { readStarted = resolve; });
  const readDelay = new Promise(resolve => { finishRead = resolve; });
  const note = { path: 'Original.md', title: 'Original', size: 15, identity: {} };
  const host = { files: () => [note], read: async () => {
    readStarted(); await readDelay; return 'PRIVATE PREVIEW';
  } };
  const work = new AiWorkspace({
    current: () => true, configDir: '.obsidian', gate: { busy: false }, inboxHint: () => '',
    host: () => host, calendarChange: () => ({}),
    preferences: { read: async () => ({model:'gpt-6-luna',effort:'none'}), hasKey: async () => true },
    storage: { load: async () => ({ source: 'Original.md' }), save: async () => {}, history: async () => [] },
  });
  await work.initialize();
  work.setPrompt('Draft the next step');
  work.calendarChanges.setEnabled(true);
  await work.review();
  assert.match(work.preview, /Calendar proposal only/);

  work.calendarChanges.setEnabled(false);
  assert.equal(work.preview, '');
  const pending = work.review();
  await whenReading;
  work.calendarChanges.setEnabled(true);
  await work.review();
  const approvedPreview = work.preview;
  assert.match(approvedPreview, /Calendar proposal only/);
  finishRead();
  await pending;
  assert.equal(work.preview, approvedPreview);
  assert(!work.preview.includes('PRIVATE PREVIEW'));
});
