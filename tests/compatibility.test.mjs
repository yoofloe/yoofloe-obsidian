import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

const subject = createRequire(import.meta.url)(process.env.YOOFLOE_TEST_SUBJECT);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/external-access-v3.json', import.meta.url)));

test('accepts the app v3 contract while keeping PAT plaintext disabled', () => {
  const result = subject.parseSecurityContract(fixture.security);
  assert.equal(result.schemaVersion, 3);
  assert.equal(result.surfaces.obsidian_mcp.canReadZkePlaintext, false);
  assert.equal(result.surfaces.cli_mcp.canReadZkePlaintext, true);
});

test('accepts the legacy v2 contract and rejects an unknown version or unsafe PAT surface', () => {
  const legacy = structuredClone(fixture.security);
  legacy.schemaVersion = 2;
  delete legacy.surfaces;
  assert.equal(subject.parseSecurityContract(legacy).schemaVersion, 2);
  assert.throws(() => subject.parseSecurityContract({ ...legacy, schemaVersion: 4 }), /unsupported/);
  const unsafe = structuredClone(fixture.security);
  unsafe.surfaces.obsidian_mcp.canReadZkePlaintext = true;
  assert.throws(() => subject.parseSecurityContract(unsafe), /surface/);
  assert.throws(() => subject.parseSecurityContract({ ...legacy, rawKeyStorageAllowed: true }), /PAT access/);
});

test('access errors distinguish expiry, revocation, permissions and server updates', () => {
  assert.match(subject.describeAccessError(401, 'TOKEN_EXPIRED'), /expired/);
  assert.match(subject.describeAccessError(401, 'TOKEN_REVOKED'), /revoked/);
  assert.match(subject.describeAccessError(403, 'TOKEN_SCOPE_INSUFFICIENT'), /permit/);
  assert.match(subject.describeAccessError(405, 'CLIENT_UPDATE_REQUIRED'), /No personal data/);
});

function accessStatus() {
  return { success: true, kind: 'obsidian-access-status', generatedAt: '2026-09-07T12:00:00Z',
    entitlement: { allowed: true, tier: 'free', source: 'none', status: null },
    capabilities: ['obsidian:read'], security: fixture.security };
}

test('plugin verification uses GET without requesting a domain bundle', async () => {
  let observed;
  globalThis.obsidianRequest = async (request) => {
    observed = request;
    return { status: 200, json: accessStatus() };
  };
  const client = new subject.YoofloeClient({ functionsBaseUrl: 'https://example.test/functions/v1' }, 'pat_yfl_fixture');
  assert.equal((await client.testToken()).kind, 'obsidian-access-status');
  assert.equal(observed.method, 'GET');
  assert.equal(observed.body, undefined);
});

test('old servers fail diagnostics without a POST fallback', async () => {
  let requests = 0;
  globalThis.obsidianRequest = async () => { requests++; return { status: 405, json: {} }; };
  const client = new subject.YoofloeClient({ functionsBaseUrl: 'https://example.test' }, 'pat_yfl_fixture');
  await assert.rejects(client.testToken(), { code: 'CLIENT_UPDATE_REQUIRED' });
  assert.equal(requests, 1);
  assert.throws(() => subject.parseAccessStatus({ ...accessStatus(), bundle: {} }), /unsupported access status/);
});

test('late responses and failures cannot cross an account or endpoint change', async () => {
  for (const fails of [false, true]) {
    let finish;
    let current = true;
    globalThis.obsidianRequest = () => new Promise((resolve, reject) => { finish = () => fails ? reject(new Error('401')) : resolve({ status: 200, json: accessStatus() }); });
    const client = new subject.YoofloeClient({ functionsBaseUrl: 'https://example.test' }, 'pat_yfl_fixture', () => current);
    const response = client.testToken();
    current = false;
    finish();
    await assert.rejects(response, { code: 'CONNECTION_CHANGED' });
  }
});

test('missing MCP configuration starts with diagnostics and no content/write tools', () => {
  const config = subject.readMcpConfig({});
  const tools = new Map();
  subject.registerYoofloeTools({ registerTool: (name, options, callback) => tools.set(name, { options, callback }) }, config);
  assert.deepEqual([...tools.keys()].sort(), ['yoofloe_agent_direct_guide', 'yoofloe_mcp_session_status', 'yoofloe_test_token']);
  const result = tools.get('yoofloe_mcp_session_status').callback().structuredContent;
  assert.equal(result.configuration.ready, false);
  assert.equal(result.auth.verification, 'not_verified');
  assert.equal(result.security, null);
  assert.equal(result.permissions.localVaultWrites, false);
});

test('MCP verifies a local status server with GET and clears failed verification', async (t) => {
  const methods = [];
  let status = 200;
  const server = createServer((request, response) => {
    methods.push(request.method);
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status === 200 ? accessStatus() : { code: 'TOKEN_REVOKED', error: 'private backend details' }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new subject.YoofloeMcpHttpClient({ pat: 'pat_yfl_fixture', functionsBaseUrl: 'http://127.0.0.1:' + server.address().port });
  assert.equal((await client.testToken()).security.schemaVersion, 3);
  status = 401;
  await assert.rejects(client.testToken(), (error) => error.code === 'TOKEN_REVOKED' && !error.message.includes('private'));
  assert.equal(client.accessStatus, null);
  assert.deepEqual(methods, ['GET', 'GET']);
});

test('coverage preserves empty, encrypted and unavailable totals without inventing missing-source facts', () => {
  const bundle = { meta: { domains: ['journal', 'finance', 'library'], coverage: {
    journal: { notices: [{ code: 'EMPTY_CONTEXT', message: 'untrusted server display text' }] },
    finance: { notices: [{ code: 'MONETARY_TOTALS_UNAVAILABLE' }] }
  } } };
  const notices = subject.getContextNotices(bundle);
  assert.equal(notices[0].code, 'EMPTY_CONTEXT');
  assert.equal(notices[1].code, 'MONETARY_TOTALS_UNAVAILABLE');
  assert.equal(notices[2].code, 'COVERAGE_NOT_REPORTED');
  assert.equal(notices[3].code, 'BOUNDED_CONTEXT');
  assert.ok(!JSON.stringify(notices).includes('untrusted'));
  const markdown = subject.renderWriterInlineMarkdown({ title: 'Example', markdownBody: 'Body', unavailable: notices });
  assert.match(markdown, /Context coverage/);
  assert.match(markdown, /not zero/);
  assert.match(markdown, /Completeness is unknown/);
});

test('diagnostic guides never echo embedded credentials, queries or fragments from invalid endpoints', () => {
  for (const endpoint of [
    'https://sentinel-user:sentinel-password@example.test/functions/v1',
    'https://example.test/functions/v1?api_key=sentinel-password',
    'https://example.test/functions/v1#sentinel-password',
    'ftp://example.test/sentinel-password'
  ]) {
    const config = subject.readMcpConfig({ YOOFLOE_FUNCTIONS_BASE_URL: endpoint });
    const tools = new Map();
    subject.registerYoofloeTools({ registerTool: (name, options, callback) => tools.set(name, callback) }, config);
    const guide = tools.get('yoofloe_agent_direct_guide')();
    assert.ok(!JSON.stringify(guide).includes('sentinel-'));
    assert.ok(config.configurationIssues.some((entry) => entry.code === 'ENDPOINT_INVALID'));
  }
});

test('a late Google rejection cannot invalidate the newly selected Yoofloe account', async () => {
  let token = 'pat_yfl_old';
  let rejectGoogle;
  let notifyGoogle;
  const googleStarted = new Promise((resolve) => { notifyGoogle = resolve; });
  const plugin = Object.create(subject.YoofloePlugin.prototype);
  plugin.settings = { functionsBaseUrl: 'https://example.test/functions/v1', defaultOutputTarget: 'new-note',
    provider: { type: 'gemini-vertex', clientId: 'fixture-client', project: 'fixture-project', location: 'global', vertexModel: 'fixture-model' } };
  plugin.secretStore = { isAvailable: true, getPat: () => token, getGoogleClientSecret: () => 'fixture-secret' };
  plugin.googleAuth = { getAccessToken: () => new Promise((_resolve, reject) => { rejectGoogle = reject; notifyGoogle(); }) };
  plugin.getUserOwnedWriterBlocker = () => null;
  plugin.clearStatusResetTimer = () => {};
  plugin.queueIdleStatusReset = () => {};
  const statuses = [];
  plugin.setStatus = (status) => statuses.push(status);
  globalThis.obsidianRequest = async () => ({ status: 200, json: {
    success: true, entitlement: accessStatus().entitlement,
    bundle: { meta: { security: fixture.security, domains: ['journal'] }, domains: {} }
  } });
  const result = plugin.runHostedWriterFromOptions({ documentType: 'daily-review', domains: ['journal'], range: '1W', scope: 'personal', outputMode: 'new-note' });
  await googleStarted;
  token = 'pat_yfl_new';
  plugin.tokenStatus = 'verified';
  const currentEntitlement = { allowed: true, tier: 'pro' };
  plugin.latestEntitlement = currentEntitlement;
  statuses.length = 0;
  rejectGoogle(new Error('old token invalid'));
  await assert.rejects(result, { code: 'CONNECTION_CHANGED' });
  assert.equal(plugin.tokenStatus, 'verified');
  assert.equal(plugin.latestEntitlement, currentEntitlement);
  assert.deepEqual(statuses, []);
});
