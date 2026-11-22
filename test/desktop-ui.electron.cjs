'use strict';
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('node:path');
const assert = require('node:assert/strict');
const { DEFAULTS } = require('../src/main/store');

app.setPath('userData', path.join(process.argv[2], 'ui-profile'));
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
const image = nativeImage.createFromBitmap(Buffer.alloc(16, 255), { width: 2, height: 2 }).toDataURL();
const preview = { id: 9, url: image + '#original', thumb: image, width: 2, height: 2 };

async function check(name, options, scenario) {
  let cfg = { ...structuredClone(DEFAULTS), library_intro_seen: true, api_key: 'fixture',
    steam_path: 'C:/Steam', steam_user_id: '1', games_roots: ['C:/Games'], ...options.cfg };
  const handlers = {
    'app:version': () => '9.8.7',
    'cfg:get': () => cfg,
    'cfg:set': patch => (cfg = { ...cfg, ...patch }),
    'steam:detect': () => ({ path: cfg.steam_path, users: [{ id: '1', name: 'Fixture' }] }),
    'steam:verify': () => true,
    'steam:read': () => [],
    'steam:games': () => options.games || [],
    'scan:start': () => cfg.steam_executables,
    'sgdb:search': () => [{ id: 17, name: 'Game' }],
    'sgdb:by-steam': () => ({ id: 17, name: 'Game' }),
    'match:auto': ({ rows }) => ({ rows: rows.map(row => ({ ...row, sgdbId: 17, sgdbName: 'Game' })) }),
    'resolve:name': () => null,
    'cover:cache-get': () => null,
    'cover:cache-put': () => true,
    'art:list': () => [preview],
    'art:official': () => null,
    'art:current': () => null,
    'art:logo-position': () => null,
    'art:preview-file': () => image,
    'art:thumbnail': () => image,
    'desktop:icon': () => image,
    ...options.handlers,
  };
  for (const [channel, handle] of Object.entries(handlers)) ipcMain.handle(channel, (_event, ...args) => handle(...args));
  const win = new BrowserWindow({ show: false, width: 1280, height: 800,
    webPreferences: { preload: path.join(__dirname, '../src/preload.js'), backgroundThrottling: false } });
  const run = code => win.webContents.executeJavaScript(code);
  const query = selector => 'document.querySelector(' + JSON.stringify(selector) + ')';
  const click = selector => run(query(selector) + '.click()');
  const wait = async condition => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await (typeof condition === 'string' ? run(condition) : condition())) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error('Timed out waiting for ' + condition);
  };
  try {
    await win.loadFile(path.join(__dirname, '../src/renderer/index.html'));
    await wait("!document.querySelector('#page-nav').hidden");
    await wait("document.querySelector('.app-version').textContent === 'v9.8.7'");
    await scenario({ run, click, wait, config: () => cfg });
    console.log(name + ' passed');
  } catch (error) {
    throw new Error(name + ': ' + error.message, { cause: error });
  } finally {
    win.destroy();
    for (const channel of Object.keys(handlers)) ipcMain.removeHandler(channel);
  }
}

async function steamArtwork() {
  const drafts = {};
  const appliedCover = image + '#applied';
  let applied, wallpaper;
  await check('Steam artwork Review', {
    games: [{ appid: 42, name: 'Fixture game' }],
    handlers: {
      'sgdb:search': () => [{ id: 17, name: 'Game' }, { id: 42, name: 'Different game' }],
      'art:list': ({ sgdbId }) => sgdbId === 42 ? [{ ...preview, thumb: 'data:image/webp;base64,AAAA' }]
        : [{ ...preview, id: 8, url: image + '#first-match' }],
      'art:wallpaper-available': () => ({ width: 1920, height: 1080 }),
      'art:set-wallpaper': (...args) => { wallpaper = args; },
      'art:thumbnail': () => appliedCover,
      'steam:drafts-save': ({ updates }) => {
        for (const [key, draft] of Object.entries(updates)) {
          if (draft) drafts[key] = draft;
          else delete drafts[key];
        }
      },
      'art:download': req => {
        applied = req;
        return { rows: req.rows.map(row => ({ ...row, appliedKinds: ['grid'], logoPositionApplied: true,
          art: { grid: { ...row.art.grid, appliedFile: 'C:/Fixture/cover.png' } } })),
          lines: [], saved: 1, failed: 0 };
      },
    },
  }, async ({ run, click, wait }) => {
    await wait("document.querySelector('#games .game-open') !== null");
    await click('#games .game-open');
    await wait("document.querySelector('#art-grid .thumb-select') !== null");
    await run("document.querySelector('#art-q').value = 'Different game'");
    await click('#art-search');
    await wait("!document.querySelector('#art-matches').hidden");
    await click('#art-matches .choice-list [data-index="1"]');
    await wait("document.querySelector('#art-id').value === '42' && document.querySelector('#art-status').textContent.startsWith('Different game:')");
    assert.equal(await run("document.querySelector('#art-matches').hidden"), true);
    await click('#art-grid .thumb-select');
    await click('#art-view-full');
    await wait("!document.querySelector('#art-preview-wallpaper').disabled");
    await click('#art-preview-wallpaper');
    await click('#wallpaper-cancel');
    await wait("!document.querySelector('#wallpaper-options').open");
    assert.equal(wallpaper, undefined);
    await click('#art-preview-wallpaper');
    await click('#wallpaper-options [value="fit"]');
    await click('#wallpaper-apply');
    await wait("!document.querySelector('#wallpaper-options').open");
    assert.equal(wallpaper?.[0], 'grid');
    assert.match(wallpaper[1], /^data:image\/jpeg;base64,/);
    assert.equal(wallpaper[2], 'fit');
    await click('#art-preview-back');
    await run("[...document.querySelectorAll('#art-tabs button')].find(tab => tab.textContent === 'Manage').click()");
    await wait("document.querySelector('.manage-preview-open:not([hidden]) img')?.src === " + JSON.stringify(preview.url));
    await run("[...document.querySelectorAll('#art-tabs button')].find(tab => tab.textContent === 'Logo').click()");
    await click('[data-logo-anchor="CenterCenter"]');
    await click('#art-save');
    await wait("document.querySelector('#art-overlay').hidden");
    assert.equal(applied, undefined);
    assert.equal(drafts['steam:42'].art.grid.url, preview.url);
    assert.equal(drafts['steam:42'].sgdbId, 42);
    await click('#btn-add');
    await wait("document.querySelector('#page-review').open");
    assert.equal(await run("document.querySelectorAll('.review-row input:checked').length"), 1);
    await click('#review-apply');
    await wait(() => applied);
    await wait("!document.querySelector('#page-review').open");
    assert.equal(applied.rows[0].steamAppid, 42);
    assert.equal(applied.rows[0].art.grid.url, preview.url);
    assert.equal(applied.rows[0].logoPosition.pinnedPosition, 'CenterCenter');
    assert.deepEqual(Object.keys(drafts), []);
    await wait("document.querySelector('#games .game-cover')?.src === " + JSON.stringify(appliedCover));
  });
}

async function windowsShortcuts() {
  const rows = ['desktop', 'start-menu'].map(destination => ({
    id: destination, destination, shortcut: 'C:/' + destination + '/Fixture.lnk', signature: 'original',
    display: 'Fixture game', exe: 'C:/Games/Game.exe', args: '', admin: false, candidates: [],
  }));
  const attempts = [];
  let finishScan;
  const scan = new Promise(resolve => { finishScan = resolve; });
  let steamUsers = [{ id: '1', name: 'Fixture' }, { id: '2', name: 'Removed' }];
  await check('Paired Windows shortcut Review', {
    cfg: { desktop_destination: 'both' },
    handlers: {
      'steam:detect': () => ({ path: 'C:/Steam', users: steamUsers }),
      'desktop:scan': () => scan,
      'desktop:apply': selected => {
        attempts.push(selected);
        return selected.map(row => attempts.length === 1 && row.destination === 'start-menu'
          ? { id: row.id, ok: false, refreshed: true, row: null, error: 'Shortcut refreshed.' }
          : { id: row.id, ok: true, row: { ...row, iconChoice: null } });
      },
    },
  }, async ({ run, click, wait }) => {
    await click('#desktop-destination [data-destination="desktop"]');
    await wait("document.querySelector('#page-desktop').classList.contains('on') && document.querySelector('#desktop-games').textContent.includes('Loading Windows games')");
    assert.equal(await run("document.querySelector('#center').inert"), false);
    finishScan({ rows, warnings: [] });
    await wait("document.querySelector('#page-desktop').classList.contains('on') && document.querySelector('#desktop-games .game-open')");
    assert.ok(await run("document.querySelector('input[name=steam-account][value=\"2\"]') !== null"));
    steamUsers = steamUsers.slice(0, 1);
    await run("document.querySelector('#preferences').open = true");
    await wait("!document.querySelector('input[name=steam-account][value=\"2\"]')");
    await run("document.querySelector('#preferences').open = false");
    assert.equal(await run("document.querySelectorAll('#desktop-games .game-card-row').length"), 1);
    await click('#desktop-games .game-open');
    await wait("document.querySelector('#art-grid > .thumb .thumb-select') !== null");
    await click('#art-grid > .thumb .thumb-select');
    await run("[...document.querySelectorAll('#art-tabs button')].find(tab => tab.textContent === 'Manage').click()");
    await wait("document.querySelector('.manage-preview-open:not([hidden])') !== null");
    await click('.manage-preview-open');
    await wait("!document.querySelector('#art-preview-image').hidden");
    assert.equal(await run("document.querySelector('#art-preview-image').src"), preview.url);
    await click('#art-preview-back');
    await click('#art-save');
    await wait("document.querySelector('#art-overlay').hidden");
    assert.equal(attempts.length, 0);
    await click('#desktop-add');
    await wait("document.querySelector('#page-review').open");
    await click('#review-apply');
    await wait("!document.querySelector('#page-review').open");
    assert.deepEqual(attempts[0].map(row => row.destination).sort(), ['desktop', 'start-menu']);
    assert.ok(attempts[0].every(row => row.iconChoice.url === preview.url));
    await click('#desktop-add');
    await wait("document.querySelector('#page-review').open");
    assert.equal(await run("document.querySelectorAll('.review-row input:checked').length"), 1);
    await click('#review-apply');
    await wait("!document.querySelector('#page-review').open");
    assert.equal(attempts[1].find(row => row.destination === 'start-menu').shortcut, null);
  });
}

async function executableSearch() {
  const games = [1, 2].map(number => {
    const exePath = 'C:/Games/Game' + number + '.exe';
    return { exePath, folder: exePath, startDir: 'C:/Games', displayName: 'Launcher ' + number, fromExecutableSearch: true };
  });
  await check('Executable search and Review selection', {
    handlers: { 'scan:find-executables': () => ({ games, truncated: false }) },
  }, async ({ run, click, wait, config }) => {
    await click('#add-folders');
    await click('#find-overlooked');
    await wait("document.querySelectorAll('#exe-results input').length === 2");
    await click('#exe-select-all');
    await click('#exe-add');
    await wait("document.querySelectorAll('#games .game-card-row').length === 2");
    assert.deepEqual(config().steam_executables.map(game => game.exePath), games.map(game => game.exePath));
    await click('#btn-add');
    await wait("document.querySelector('#page-review').open");
    assert.equal(await run("document.querySelector('#review-apply').disabled"), true);
    await click('.review-section-head input');
    assert.equal(await run("document.querySelectorAll('.review-row input:checked').length"), 2);
    await click('.review-row input');
    assert.equal(await run("document.querySelector('.review-section-head input').indeterminate"), true);
  });
}

app.whenReady().then(async () => {
  await steamArtwork();
  await windowsShortcuts();
  await executableSearch();
  console.log('Desktop fixture checks passed');
  app.exit(0);
}).catch(error => { console.error(error); app.exit(1); });
