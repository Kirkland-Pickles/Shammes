'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const tempDir = require('./fixtures/temp-dir');
const path = require('path');
const steam = require('../src/main/steam');

describe('steam detection', () => {
  it('hasSteamExe requires the actual executable', (t) => {
    const td = tempDir(t);
    const empty = path.join(td, 'empty');
    const noExe = path.join(td, 'noexe');
    const good = path.join(td, 'good');
    fs.mkdirSync(empty, { recursive: true });
    fs.mkdirSync(path.join(noExe, 'userdata', '123'), { recursive: true });
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, 'steam.exe'), 'fake');
    assert.equal(steam.hasSteamExe(empty), false);
    assert.equal(steam.hasSteamExe(noExe), false, 'userdata-only dir must not count');
    assert.equal(steam.hasSteamExe(path.join(td, 'missing')), false);
    assert.equal(steam.hasSteamExe(null), false);
    assert.equal(steam.hasSteamExe(''), false);
    assert.equal(steam.hasSteamExe(good), true);
  });
});

describe('steam paths', () => {
  it('normalizes to canonical C:\\…\\Steam form', () => {
    assert.equal(steam.normalizeSteamPath('C:/Program Files (x86)/Steam'), 'C:\\Program Files (x86)\\Steam');
    // guaranteed-missing path: no realpath resolution, pure cleanup
    assert.equal(steam.normalizeSteamPath('c:/definitely-not-here-xyz/steam/'), 'C:\\definitely-not-here-xyz\\steam');
    assert.equal(steam.normalizeSteamPath('D:\\Games\\Steam\\steam.exe'), 'D:\\Games\\Steam');
    assert.equal(steam.normalizeSteamPath(''), '');
    assert.equal(steam.normalizeSteamPath(null), '');
  });

  it('returns true on-disk casing for existing paths', (t) => {
    const td = tempDir(t);
    const mixed = path.join(td, 'MiXeD');
    fs.mkdirSync(mixed, { recursive: true });
    const lower = mixed.toLowerCase();
    // temp root casing may vary; assert the tail resolves to real case
    const out = steam.normalizeSteamPath(lower);
    assert.ok(out.endsWith('\\MiXeD') || out.endsWith('/MiXeD'), out);
  });

  it('reads Steam persona names and falls back to account ids', (t) => {
    const td = tempDir(t);
    const sp = path.join(td, 'Steam');
    fs.mkdirSync(path.join(sp, 'userdata', '12345678'), { recursive: true });
    fs.mkdirSync(path.join(sp, 'userdata', '87654321'), { recursive: true });
    fs.mkdirSync(path.join(sp, 'userdata', '102345678'), { recursive: true });
    fs.mkdirSync(path.join(sp, 'config'), { recursive: true });
    assert.equal(steam.getUserPersonas(sp).length, 3);
    fs.writeFileSync(path.join(sp, 'config', 'loginusers.vdf'),
      '"users"\n{\n\t"76561198062611406"\n\t{\n\t\t"PersonaName"\t"FooBar"\n\t}\n\t"76561197972611406"\n\t{\n\t\t"AccountName"\t"bar"\n\t}\n}\n');
    assert.deepEqual(steam.getUserPersonas(sp), [
      { id: '102345678', name: 'FooBar' }, { id: '12345678', name: '12345678' },
    ]);
  });

  it('maps a known steam64 to its account id', (t) => {
    const td = tempDir(t);
    // account id 12345678 -> steam64 76561197972611406
    const sp = path.join(td, 'Steam');
    fs.mkdirSync(path.join(sp, 'userdata', '12345678'), { recursive: true });
    fs.mkdirSync(path.join(sp, 'config'), { recursive: true });
    fs.writeFileSync(path.join(sp, 'config', 'loginusers.vdf'),
      '"users"\n{\n\t"76561197972611406"\n\t{\n\t\t"PersonaName"\t"TestUser"\n\t}\n}\n');
    const users = steam.getUserPersonas(sp);
    assert.deepEqual(users, [{ id: '12345678', name: 'TestUser' }]);
  });
});

describe('executable search limits', () => {
  it('caps visited dirs instead of hanging on pathological trees', (t) => {
    const td = tempDir(t);
    const scanner = require('../src/main/scanner');
    for (let i = 0; i < 30; i++) {
      fs.mkdirSync(path.join(td, `D${i}`), { recursive: true });
      const fh = fs.openSync(path.join(td, `D${i}`, 'game.exe'), 'w');
      fs.ftruncateSync(fh, 10_000_000);
      fs.closeSync(fh);
    }
    const res = scanner.findExecutables(td, new Set(), { maxDirs: 5 });
    assert.equal(res.truncated, true);
    assert.ok(res.games.length <= 5);
    const full = scanner.findExecutables(td, new Set());
    assert.equal(full.truncated, false);
    assert.equal(full.games.length, 30);
  });
});

describe('steam detection (hint fallthrough)', () => {
  it('findSteamPath honors a verified hint and never returns junk', async (t) => {
    const td = tempDir(t);
    const good = path.join(td, 'Steam');
    fs.mkdirSync(good, { recursive: true });
    fs.writeFileSync(path.join(good, 'steam.exe'), 'fake');
    assert.equal(await steam.findSteamPath(good), fs.realpathSync.native(good));
    const res = await steam.findSteamPath(path.join(td, 'nope'));
    assert.ok(res === null || steam.hasSteamExe(res), 'unverified paths must never be returned');
  });
});

describe('shortcut entries', () => {
  it('buildEntry refuses a missing exe instead of writing "null"', () => {
    assert.throws(
      () => steam.buildEntry({ appName: 'NoExe', exePath: null, startDir: '' }),
      /needs an exe path/);
    assert.throws(
      () => steam.buildEntry({ appName: 'NoExe', exePath: '', startDir: '' }),
      /needs an exe path/);
  });
});
