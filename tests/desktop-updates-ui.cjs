'use strict';

const assert = require('node:assert/strict');

/** Production preload and unmodified DSH sidebar consume the standard contract. */
async function verifyDesktopUpdatesUI({ window, rendererValue, waitFor, publish, opens }) {
  assert.deepEqual(await rendererValue(window, `async () => ({
    protocolVersion: window.dshDesktop.protocolVersion,
    state: await window.dshDesktop.updates.status(),
    privateUpdateCheck: typeof window.minkeDesktop.appUpdate.check,
    privateFileOpen: typeof window.minkeDesktop.files.open,
  })`), { protocolVersion: 1, state: { phase: 'idle' }, privateUpdateCheck: 'undefined', privateFileOpen: 'undefined' });

  const indicator = label => `button[aria-label=${JSON.stringify(label)}]`;
  const waitIndicator = label => waitFor(() => rendererValue(window,
    `() => document.querySelector(${JSON.stringify(indicator(label))}) !== null`), `native update label ${label}`);
  publish({ phase: 'checking' });
  await waitIndicator('Checking for updates…');
  assert.equal(await rendererValue(window, `() => document.querySelector('button[aria-label="Checking for updates…"]').getAttribute('aria-disabled')`), 'true');
  publish({ phase: 'downloading', version: '9.0.0', percent: 42 });
  await waitIndicator('42%');
  const before = opens();
  await rendererValue(window, `() => { document.querySelector('button[aria-label="42%"]').click(); return true; }`);
  assert.equal(opens(), before, 'a busy native indicator does not start another operation');
  publish({ phase: 'available', version: '9.0.0' });
  await waitIndicator('Update');
  await rendererValue(window, `() => { document.querySelector('button[aria-label="Update"]').click(); return true; }`);
  await waitFor(() => opens() === before + 1, 'DSH indicator invokes standard updates.open');
  publish({ phase: 'error', failure: 'download', version: '9.0.0' });
  await waitIndicator('Retry update');
  await rendererValue(window, `() => { document.querySelector('button[aria-label="Retry update"]').click(); return true; }`);
  await waitFor(() => opens() === before + 2, 'native retry invokes standard updates.open');

  await rendererValue(window, `() => { document.querySelector('[data-minke-about-trigger]').click(); return true; }`);
  await waitFor(() => rendererValue(window, `() => document.querySelector('[data-minke-about-update-check]') !== null`), 'About update entry');
  await rendererValue(window, `() => { document.querySelector('[data-minke-about-update-check]').click(); return true; }`);
  await waitFor(() => opens() === before + 3, 'About invokes the same standard update action');
  await waitFor(() => rendererValue(window, `() => document.querySelector('[data-minke-about-dialog]') === null`), 'About yields to the native update flow');
  publish({ phase: 'idle' });
  await waitFor(() => rendererValue(window, `() => document.querySelector('button[aria-label="Retry update"]') === null`), 'idle update indicator disappears');
  process.stdout.write('[desktop-updates-ui] native status, progress, retry and About entry passed\n');
}

module.exports = { verifyDesktopUpdatesUI };
