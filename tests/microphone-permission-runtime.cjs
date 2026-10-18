'use strict';

const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { buildSync } = require('esbuild');

// Chromium generates the audio; this test never opens a physical microphone.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
const loaded = { exports: {} };
const compiled = buildSync({
  entryPoints: [join(__dirname, '../desktop/main/harness-permission-policy.ts')],
  bundle: true, platform: 'node', format: 'cjs', write: false,
}).outputFiles[0].text;
new Function('module', 'exports', 'require', compiled)(loaded, loaded.exports, require);
const { installHarnessPermissionPolicy } = loaded.exports;
const server = createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Microphone permission fixture</title>');
});
let window;
const timeout = setTimeout(() => { console.error('Microphone permission fixture timed out'); app.exit(1); }, 30_000);

async function run() {
  await app.whenReady();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const target = session.fromPartition('minke-microphone-test');
  window = new BrowserWindow({ show: false, webPreferences: {
    session: target, contextIsolation: true, nodeIntegration: false, sandbox: true,
  } });
  let requests = 0;
  let granted = false;
  installHarnessPermissionPolicy(target, {
    harnessUrl: () => origin, activeWebContents: () => window.webContents,
    microphone: { isGranted: () => granted, request: async () => { requests++; granted = true; return true; } },
  });
  await window.loadURL(origin);
  const audio = await window.webContents.executeJavaScript(`(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const kinds = stream.getTracks().map(track => track.kind);
    stream.getTracks().forEach(track => track.stop());
    return kinds;
  })()`, true);
  assert.deepEqual(audio, ['audio']);
  assert.equal(requests, 1);
  const blocked = await window.webContents.executeJavaScript(`(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach(track => track.stop());
      return 'allowed';
    } catch (error) { return error.name; }
  })()`, true);
  assert.equal(blocked, 'NotAllowedError');
  const frame = await window.webContents.executeJavaScript(`(async () => {
    const iframe = document.createElement('iframe');
    iframe.src = '/frame';
    const ready = new Promise(resolve => { iframe.onload = resolve; });
    document.body.append(iframe);
    await ready;
    try {
      const stream = await iframe.contentWindow.navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(track => track.stop());
      return 'allowed';
    } catch (error) { return error.name; }
  })()`, true);
  assert.equal(frame, 'NotAllowedError');
  assert.equal(requests, 1, 'rejected frames and video must not request OS consent');
  console.log('Microphone permission runtime passed: main-frame audio, camera denial, iframe denial');
}

run().then(() => finish(0), error => { console.error(error); finish(1); });
function finish(code) {
  clearTimeout(timeout);
  window?.destroy();
  server.closeAllConnections();
  server.close();
  app.exit(code);
}
