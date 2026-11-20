'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');
const tempDir = require('./fixtures/temp-dir');

function runFixture(t, script) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const result = spawnSync(require('electron'), [path.join(__dirname, script), tempDir(t)],
    { env, encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(result.status, 0, `${script}\n${result.error || ''}\n${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Desktop fixture checks passed/);
}

const windows = { skip: process.platform !== 'win32' };
test('reads and writes Windows shortcuts', windows, t => runFixture(t, 'desktop.electron.cjs'));
test('saves and reviews library changes in Electron', windows, t => runFixture(t, 'desktop-ui.electron.cjs'));
