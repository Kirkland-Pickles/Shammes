'use strict';
const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function renderer(api) {
  const button = {};
  const context = vm.createContext({
    window: { api }, document: { addEventListener() {}, querySelector: () => button },
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src/renderer/app.js'), 'utf8'), context);
  vm.runInContext('renderRows = () => {}; renderDetail = () => {};', context);
  return { context, button, state: vm.runInContext('S', context), refresh: () => vm.runInContext('doRefresh()', context) };
}

it('restores artwork drafts and keeps failed picks after Apply', async () => {
  let disk = { steam_path: 'C:/Steam', steam_user_id: '1', sgdb_map: {}, sgdb_cache: {}, steam_art_drafts: {} };
  let writes = 0;
  const api = {
    cfgGet: async () => structuredClone(disk),
    steamDraftsSave: async ({ scope, updates }) => {
      const account = disk.steam_art_drafts[scope] ||= {};
      for (const [key, draft] of Object.entries(updates)) {
        if (draft) account[key] = structuredClone(draft);
        else delete account[key];
      }
    },
    artDownload: async ({ rows }) => {
      writes++;
      return { rows: rows.map(row => ({ ...row,
        art: { ...row.art, grid: { ...row.art.grid, appliedFile: 'C:/Steam/grid.png' } },
        appliedKinds: ['grid'], failedKinds: ['logo'] })), lines: [] };
    },
  };
  const first = renderer(api);
  first.state.cfg = structuredClone(disk);
  first.context.game = { source: 'steam', steamAppid: 123, folder: 'steam:123', sgdbId: 7,
    pendingArt: true, art: { grid: { url: 'https://example.test/grid.png' }, logo: { file: 'C:/missing/logo.png' } } };
  await vm.runInContext('saveSteamDrafts([game])', first.context);
  const reboot = renderer(api);
  reboot.state.cfg = structuredClone(disk);
  await vm.runInContext('syncSteamLibrary([], [{ appid: 123, name: "Game" }])', reboot.context);
  assert.equal(reboot.state.rows[0].pendingArt, true);
  assert.equal(reboot.state.rows[0].art.logo.file, 'C:/missing/logo.png');
  assert.equal(writes, 0);
  vm.runInContext('log = () => {}', reboot.context);
  await vm.runInContext('writeArtwork(S.rows, [])', reboot.context);
  const again = renderer(api);
  again.state.cfg = structuredClone(disk);
  await vm.runInContext('syncSteamLibrary([], [{ appid: 123, name: "Game" }])', again.context);
  assert.deepEqual(Object.keys(again.state.rows[0].art), ['logo']);
  again.state.cfg.steam_user_id = '2';
  await vm.runInContext('syncSteamLibrary([], [{ appid: 123, name: "Game" }])', again.context);
  assert.equal(again.state.rows[0].pendingArt, false);
  assert.deepEqual(Object.keys(again.state.rows[0].art), []);
  again.state.cfg.steam_user_id = '1';
  await vm.runInContext('syncSteamLibrary([], [{ appid: 123, name: "Game" }])', again.context);
  assert.deepEqual(Object.keys(again.state.rows[0].art), ['logo']);
  await vm.runInContext('saveSteamDrafts([], S.rows.map(steamDraftKey))', again.context);
  const cleared = renderer(api);
  cleared.state.cfg = structuredClone(disk);
  await vm.runInContext('syncSteamLibrary([], [{ appid: 123, name: "Game" }])', cleared.context);
  assert.equal(cleared.state.rows[0].pendingArt, false);
  assert.equal(writes, 1);
});

it('blocks Clear while the library is busy', async () => {
  let confirms = 0;
  let reads = 0;
  const { context, state } = renderer({ steamRead: async () => { reads++; return []; } });
  context.confirmDlg = () => { confirms++; return Promise.resolve(true); };
  for (const busy of ['applyingSteam', 'loadingLibrary']) {
    state[busy] = true;
    await vm.runInContext('doClear()', context);
    state[busy] = false;
  }
  assert.equal(confirms, 0);
  assert.equal(reads, 0);
});

it('refreshes the cover when switching back to the exe icon', async () => {
  const requests = [];
  const { context } = renderer({ desktopIcon: async (file, index) => { requests.push([file, index]); return file; } });
  context.game = { id: 'desktop:game', exe: 'game.exe', icon: 'custom.dll', iconIndex: 2, signature: 'before' };
  const token = () => vm.runInContext('desktopCoverToken(game)', context);
  const original = token();
  assert.equal(await vm.runInContext('desktopCardCoverSource(game)', context), 'custom.dll');
  context.game.iconChoice = { exeIcon: true };
  assert.notEqual(token(), original);
  assert.equal(await vm.runInContext('desktopCardCoverSource(game)', context), 'game.exe');
  assert.deepEqual(requests, [['custom.dll', 2], ['game.exe', undefined]]);
  delete context.game.iconChoice;
  context.game.iconIndex = 3;
  assert.notEqual(token(), original);
  context.game.iconIndex = 2;
  context.game.signature = 'after';
  assert.notEqual(token(), original);
});

it('uses default sizes unless sizes were explicitly chosen', () => {
  const { context, state } = renderer({});
  state.cfg = { artwork_filters: { static: false, animated: true, nsfw: true } };
  state.modal = { row: { source: 'steam' }, typeFilters: {} };
  const dimensions = kind => Array.from(vm.runInContext(`pickerFilters('${kind}').dimensions || []`, context));
  assert.deepEqual(dimensions('grid'), ['600x900', '342x482', '660x930']);
  assert.deepEqual(dimensions('wide'), ['460x215', '920x430']);
  assert.deepEqual(dimensions('hero'), ['1920x620', '3840x1240', '1600x650']);
  assert.deepEqual(dimensions('logo'), []);
  assert.ok(dimensions('icon').includes('256'));
  state.modal.typeFilters.grid = { dimensions: ['512x512'] };
  assert.deepEqual(dimensions('grid'), ['512x512']);
  state.modal.typeFilters.grid.dimensions = [];
  assert.deepEqual(dimensions('grid'), []);
  for (const kind of ['grid', 'wide', 'hero', 'logo', 'icon']) {
    assert.equal(vm.runInContext(`pickerFilters('${kind}').animated`, context), true);
    assert.equal(vm.runInContext(`pickerFilters('${kind}').nsfw`, context), true);
  }
  state.modal = { row: { source: 'desktop' }, typeFilters: {} };
  assert.deepEqual(dimensions('grid'), ['600x900', '342x482', '660x930']);
  assert.equal(vm.runInContext("pickerFilters('icon').animated", context), false);
});

it('uses a suggested cover without setting the native game match', async () => {
  let saved;
  const { context, state } = renderer({
    artCurrent: async () => ({ file: 'unreadable.png' }),
    artThumbnail: async () => { throw new Error('cannot decode'); },
    artPreviewFile: async () => { throw new Error('missing file'); },
    sgdbBySteam: async id => { assert.equal(id, 123); return { id: 7 }; },
    artList: async () => [{ thumb: 'https://test.invalid/thumb', url: 'https://test.invalid/full' }],
    coverCacheGet: async () => null,
    coverCachePut: async req => { saved = req; return true; },
  });
  state.cfg = { api_key: 'fixture' };
  context.game = { source: 'steam', steamAppid: 123, art: {} };
  const cover = await vm.runInContext('cardCoverSource(game)', context);
  assert.equal(cover.src, 'https://test.invalid/thumb');
  assert.equal(cover.fallback, 'https://test.invalid/full');
  assert.equal(context.game.sgdbId, undefined);
  assert.equal(saved.sgdbId, 7);
  assert.equal(saved.appid, 123);
});

it('refreshes matched covers online and uses the cache without a key', async () => {
  const cached = { src: 'https://test.invalid/saved', fallback: null };
  const { context, state } = renderer({
    artCurrent: async () => null,
    coverCacheGet: async req => { assert.equal(req.sgdbId, 7); return cached; },
    coverCachePut: async () => true,
    artList: async () => [{ thumb: 'https://test.invalid/fresh', url: 'https://test.invalid/full' }],
  });
  context.game = { source: 'shortcut', sgdbId: 7, art: {} };
  state.cfg = { api_key: '' };
  const cover = () => vm.runInContext('cardCoverSource(game)', context);
  assert.deepEqual(await cover(), cached);
  state.cfg.api_key = 'fixture';
  assert.equal((await cover()).src, 'https://test.invalid/fresh');
});

it('shows saved covers without reselecting them', async () => {
  const { context } = renderer({
    artThumbnail: async file => { assert.equal(file, 'applied-grid.png'); return 'data:image/png;base64,saved'; },
    artCurrent: async () => { throw new Error('should use the known saved image'); },
  });
  context.game = { source: 'steam', art: { grid: { id: 9, thumb: 'https://test.invalid/thumb',
    url: 'https://test.invalid/full', appliedFile: 'applied-grid.png' } } };
  assert.equal(await vm.runInContext('cardCoverSource(game)', context), 'data:image/png;base64,saved');
});

it('keeps the Desktop name when changing its matched icon', async () => {
  const { context, state } = renderer({});
  context.matchMedia = () => ({ matches: true });
  context.document.querySelector = () => ({ getAnimations: () => [], classList: { remove() {} } });
  vm.runInContext('renderDesktop = restoreArtFocus = () => {}; saveDesktopDraft = async () => {}; handleAction = (_label, fn) => fn;', context);
  const row = { source: 'desktop', display: 'My variant', sgdbId: 7 };
  const select = async (id, name) => {
    state.modal = { row, sel: { icon: { file: 'chosen.ico' } }, sgdbId: id, games: [{ id, name }] };
    await vm.runInContext('closeArtModal(true)', context);
  };
  await select(7, '(cached)');
  assert.equal(row.display, 'My variant');
  assert.equal(row.iconChoice.file, 'chosen.ico');
  await select(8, 'New matched game');
  assert.equal(row.display, 'New matched game');
  assert.equal(row.sgdbId, 8);
});

it('keeps cover placeholders until loaded and retries failures', async () => {
  let requests = 0;
  const { context, state } = renderer({
    desktopIcon: async () => { requests++; return 'data:image/png;base64,fixture'; },
  });
  const image = { isConnected: true, hidden: true, dataset: { coverToken: 'desktop:fixture' } };
  const placeholder = { hidden: false };
  context.card = { isConnected: true, querySelector: selector => selector === '.game-cover' ? image : placeholder };
  context.game = { source: 'desktop', exe: 'game.exe', iconChoice: { exeIcon: true } };
  vm.runInContext('loadCardCover(game, card)', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(image.hidden, true);
  assert.equal(placeholder.hidden, false);
  image.onload();
  assert.equal(image.hidden, false);
  assert.equal(placeholder.hidden, true);
  image.onerror();
  assert.equal(image.hidden, true);
  assert.equal(placeholder.hidden, false);
  assert.equal(state.cardArtCache.size, 0);
  vm.runInContext('loadCardCover(game, card)', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests, 2);
});

it('ignores artwork searches that finish out of order', async () => {
  const pending = [];
  const { context, state } = renderer({ sgdbSearch: () => new Promise(resolve => pending.push(resolve)) });
  const fields = { '#art-q': { value: 'old' }, '#art-matches': {}, '#art-games': { appendChild() {} }, '#art-id': {}, '#art-status': {} };
  context.document.querySelector = selector => fields[selector];
  context.document.createElement = () => ({});
  vm.runInContext('loadArtTabs = async () => {}; renderChoiceList = () => {};', context);
  state.cfg = { api_key: 'fixture' };
  state.modal = {};
  const older = vm.runInContext('artSearch()', context);
  fields['#art-q'].value = 'new';
  const newer = vm.runInContext('artSearch(true)', context);
  pending[1]([{ id: 22, name: 'New match' }, { id: 23, name: 'Another match' }]);
  await newer;
  pending[0]([{ id: 11, name: 'Old match' }]);
  await older;
  assert.equal(fields['#art-id'].value, '22');
  assert.equal(fields['#art-games'].value, '22');
  assert.equal(fields['#art-matches'].hidden, false);
  const lastSearch = vm.runInContext('artSearch()', context);
  fields['#art-id'].value = '88';
  await vm.runInContext('artLoadId()', context);
  pending[2]([{ id: 11, name: 'Old match' }]);
  await lastSearch;
  assert.equal(state.modal.sgdbId, 88);
  assert.equal(fields['#art-id'].value, '88');
  assert.equal(fields['#art-matches'].hidden, true);
});

it('allows updates to existing managed shortcuts', () => {
  const { context } = renderer({});
  assert.equal(vm.runInContext("canWriteShortcut({source:'shortcut', exe:'game.exe', managed:true})", context), true);
  assert.equal(vm.runInContext("canWriteShortcut({source:'shortcut', exe:'game.exe', managed:false})", context), false);
  assert.equal(vm.runInContext("canWriteShortcut({source:'shortcut', exe:null, managed:true})", context), false);
});

it('keeps Desktop matches without marking them as pending', async () => {
  const rows = [1, 2].map(id => ({ id, display: 'Game ' + id, exe: `game${id}.exe`, signature: 'same' }));
  const { context, state } = renderer({ desktopScan: async () => ({ rows, warnings: [] }), cfgSet: async patch => ({ ...state.cfg, ...patch }) });
  vm.runInContext('renderDesktop = status = applyTheme = () => {};', context);
  state.cfg = { games_roots: [], desktop_overrides: {
    1: { display: 'Saved game', exe: 'game1.exe', sgdbId: 7, sgdbName: 'Matched title', signature: 'same' },
    2: { display: 'Edited game', exe: 'game2.exe', args: '', signature: 'same', iconChoice: { file: 'chosen.ico' } },
  } };
  await vm.runInContext('refreshDesktop()', context);
  assert.equal(state.desktop.rows[0].display, 'Saved game');
  assert.equal(state.desktop.rows[0].sgdbId, 7);
  assert.equal(state.desktop.rows[0].draft, null);
  assert.equal(state.desktop.rows[2].draft.iconChoice.file, 'chosen.ico');
  rows[1].signature = 'external edit';
  await vm.runInContext('refreshDesktop()', context);
  assert.equal(state.desktop.rows[0].sgdbId, 7);
  assert.equal(state.desktop.rows[2].draft.iconChoice.file, 'chosen.ico');
  rows[0].signature = 'external arguments';
  await vm.runInContext('refreshDesktop()', context);
  assert.equal(state.desktop.rows[0].sgdbId, 7);
  assert.equal(state.desktop.rows[0].draft, null);
  rows[0].exe = 'another-game.exe';
  await vm.runInContext('refreshDesktop()', context);
  assert.equal(state.desktop.rows[0].sgdbId, undefined);
});

it('pairs alternate launchers without duplicate game cards', () => {
  const { context, state } = renderer({});
  context.rows = [
    { id: 'desktop-link', exePath: 'game.exe', exe: 'launcher.exe', display: 'Game', shortcut: 'Desktop/Game.lnk', destination: 'desktop' },
    { id: 'missing-menu', exePath: 'game.exe', exe: 'game.exe', display: 'Game', destination: 'start-menu' },
  ];
  state.desktop.groups = vm.runInContext('groupDesktopDestinations(rows)', context);
  state.desktop.rows = state.desktop.groups.flat();
  assert.equal(state.desktop.groups.length, 1);
  const payload = vm.runInContext('desktopApplyRows(desktopCards())', context);
  assert.equal(payload.length, 2);
  assert.equal(payload.filter(row => !row.shortcut).length, 1);
  assert.ok(payload.every(row => row.exe === 'launcher.exe'));
  context.members = state.desktop.rows;
  assert.equal(vm.runInContext('desktopLocationState(members)', context), 'Desktop only');
  context.members[0].destination = 'start-menu';
  assert.equal(vm.runInContext('desktopLocationState(members)', context), 'Start menu only');
  context.members[1].shortcut = 'Desktop/Game.lnk';
  assert.equal(vm.runInContext('desktopLocationState(members)', context), 'Existing');
});

it('recovers shortcut names previously saved as cached', async () => {
  const row = { id: 'link:cached', display: '(cached)', query: 'Resolved game', exe: 'game.exe',
    shortcut: 'Desktop/(cached).lnk', signature: 'original' };
  const { context, state } = renderer({ desktopScan: async () => ({ rows: [row], warnings: [] }) });
  vm.runInContext('renderDesktop = status = applyTheme = () => {};', context);
  state.cfg = { games_roots: [], desktop_overrides: { [row.id]: {
    display: '(cached)', sgdbId: 7, sgdbName: '(cached)', signature: 'original',
  } } };
  await vm.runInContext('refreshDesktop()', context);
  const recovered = state.desktop.rows[0];
  assert.equal(recovered.display, 'Resolved game');
  assert.equal(recovered.draft.display, 'Resolved game');
  assert.equal(recovered.shortcut, row.shortcut);
  assert.equal(recovered.signature, row.signature);
  assert.equal(recovered.sgdbId, 7);
});

it('does not add games when the saved Steam path is gone', async () => {
  let adds = 0;
  const { context, state } = renderer({
    steamVerify: async () => false,
    steamAdd: async () => {
      adds++;
      return { rows: [], lines: [], added: 0, updated: 0, artworkSaved: 0 };
    },
  });
  vm.runInContext('updateLibrarySelection = () => {}; toast = (message) => { globalThis.toastMessage = message; };', context);
  state.cfg = { steam_path: 'C:/Gone' };
  state.rows = [{ source: 'folder', folder: 'one', display: 'One', exe: 'one.exe', art: {} }];
  await vm.runInContext('doAddToSteam()', context);
  assert.equal(adds, 0);
  assert.equal(state.applyingSteam, false);
  assert.match(context.toastMessage, /Steam was not found at the saved path/);
});

it('warns about missing Steam paths but still refreshes', async () => {
  let reads = 0;
  const { context, state, refresh } = renderer({
    steamVerify: async () => false,
    steamRead: async () => { reads++; return []; },
    steamGames: async () => [],
  });
  vm.runInContext('toast = (message) => { globalThis.toastMessage = message; };', context);
  state.cfg = { steam_path: 'C:/Gone', games_roots: [] };
  await refresh();
  assert.equal(reads, 1);
  assert.match(context.toastMessage, /Steam was not found at the saved path/);
});

it('applies artwork to several native Steam games at once', async () => {
  const calls = [];
  const { context, state } = renderer({
    artDownload: async (req) => {
      calls.push(req);
      return { rows: req.rows.map((row) => ({ ...row, art: { ...row.art }, appliedKinds: ['grid'] })),
        saved: req.rows.length, failed: 0, lines: [] };
    },
  });
  vm.runInContext('updateLibrarySelection = status = log = toast = reportArtwork = () => {}; confirmDlg = async () => true;', context);
  state.cfg = {};
  state.rows = [
    { source: 'steam', folder: 'steam:1', steamAppid: 1, display: 'One', pendingArt: true, art: { grid: { url: 'one' } } },
    { source: 'steam', folder: 'steam:2', steamAppid: 2, display: 'Two', pendingArt: true, art: { grid: { url: 'two' } } },
  ];
  await vm.runInContext('doAddToSteam(S.rows, { reviewed: true })', context);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].rows.map((row) => row.display), ['One', 'Two']);
  assert.equal(calls[0].kinds.length, 0);
});

it('loads saved Steam shortcut matches on a fresh start', async () => {
  const { context, state, refresh } = renderer({
    steamRead: async () => [{ exe: 'game.exe', appid: 10, index: 0, appName: 'Game', managed: true }],
    steamGames: async () => [], resolveName: async () => null,
  });
  const key = vm.runInContext('folderKey("shortcut://10")', context);
  state.cfg = { games_roots: [], sgdb_cache: { [key]: 7 } };
  await refresh();
  assert.equal(state.rows[0].sgdbId, 7);
  assert.equal(state.rows[0].sgdbName, '(cached)');
});

it('loads the active art tab once and ignores stale replies', async () => {
  const requests = [];
  const { context, state, button } = renderer({ artList: req => new Promise(resolve => requests.push({ req, resolve })) });
  vm.runInContext('globalThis.renders = []; renderArtGrid = (...args) => renders.push(args);', context);
  state.cfg = { api_key: 'fixture' };
  state.modal = { sgdbId: 7, tab: 'grid', row: {}, cache: {} };
  const first = vm.runInContext('loadArtTabs()', context);
  const repeated = vm.runInContext('loadArtTabs()', context);
  assert.equal(requests.length, 1);
  state.modal.tab = 'hero';
  const hero = vm.runInContext('loadArtTabs()', context);
  requests[1].resolve([{ url: 'hero' }]);
  await hero;
  const rendered = context.renders.length;
  requests[0].resolve([{ url: 'grid' }]);
  await Promise.all([first, repeated]);
  assert.equal(context.renders.length, rendered);
  assert.match(button.textContent, /1 images/);
  state.modal.tab = 'grid';
  await vm.runInContext('loadArtTabs()', context);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ req }) => [req.kind, req.page]), [['grid', 0], ['hero', 0]]);
});

it('shuffles later artwork pages without repeating or replacing manual choices', async () => {
  const pages = [];
  const { context, state } = renderer({
    artCurrent: async () => null,
    artList: async ({ sgdbId, kind, page }) => {
      assert.equal(kind, 'grid');
      pages.push([sgdbId, page]);
      if (sgdbId === 8) return [{ url: 'new-match' }];
      return page === 0 ? Array.from({ length: 30 }, (_, i) => ({ url: i ? 'b' : 'a' })) : [{ url: 'c' }];
    },
  });
  vm.runInContext('renderArtTabs = () => {}; loadArtTabs = async () => {};', context);
  state.cfg = { api_key: 'fixture' };
  const manual = { url: 'manual' };
  const modal = state.modal = { sgdbId: 7, row: { source: 'steam' }, games: [], finderClicks: 0,
    sel: { wide: manual, hero: manual, logo: manual, icon: manual } };
  const click = () => vm.runInContext('findArtworkForGame()', context);
  for (const expected of ['a', 'b', 'c']) {
    await click();
    assert.equal(modal.sel.grid.url, expected);
  }
  assert.deepEqual(pages, [[7, 0], [7, 1]]);
  await click();
  assert.notEqual(modal.sel.grid.url, 'c');
  modal.sgdbId = 8;
  await click();
  assert.equal(modal.sel.grid.url, 'new-match');
  assert.equal(modal.sel.hero, manual);
  modal.sel.grid = manual;
  modal.sgdbId = 9;
  await click();
  assert.equal(modal.sel.grid, manual);
  assert.equal(modal.sel.hero, manual);
  assert.deepEqual(pages, [[7, 0], [7, 1], [8, 0]]);
});

it('finds another Windows icon after a manual pick', async () => {
  const manual = { id: 1, url: 'manual' };
  const alternative = { id: 2, url: 'alternative' };
  const { context, state } = renderer({ artList: async () => [manual, alternative] });
  vm.runInContext('renderArtTabs = () => {}; loadArtTabs = async () => {};', context);
  state.cfg = { api_key: 'fixture' };
  const modal = state.modal = { sgdbId: 7, row: { source: 'desktop', iconChoice: manual }, games: [],
    finderClicks: 0, sel: { icon: manual } };
  await vm.runInContext('findArtworkForGame()', context);
  assert.equal(modal.sel.icon, alternative);
});

it('loosens finder filters after empty results while keeping content restrictions', async () => {
  const requests = [];
  const { context, state } = renderer({ artList: async ({ filters }) => {
    requests.push(filters);
    return filters.static ? [{ url: 'fallback' }] : [];
  } });
  state.cfg = {};
  const choice = await vm.runInContext(`finderChoice({ sgdbId: 7, kind: 'hero', filters: {
    static: false, animated: true, nsfw: false, humor: false, dimensions: ['3840x1240'], styles: ['blurred'],
  } })`, context);
  assert.equal(choice.item.url, 'fallback');
  assert.equal(requests.length, 3);
  assert.deepEqual(Array.from(requests[0].dimensions), ['3840x1240']);
  assert.equal(requests[1].styles, undefined);
  assert.equal(requests[1].static, false);
  assert.equal(requests[2].static, true);
  assert.ok(requests.every(({ nsfw, humor }) => nsfw === false && humor === false));
});

it('keeps a shortcut choice when Steam refreshes its name', async () => {
  const shortcut = { source: 'shortcut', exe: 'game.exe', sgdbId: 5, art: { hero: 'chosen' } };
  const { state, refresh } = renderer({
    steamRead: async () => [{ exe: shortcut.exe, appName: 'Renamed', appid: 20, index: 0 }],
    steamGames: async () => [],
  });
  state.cfg = { games_roots: [] };
  state.rows = [shortcut, { source: 'steam', display: 'Removed game' }];
  await refresh();
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].display, 'Renamed');
  assert.equal(state.rows[0].sgdbId, 5);
  assert.equal(state.rows[0].art.hero, 'chosen');
});

it('dedupes exact exes and keeps nearby games and saved choices', async () => {
  const { context, state } = renderer({ resolveName: async () => null });
  const scope = JSON.stringify(['c:\\steam', '1']);
  state.cfg = { steam_path: 'C:/Steam', steam_user_id: '1', sgdb_map: {}, sgdb_cache: {},
    steam_art_drafts: { [scope]: { 'exe:d:\\games\\one\\game.exe': {
      art: { grid: { url: 'saved-grid' } }, sgdbId: 7,
    } } } };
  const before = JSON.stringify(state.cfg);
  state.rows = [
    { source: 'folder', folder: 'D:/Games/One', exe: 'D:/Games/One/game.exe', art: {},
      candidates: [{ path: 'D:/Games/One/game.exe' }, { path: 'D:/Games/One/launcher.exe' }] },
    { source: 'folder', folder: 'D:/Games', exe: 'D:/Games/other.exe', art: {} },
    { source: 'folder', folder: 'D:/Games/One', exe: 'D:/Games/One/other.exe', art: {} },
  ];
  context.entries = [{ exe: '"d:\\GAMES\\one\\GAME.exe"', appName: 'Steam name', appid: 10, startDir: 'D:/Games' }];
  await vm.runInContext('syncSteamLibrary(entries, [])', context);
  assert.equal(state.rows.length, 3);
  const owner = state.rows.find(row => row.source === 'shortcut');
  assert.equal(owner.display, 'Steam name');
  assert.equal(owner.pendingArt, true);
  assert.equal(owner.art.grid.url, 'saved-grid');
  assert.equal(owner.sgdbId, 7);
  assert.deepEqual(Array.from(owner.candidates, candidate => candidate.path),
    ['d:\\GAMES\\one\\GAME.exe', 'D:/Games/One/launcher.exe']);
  assert.equal(JSON.stringify(state.cfg), before);
  // A later launch without scan roots still finds the original executable-keyed draft.
  state.rows = [];
  await vm.runInContext('syncSteamLibrary(entries, [])', context);
  assert.equal(state.rows[0].art.grid.url, 'saved-grid');
  assert.equal(JSON.stringify(state.cfg), before);
});

it('dedupes native folders and restores drafts without roots', async () => {
  const scope = JSON.stringify(['c:\\steam', '1']);
  const originalKey = 'exe:d:\\steamlibrary\\steamapps\\common\\onimushawots\\onimushawots.exe';
  let disk = { steam_path: 'C:/Steam', steam_user_id: '1', sgdb_map: {}, sgdb_cache: {},
    steam_art_drafts: { [scope]: { [originalKey]: {
      art: { grid: { url: 'saved-grid' }, logo: { file: 'chosen-logo.png' } }, sgdbId: 7,
    } } } };
  const { context, state } = renderer({
    cfgGet: async () => structuredClone(disk),
    steamDraftsSave: async ({ scope, updates }) => {
      for (const [key, draft] of Object.entries(updates)) {
        if (draft) disk.steam_art_drafts[scope][key] = structuredClone(draft);
        else delete disk.steam_art_drafts[scope][key];
      }
    },
  });
  state.cfg = structuredClone(disk);
  const root = 'D:/SteamLibrary/steamapps/common/OnimushaWotS';
  context.installed = [{ appid: 2638890, name: 'Onimusha: Way of the Sword', installdir: root }];
  state.rows = [
    { source: 'folder', folder: root, display: 'OnimushaWotS', exe: `${root}/OnimushaWotS.exe`, art: {} },
    { source: 'folder', folder: `${root}/Tool`, exe: `${root}/Tool/other.exe`, art: {} },
    { source: 'folder', folder: `${root}2`, exe: `${root}2/game.exe`, art: {} },
    { source: 'folder', folder: 'D:/Games/OnimushaWotS', exe: 'D:/Games/OnimushaWotS/game.exe', art: {} },
  ];
  const before = JSON.stringify(state.cfg);
  await vm.runInContext('syncSteamLibrary([], installed)', context);
  assert.equal(state.rows.length, 3);
  assert.equal(state.rows.filter(r => r.source === 'folder').length, 2);
  assert.equal(JSON.stringify(state.cfg), before);
  // Closing/reopening with no scanned rows still restores the old executable-keyed choices.
  state.rows = [];
  await vm.runInContext('syncSteamLibrary([], installed)', context);
  assert.equal(state.rows[0].art.grid.url, 'saved-grid');
  assert.equal(state.rows[0].pendingArt, true);
  // Saving/clearing native choices consumes the alias so stale choices cannot return later.
  await vm.runInContext('saveSteamDrafts(S.rows)', context);
  assert.equal(disk.steam_art_drafts[scope][originalKey], undefined);
  assert.equal(disk.steam_art_drafts[scope]['steam:2638890'].art.logo.file, 'chosen-logo.png');
  await vm.runInContext('saveSteamDrafts([], S.rows.flatMap(steamDraftKeys))', context);
  state.rows = [];
  await vm.runInContext('syncSteamLibrary([], installed)', context);
  assert.equal(state.rows[0].pendingArt, false);
  assert.deepEqual(Object.keys(state.rows[0].art), []);
});

it('keeps the list on read failure and re-enables Refresh', async () => {
  const { state, refresh, button } = renderer({
    steamRead: async () => { throw new Error('read failed'); }, steamGames: async () => [],
  });
  const rows = [{ source: 'folder', exe: 'game.exe' }];
  state.cfg = { games_roots: [] };
  state.rows = rows;
  await assert.rejects(refresh(), /read failed/);
  assert.equal(state.rows, rows);
  assert.equal(button.disabled, false);
});

it('drops scanned rows when no game folders remain', async () => {
  const { state, refresh } = renderer({ steamRead: async () => [], steamGames: async () => [] });
  state.cfg = { games_roots: [] };
  state.rows = [{ source: 'folder', folder: 'removed', exe: 'game.exe' }];
  await refresh();
  assert.equal(state.rows.length, 0);
});

it('reuses library loads until settings change or Refresh', async () => {
  let scans = 0;
  const { context, state, refresh } = renderer({
    scanStart: async () => { scans++; return []; },
    steamRead: async () => [], steamGames: async () => [],
  });
  state.cfg = { games_roots: ['games'], folder_depths: {}, steam_user_id: '1' };
  await vm.runInContext('Promise.all([loadLibrary(), loadLibrary()])', context);
  assert.equal(scans, 1);
  await vm.runInContext('loadLibrary()', context);
  assert.equal(scans, 1);
  state.cfg.folder_depths = { games: 2 };
  await vm.runInContext('loadLibrary()', context);
  assert.equal(scans, 2);
  state.cfg.steam_user_id = '2';
  await vm.runInContext('loadLibrary()', context);
  assert.equal(scans, 3);
  await refresh();
  assert.equal(scans, 4);
});

it('keeps native artwork by AppID when games share a name', async () => {
  const { state, refresh } = renderer({
    steamRead: async () => [], steamGames: async () => [{ appid: 1, name: 'Renamed game' }, { appid: 2, name: 'Game' }],
  });
  state.cfg = { games_roots: [], sgdb_map: {}, sgdb_cache: {} };
  state.rows = [{ source: 'steam', steamAppid: 1, display: 'Game', sgdbId: 7, pendingArt: true, art: { grid: 'chosen' } },
    { source: 'steam', steamAppid: 2, display: 'Game', art: {} }];
  await refresh();
  assert.equal(state.rows[0].sgdbId, 7);
  assert.equal(state.rows[0].art.grid, 'chosen');
  assert.equal(state.rows[0].pendingArt, true);
  assert.equal(Object.keys(state.rows[1].art).length, 0);
});

it('keeps paired icon drafts unchanged when saving fails', async () => {
  const { context, state } = renderer({ cfgSet: async () => { throw new Error('disk full'); } });
  state.cfg = { desktop_overrides: {} };
  const first = { id: 'one', display: 'Game', iconChoice: { file: 'old.ico' }, signature: 'one' };
  const second = { ...first, id: 'two', signature: 'two' };
  state.desktop.rows = [first, second]; state.desktop.groups = [[first, second]];
  context.first = first;
  await assert.rejects(vm.runInContext("saveDesktopDraft(first, { ...first, iconChoice: { file: 'new.ico' } })", context), /disk full/);
  assert.equal(first.iconChoice.file, 'old.ico');
  assert.equal(second.iconChoice.file, 'old.ico');
  assert.equal(first.draft, undefined);
  assert.equal(second.draft, undefined);
});


it('selects saved edits but leaves missing shortcuts unchecked', () => {
  const view = renderer({});
  view.state.cfg = {};
  const missing = { source: 'folder', exe: 'new.exe' };
  const edited = { source: 'folder', exe: 'edited.exe', pendingDetails: true };
  view.state.rows = [missing, edited];
  view.context.document.querySelector = () => ({ showModal() {} });
  vm.runInContext('renderReview = () => {}; openReview("library");', view.context);
  assert.deepEqual(Array.from(view.state.review.rows), [edited, missing]);
  assert.deepEqual([...view.state.review.included], [edited]);
});

it('shares Windows choices across destinations and restart', async () => {
  let disk = { games_roots: [], desktop_destination: 'desktop', desktop_overrides: {}, desktop_choices: {} };
  let scans = 0;
  const rows = ['desktop', 'start-menu'].map(destination => ({
    id: destination, destination, shortcut: `${destination}/Game.lnk`, signature: destination,
    exe: 'C:/Games/game.exe', display: destination + ' game', args: '-' + destination, icon: '', iconIndex: 0,
  }));
  const api = {
    desktopScan: async () => { scans++; return { rows: structuredClone(rows), warnings: [] }; },
    cfgSet: async patch => (disk = { ...disk, ...structuredClone(patch) }),
  };
  const load = async () => {
    const view = renderer(api);
    view.state.cfg = structuredClone(disk);
    view.run = code => vm.runInContext(code, view.context);
    view.run('renderDesktop = status = applyTheme = () => {};');
    await view.run('refreshDesktop(false)');
    return view;
  };
  let view = await load();
  view.context.game = view.state.desktop.rows[0];
  await view.run("saveDesktopDraft(game, { ...game, display: 'Chosen name', args: '-chosen', iconChoice: { file: 'chosen.ico' } })");
  assert.equal(Object.keys(disk.desktop_choices).length, 1);
  assert.equal(Object.keys(disk.desktop_overrides).length, 0);
  for (const restart of [false, true]) {
    if (restart) view = await load();
    const original = view.state.desktop.rows[0], scansBefore = scans;
    for (const destination of ['both', 'start-menu', 'desktop']) {
      view.state.cfg.desktop_destination = destination;
      await view.run('refreshDesktop(false)');
      assert.equal(view.state.desktop.rows[0], original);
      const payload = view.run('desktopApplyRows(desktopCards())');
      assert.deepEqual(Array.from(payload, row => [row.destination, row.signature, row.display, row.args, row.iconChoice.file]),
        (destination === 'both' ? ['desktop', 'start-menu'] : [destination])
          .map(target => [target, target, 'Chosen name', '-chosen', 'chosen.ico']));
    }
    assert.equal(scans, scansBefore);
  }
  disk.desktop_overrides.desktop = { signature: 'desktop', choiceRevision: 1 };
  view = await load();
  assert.equal(view.state.desktop.rows[0].draft, null);
  assert.ok(view.state.desktop.rows[1].draft);
  assert.equal(view.state.desktop.rows[0].iconChoice.file, 'chosen.ico');
  for (const destination of ['desktop', 'start-menu']) {
    view.state.cfg.desktop_destination = destination;
    assert.equal(view.run("reviewCandidates('desktop').length"), destination === 'desktop' ? 0 : 1);
  }
});
