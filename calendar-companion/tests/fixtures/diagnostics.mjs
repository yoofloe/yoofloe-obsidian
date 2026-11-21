import { Diagnostics } from '../../dist/diagnostics.js';

export const environment = { plugin: '0.9.11', obsidian: '1.15.1', platform: 'android' };
export function diagnosticFixture(now = Date.now) {
  const records = new Map();
  const storage = {
    keys: async prefix => [...records.keys()].filter(key => key.startsWith(prefix)),
    read: async key => records.get(key) ?? null,
    write: async (incoming, _keep, changes) => {
      for (const key of changes?.remove ?? []) records.delete(key);
      for (const [key, value] of incoming) records.set(key, value);
    },
    discard: async keys => { for (const key of keys) records.delete(key); },
  };
  const diagnostics = new Diagnostics(storage, environment, () => true, now);
  return { diagnostics, records, storage };
}

export function exportedReport(text) {
  return JSON.parse(text.slice(text.lastIndexOf('\n\n{') + 2));
}
