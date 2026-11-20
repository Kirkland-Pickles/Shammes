'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(t) {
  const parent = fs.realpathSync.native(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(parent, 'lib-shammes-test-'));
  t.after(() => {
    if (fs.realpathSync.native(dir) !== dir) throw new Error('Test directory moved');
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

module.exports = tempDir;
