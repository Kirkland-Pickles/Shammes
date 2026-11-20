'use strict';
/* library and settings ui */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wrapText = (s) => esc(s).replace(/([a-z\d])([A-Z])/g, '$1<wbr>$2')
  .replace(/([A-Z])([A-Z][a-z])/g, '$1<wbr>$2').replace(/([._-])/g, '<wbr>$1');
const fmtMB = (b) => (b >= 1024 * 1024 * 1024 ? `${(b / 1073741824).toFixed(1)} GB`
  : `${Math.max(1, Math.round(b / 1048576))} MB`);
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const folderKey = (p) => String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
function parentDir(p) {
  const value = String(p || '').replace(/[\\/]+$/, '');
  const cut = Math.max(value.lastIndexOf('\\'), value.lastIndexOf('/'));
  if (cut < 0) return '';
  return cut === 2 && /^[a-z]:/i.test(value) ? value.slice(0, 3) : value.slice(0, cut);
}
const S = {
  cfg: null,
  rows: [],
  steamUsers: [],
  filter: '',
  nonSteamOnly: false,
  hideOwned: false,
  ownedAppids: new Set(), // Steam appids installed for the user (hide-owned filter)
  previewCache: {},         // sgdbId -> saved cover source
  modal: null,              // artwork picker state
  exePicker: null,
  cardArtCache: new Map(),
  coverObserver: null,
  desktop: { rows: [], busy: false, coverObserver: null },
};

const steamEditorRow = () => S.modal?.row.source !== 'desktop' ? S.modal?.row : null;

// ------------------------------------------------------------------ log/ui
function log(line, library = 'library') {
  const key = library === 'settings' ? libraryView() : library === 'desktop' ? 'desktop' : 'library';
  const entry = `[${new Date().toLocaleTimeString('en-GB', { hour12: false })}] ${String(line)}`;
  (S.logs ||= { library: [], desktop: [] })[key].push(entry);
  if (libraryView() !== key) return;
  const box = $('#log');
  const div = document.createElement('div');
  div.textContent = entry;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
  return div;
}
function renderLog() {
  const box = $('#log');
  box.replaceChildren(...(S.logs?.[libraryView()] || []).map(line => {
    const div = document.createElement('div');
    div.textContent = line;
    return div;
  }));
  box.scrollTop = box.scrollHeight;
}
function status(t) { $('#status').textContent = t; }
function setBar(cur_, total) {
  $('#fill').style.transform = `scaleX(${total > 0 ? cur_ / total : 0})`;
  // Hide bar when there's no job
  const wrap = $('#progwrap');
  if (wrap) wrap.hidden = !(total > 0);
}
const TOAST_FLIGHT_DELAY = 800;
const TOAST_FLIGHT_MS = 520;

// Clone an element, fly it into a target, then remove the clone.
function flyClone(source, target, className, duration) {
  const from = source.getBoundingClientRect();
  const to = target.getBoundingClientRect();
  if (!from.width || !from.height || !to.width || !to.height) return null;

  const ghost = source.cloneNode(true);
  ghost.removeAttribute('id');
  ghost.removeAttribute('role');
  ghost.removeAttribute('aria-live');
  ghost.setAttribute('aria-hidden', 'true');
  ghost.className = className;
  Object.assign(ghost.style, {
    left: `${from.left}px`,
    top: `${from.top}px`,
    width: `${from.width}px`,
    height: `${from.height}px`,
  });
  document.body.appendChild(ghost);

  const dx = to.left + to.width / 2 - (from.left + from.width / 2);
  const dy = to.top + to.height / 2 - (from.top + from.height / 2);
  const anim = ghost.animate([
    { transform: 'translate(0, 0) scale(1)', opacity: 1 },
    { transform: `translate(${dx}px, ${dy}px) scale(.2)`, opacity: 0 },
  ], {
    duration,
    easing: 'cubic-bezier(.4, 0, .2, 1)',
    fill: 'forwards',
  });
  anim.finished.catch(() => {}).finally(() => ghost.remove());
  return ghost;
}

function clearToastFlight(t) {
  if (t?._fly) clearTimeout(t._fly);
  if (t) t._fly = null;
  $$('.toast-ghost').forEach((g) => {
    g.getAnimations().forEach((a) => a.cancel());
    g.remove();
  });
}

function flyToastToLog(t) {
  t._fly = null;
  const dock = $('#bottomdock');
  if (!t.isConnected || !dock || !dock.classList.contains('collapsed')
    || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const target = $('#dock-toggle') || $('#statusbar');
  if (!target || !flyClone(t, target, 'toast-ghost', TOAST_FLIGHT_MS)) return;
  t.style.visibility = 'hidden';
  t.classList.remove('show');
}

function toast(msg, logEntry) {
  const t = $('#toast');
  const dialog = $$('dialog[open]').at(-1);
  const host = dialog || document.body;
  if (t.parentElement !== host) host.appendChild(t);
  clearToastFlight(t);
  t.textContent = msg;
  t.style.visibility = '';
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 3200);
  t.classList.add('show');
  const dock = $('#bottomdock');
  if (!dialog && dock?.classList.contains('collapsed') && logEntry?.textContent.endsWith(`] ${msg}`)) {
    t._fly = setTimeout(() => {
      if (logEntry.isConnected) flyToastToLog(t);
    }, TOAST_FLIGHT_DELAY);
  }
}
function handleAction(name, fn) {
  return () => {
    const library = libraryView();
    return fn().catch((e) => {
      const message = e?.message || String(e);
      setBar(0, 0);
      const feedback = `${name} failed: ${message}`;
      status(`${name} failed.`);
      toast(feedback, log(feedback, library));
    });
  };
}
function confirmDlg(title, body, opts = {}) {
  return new Promise((resolve) => {
    const previousFocus = document.activeElement;
    const ov = document.createElement('div');
    ov.id = 'confirm-overlay';
    const cancelButton = `<button class="btn${opts.cancelPrimary ? ' primary' : ''} sm" data-v="0">${esc(opts.cancelText || 'Cancel')}</button>`;
    const confirmButton = `<button class="btn${opts.cancelPrimary ? '' : ' primary'} sm" data-v="1">${esc(opts.confirmText || 'Continue')}</button>`;
    ov.innerHTML = `<div id="confirm-box" role="alertdialog">
      <h3>${esc(title)}</h3><p class="muted${opts.danger ? ' danger-text' : ''}${opts.small ? ' small' : ''}">${esc(body)}</p>
      <div class="confirm-btns">${opts.cancelPrimary ? confirmButton + cancelButton : cancelButton + confirmButton}</div></div>`;
    document.body.appendChild(ov);
    const close = (value) => {
      ov.remove();
      document.removeEventListener('keydown', keydown, true);
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
      resolve(value);
    };
    const keydown = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); close(false); return; }
      if (e.key !== 'Tab') return;
      const focusable = $$('button:not(:disabled)', ov);
      if (!focusable.length) return;
      const at = focusable.indexOf(document.activeElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); focusable.at(-1).focus(); }
      else if (!e.shiftKey && at === focusable.length - 1) { e.preventDefault(); focusable[0].focus(); }
    };
    ov.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b && e.target !== ov) return;
      const v = b ? b.dataset.v === '1' : false;
      close(v);
    });
    document.addEventListener('keydown', keydown, true);
    $(`button[data-v="${opts.cancelPrimary ? '0' : '1'}"]`, ov).focus({ preventScroll: true });
  });
}
async function syncCfg() { S.cfg = await window.api.cfgGet(); }
// cfgSet returns the saved config for the renderer copy.
async function savePatch(patch) {
  S.cfg = await window.api.cfgSet(patch);
  if (['api_key', 'artwork_filters', 'include_animated', 'include_nsfw', 'include_humor'].some(key => Object.hasOwn(patch, key))) {
    S.cardArtCache.clear();
    S.previewCache = {};
  }
  applyTheme();
}
function applyTheme() {
  const mode = ['dark', 'light'].includes(S.cfg.theme) ? S.cfg.theme : 'system';
  const theme = mode === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : mode;
  document.documentElement.dataset.theme = theme;
  const button = $('#theme-cycle');
  $('use', button)?.setAttribute('href', '#i-theme-' + theme);
  button.title = `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`;
  button.setAttribute('aria-label', button.title);
}

// ------------------------------------------------------------------ router
// Back/Forward history for mouse navigation.
function libraryView() {
  return S.cfg?.startup_library === 'desktop' ? 'desktop' : 'library';
}
async function showLibrary(switching = false) {
  const desktop = libraryView() === 'desktop';
  const load = desktop ? () => refreshDesktop(false) : loadLibrary;
  const reveal = () => {
    const tools = $('#page-nav');
    const bar = $(desktop ? '#page-desktop .browse-tools' : '#page-library .browse-tools');
    $('#steam-shortcut-actions').hidden = desktop;
    bar.append(tools);
    const outside = $('#library-tools');
    bar.parentElement.append(outside);
    outside.hidden = false;
    tools.hidden = false;
    for (const button of $$('#desktop-destination button')) button.setAttribute('aria-pressed', String(button.dataset.destination === (desktop ? 'desktop' : 'steam')));
    $('#shortcut-location').value = S.cfg.desktop_destination || 'desktop';
    renderLibrarySetup();
    $('#page-library').classList.toggle('on', !desktop);
    $('#page-desktop').classList.toggle('on', desktop);
    renderLog();
  };
  if (switching) {
    try { await load(); } finally { reveal(); }
    return;
  }
  reveal();
  if (desktop) renderDesktop(); else renderRows();
  await load();
}

// ---------------------------------------------------------- shared cards
async function detectSteam() {
  const result = await window.api.steamDetect(S.cfg.steam_path || null);
  await syncCfg();
  S.steamUsers = result.users || [];
  S.steamFound = !!result.path;
  if (result.path && folderKey(result.path) !== lastDetectedSteamPath) log(`Steam found at ${result.path}`);
  lastDetectedSteamPath = folderKey(result.path);
}
let keyNoticeDismissed = false;
function renderLibrarySetup() {
  const panel = $('#library-setup');
  const steamView = libraryView() === 'library';
  const needsSteam = steamView && (!S.steamFound || !S.cfg.steam_user_id);
  const needsKey = !S.cfg.api_key && !keyNoticeDismissed;
  panel.hidden = !needsKey && !needsSteam;
  panel.innerHTML = '';
  if (panel.hidden) return;
  panel.innerHTML = `<div><h2 id="setup-title">Set up your library</h2><p>${needsSteam
    ? S.steamFound ? 'Sign in to Steam once, then refresh to load your library.' : 'Steam was not found. Connect it to show your Steam games.'
    : 'Add a SteamGridDB key to browse artwork. You can also use images from your computer.'}</p></div>
    <div class="setup-actions">${needsSteam && !S.steamFound ? '<button class="btn sm" id="connect-steam">Connect Steam</button>' : ''}
    ${needsSteam && S.steamFound ? '<button class="btn sm" data-setup="refresh">Check again</button>' : ''}
    ${needsKey ? '<button class="btn sm" data-setup="key">Add artwork key</button><button class="text-btn setup-dismiss" data-setup="dismiss" aria-label="Dismiss" title="Dismiss">&times;</button>' : ''}</div>`;
  const dismiss = $('[data-setup=dismiss]', panel);
  if (dismiss) dismiss.onclick = () => { keyNoticeDismissed = true; renderLibrarySetup(); };
  const connect = $('#connect-steam', panel);
  if (connect) connect.onclick = openSteamSetup;
  const key = $('[data-setup="key"]', panel);
  if (key) key.onclick = () => { $('#preferences').open = true; $('[data-r="key"]').focus(); };
  const refresh = $('[data-setup="refresh"]', panel);
  if (refresh) refresh.onclick = handleAction('Check Steam', async () => { await detectSteam(); await showLibrary(); });
}
let lastDetectedSteamPath = '';
function steamCard() {
  const d = document.createElement('div');
  d.className = 'card settings-block';
  // No Detect button by design: detection runs itself on boot and every time
  // this card appears. Browse is the only manual action.
  d.innerHTML = `<h3>Steam installation</h3>
    <div class="row"><input type="text" data-r="path" style="flex:1" placeholder="detecting…">
    <button class="btn sm" data-r="browse">Browse…</button></div>
    <div class="row"><span class="muted">User:</span>
    <select data-r="user" aria-label="Steam account" hidden></select><div class="choice-list"></div></div>
    <div class="status-line" data-r="status">Detecting…</div>
    <div class="note">Steam closes while changes are applied and reopens afterward if it was running.</div>`;
  const q = (s) => d.querySelector(`[data-r="${s}"]`);
  const userLabel = (u) => (u.name && u.name !== u.id ? `${u.name} (${u.id})` : u.id);
  // Shown with steam.exe on the end (same as manual picking). Stored as a
  // folder, normalize() bridges the two.
  const steamDisplay = (p) => {
    const s = String(p || '').replace(/\\+$/, '');
    if (!s) return '';
    return /steam\.exe$/i.test(s) ? s : `${s}\\steam.exe`;
  };
  const paintUsers = () => {
    q('user').parentElement.hidden = S.steamUsers.length <= 1;
    q('user').innerHTML = S.steamUsers.map((u) =>
      `<option value="${esc(u.id)}"${u.id === S.cfg.steam_user_id ? ' selected' : ''}>${esc(userLabel(u))}</option>`).join('');
    renderChoiceList(q('user'));
  };
  // Status always reflects a live steam.exe check - never a saved string,
  // so a stale/invalid path can no longer show "Found".
  const paint = async () => {
    const ok = await window.api.steamVerify(q('path').value.trim()).catch(() => false);
    q('status').textContent = ok
      ? `Found users: ${S.steamUsers.map(userLabel).join(', ') || 'none yet - log into Steam once'}`
      : 'Not detected yet - Browse to it manually.';
    q('status').className = `status-line${ok ? ' ok' : ''}`;
  };
  q('path').value = steamDisplay(S.cfg.steam_path);
  paintUsers();
  detectInto();
  q('path').addEventListener('change', async () => {
    await savePatch({ steam_path: q('path').value.trim() });
    await detectInto();
  });
  q('user').addEventListener('change', () => savePatch({ steam_user_id: q('user').value }));
  q('browse').addEventListener('click', async () => {
    const r = await window.api.steamBrowse();
    if (r && r.error) { toast(r.error); return; }
    if (r && r.path) {
      await savePatch({ steam_path: r.path });
      q('path').value = steamDisplay(r.path);
      await detectInto();
    }
  });
  async function detectInto() {
    // One detect at a time per card (settings rebuilds on every visit).
    // Any failure lands on a real status - never stuck on "Detecting…".
    if (d._detecting) return;
    d._detecting = true;
    q('status').textContent = 'Detecting…';
    q('status').className = 'status-line';
    try {
      await detectSteam();
      q('path').value = steamDisplay(S.cfg.steam_path);
      paintUsers();
      renderLibrarySetup();
    } catch (e) {
      log(`Steam detect failed: ${e.message || e}`);
    } finally {
      d._detecting = false;
      if (d.isConnected) await paint();
    }
  }
  return d;
}

function keyCard() {
  const d = document.createElement('div');
  d.className = 'card settings-block';
  d.innerHTML = `<h3>SteamGridDB API key</h3>
    <div class="key-entry"><div class="key-field"><input type="password" data-r="key" aria-label="SteamGridDB API key" placeholder="paste key…" autocomplete="off">
    <button class="btn sm key-eye" data-r="show" aria-label="Show API key" aria-pressed="false"><svg class="icon" aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path class="eye-slash" d="m4 4 16 16"/></svg></button></div>
    <button class="btn sm" data-r="get">Get key</button></div>
    <div class="status-line key-feedback" data-r="status" role="status"></div>`;
  const q = name => d.querySelector(`[data-r="${name}"]`);
  const input = q('key');
  input.value = S.cfg.api_key || '';
  const paint = result => {
    q('status').className = 'status-line key-feedback' + (result ? (result.ok ? ' ok' : ' bad') : '');
    q('status').textContent = result?.ok ? 'Key valid'
      : result ? 'Could not verify the key. It is saved.' : '';
  };
  paint(input.value ? S.cfg.api_key_check : null);
  let timer;
  const checking = new Map();
  const validate = handleAction('Check artwork key', async () => {
    const key = input.value.trim();
    if (checking.has(key) && key === S.cfg.api_key) return;
    if (key === S.cfg.api_key && (!key || S.cfg.api_key_check)) {
      paint(key ? S.cfg.api_key_check : null);
      return;
    }
    const request = {};
    checking.set(key, request);
    try {
      if (key !== S.cfg.api_key) {
        await savePatch({ api_key: key });
        renderLibrarySetup();
      }
      if (!key || input.value.trim() !== key) return;
      q('status').textContent = 'Checking key…';
      const result = await window.api.keyValidate(key);
      if (checking.get(key) !== request || input.value.trim() !== key || S.cfg.api_key !== key) return;
      S.cfg.api_key_check = result;
      paint(result);
    } finally { if (checking.get(key) === request) checking.delete(key); }
  });
  input.addEventListener('input', () => {
    clearTimeout(timer);
    paint(null);
    timer = setTimeout(validate, 650);
  });
  input.addEventListener('change', () => {
    clearTimeout(timer);
    validate();
  });
  if (input.value && !S.cfg.api_key_check) timer = setTimeout(validate, 650);
  q('show').addEventListener('click', () => {
    const visible = q('key').type === 'password';
    q('key').type = visible ? 'text' : 'password';
    q('show').setAttribute('aria-label', visible ? 'Hide API key' : 'Show API key');
    q('show').setAttribute('aria-pressed', String(visible));
  });
  q('get').addEventListener('click', () => window.api.openUrl('https://www.steamgriddb.com/profile/preferences/api'));
  return d;
}

function executableSetting() {
  return libraryView() === 'desktop' ? 'desktop_executables' : 'steam_executables';
}
function renderFoundLaunchers() {
  const host = $('#found-launchers');
  const setting = executableSetting();
  const launchers = S.cfg[setting] || [];
  host.replaceChildren();
  host.hidden = !launchers.length;
  if (!launchers.length) return;
  const header = document.createElement('div');
  header.className = 'found-launchers-head';
  header.innerHTML = `<strong>Found launchers (${launchers.length})</strong><button class="btn sm">Remove all from library</button>`;
  host.appendChild(header);
  const remove = async path => {
    if (host.inert) return;
    host.inert = true;
    try {
      const remaining = path ? (S.cfg[setting] || []).filter(game => folderKey(game.exePath) !== folderKey(path)) : [];
      await savePatch({ [setting]: remaining });
      renderFoundLaunchers();
      await showLibrary();
    } finally { host.inert = false; }
  };
  $('button', header).onclick = handleAction('Remove found launchers', () => remove());
  const list = document.createElement('div');
  list.className = 'found-launchers-list';
  for (const { exePath, displayName } of launchers) {
    const row = document.createElement('div');
    row.className = 'folder-entry';
    row.innerHTML = `<span title="${esc(exePath)}">${esc(displayName || exePath)}<small>${esc(exePath)}</small></span><button class="btn sm">Remove</button>`;
    $('button', row).onclick = handleAction('Remove launcher', () => remove(exePath));
    list.appendChild(row);
  }
  host.appendChild(list);
}

function renderSources() {
  renderFoundLaunchers();
  const host = $('#source-folders');
  host.replaceChildren();
  for (const folder of S.cfg.games_roots || []) {
    const row = document.createElement('div');
    row.className = 'folder-entry';
    row.innerHTML = `<span>${esc(folder)}</span><button class="btn sm">Remove</button>`;
    $('button', row).onclick = handleAction('Remove folder', async () => {
      const depths = { ...S.cfg.folder_depths };
      delete depths[folderKey(folder)];
      await savePatch({ games_roots: S.cfg.games_roots.filter(path => path !== folder), folder_depths: depths });
      renderSources();
      await showLibrary();
    });
    host.appendChild(row);
  }
}
function openFolders() {
  renderSources();
  $('#page-add').showModal();
}
function openSteamSetup() {
  $('#steam-connection').replaceChildren(steamCard());
  $('#steam-setup').showModal();
}

// --------------------------------------------------------------- settings
function renderSettingsCards(key = keyCard()) {
  const host = $('#settings-cards');
  const theme = $('#theme-cycle');
  host.innerHTML = '';
  const header = document.createElement('div');
  header.className = 'preferences-heading';
  header.append($('h3', key), theme);
  key.prepend(header);
  host.appendChild(key);
  if (S.steamUsers.length > 1) {
    const accounts = document.createElement('fieldset');
    accounts.className = 'steam-accounts';
    accounts.innerHTML = `<legend>Steam account</legend><div class="account-options">${S.steamUsers.map((user, index) =>
      `<label><input type="radio" name="steam-account" value="${esc(user.id)}"${user.id === S.cfg.steam_user_id ? ' checked' : ''}><span>${esc(user.name && user.name !== user.id ? user.name : `Account ${index + 1}`)}</span></label>`).join('')}</div>`;
    accounts.addEventListener('change', handleAction('Steam account', async () => {
      const selected = $('input:checked', accounts).value;
      accounts.disabled = true;
      try {
        if (S.applyingSteam || S.loadingLibrary) throw new Error('Wait for the current operation to finish before switching accounts.');
        await savePatch({ steam_user_id: selected });
        S.rows = [];
        await showLibrary();
      } finally {
        $$('input', accounts).forEach(input => { input.checked = input.value === S.cfg.steam_user_id; });
        accounts.disabled = false;
      }
    }));
    host.appendChild(accounts);
  }
  const danger = document.createElement('div');
  danger.className = 'card settings-block';
  danger.innerHTML = `<h3>Danger zone</h3>
    <div class="row"><button class="btn danger sm" data-r="purge">Purge</button>
    <button class="btn danger sm" data-r="wipe">Delete app data</button></div>`;
  danger.querySelector('[data-r="purge"]').addEventListener('click', handleAction('Purge', doPurge));
  danger.querySelector('[data-r="wipe"]').addEventListener('click', doWipeData);
  host.appendChild(danger);
}

async function doWipeData() {
  if (!await confirmDlg('Delete app data',
    'Delete all app data? This keeps your games and Steam shortcuts, but deletes settings, saved matches, and the change journal.\n\n'
    + 'Purge first if you want to undo changes made to Steam. The app will close.')) return;
  try {
    const res = await window.api.appWipeData();
    // Take the wiped (default) config into memory too - otherwise a stray
    // save between here and quit would resurrect the API key from RAM.
    if (res && res.cfg) S.cfg = res.cfg;
  } catch (e) {
    toast(e.message || String(e));
  }
  // Window closes either way - no session left without its data.
  window.close();
}

async function doPurge() {
  let plan;
  try {
    plan = await window.api.steamPurge({ dryRun: true });
  } catch (e) {
    toast(e.message || String(e));
    return;
  }
  if (!plan.removeAppids.length && !plan.restoreFields.length && !plan.deleteFiles.length && !plan.restoreFiles.length) {
    toast("Nothing to purge - Steam is clean of the app's changes.");
    log('Purge check: nothing to undo.');
    return;
  }
  const sample = plan.names.slice(0, 8).map((n) => `• ${n}`).join('\n')
    + (plan.names.length > 8 ? `\n… and ${plan.names.length - 8} more` : '');
  const msg = `Remove everything this app changed in Steam?\n\n`
    + `${plan.removeAppids.length} shortcut(s), ${plan.restoreFields.length} restored shortcut setting(s), `
    + `${plan.deleteFiles.length} art file(s), ${plan.restoreFiles.length} restored art file(s)`
    + (plan.skippedFiles.length ? `, ${plan.skippedFiles.length} user-changed file(s) kept` : '')
    + (sample ? `\n\n${sample}` : '')
    + `\n\nShortcuts are backed up before changes. Your games and Steam itself are untouched. Steam will close and reopen if it is running.`;
  if (!await confirmDlg('Purge everything', msg)) return;
  const res = await window.api.steamPurge({ dryRun: false });
  (res.lines || []).forEach(line => log(line));
  await refreshSteamState();
  await syncSteamLibrary();
  status('Purge complete.');
  toast(res.warning || 'Purge complete.');
}

// ---------------------------------------------------------------- library
const SOURCE_LABEL = { folder: 'Folder', shortcut: 'Shortcut', steam: 'Steam' };
const needsReview = (row) => row.source !== 'steam' && !row.sgdbId && row.idMethod === 'folder';

function visibleSteamRows() {
  const f = S.filter.trim().toLocaleLowerCase();
  return S.rows.filter((r) => {
    if (S.nonSteamOnly && r.source === 'steam') return false;
    if (f && !`${r.display} ${r.folder} ${r.exe || ''}`.toLocaleLowerCase().includes(f)) return false;
    // Hide-owned only trusts certain appids. Shortcut rows carry guesses,
    // so they never hide.
    if (S.hideOwned && r.source !== 'shortcut' && r.steamAppid != null && S.ownedAppids.has(r.steamAppid)) return false;
    return true;
  }).sort((a, b) => {
    const nameOrder = a.display.localeCompare(b.display, undefined, { sensitivity: 'base', numeric: true });
    if (nameOrder) return nameOrder;
    return String(a.exe || a.folder).localeCompare(String(b.exe || b.folder), undefined, { sensitivity: 'base' });
  });
}

function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? `${parts[0][0]}${parts[1][0]}` : (parts[0] || '?').slice(0, 2)).toUpperCase();
}

function cardSource(row) {
  if (row.source === 'steam') return 'Steam';
  if (row.source === 'shortcut') return 'Shortcut';
  return row.fromExecutableSearch ? 'Found launcher' : 'Game folder';
}

function cardSubtitle(row) {
  if (row.source === 'steam') return `Steam app ${row.steamAppid || ''}`.trim();
  const launcher = row.exe ? baseName(row.exe) : row.folderName || 'No launcher';
  return row.source === 'shortcut' && row.launchOptions ? `${launcher} · ${row.launchOptions}` : launcher;
}

function cardStatus(row) {
  if (row.pendingArt || row.pendingDetails) return ['Ready', 'pending'];
  if (row.error) return ['Issue', 'issue'];
  if (row.inSteam) return ['In Steam', ''];
  if (needsReview(row)) return ['Not matched', ''];
  return ['Not added', ''];
}

function coverToken(row) {
  const art = row.art?.grid;
  return `${rowKey(row)}:${art?.appliedFile || art?.file || art?.id || art?.url || art?.thumb || 'current'}:${row.sgdbId || ''}`;
}

async function cardCoverSource(row) {
  const art = row.art?.grid;
  if (!art?.automatic && (art?.appliedFile || art?.file)) {
    const file = art.appliedFile || art.file;
    const local = await window.api.artThumbnail(file).catch(() => window.api.artPreviewFile(file).catch(() => null));
    if (local) return local;
  }
  if (!art?.automatic && art?.thumb) return { src: art.thumb, fallback: art.url };
  if (!art?.automatic && art?.url) return art.url;
  const current = await window.api.artCurrent({ row: rowPayload(row), kind: 'grid', existsOnly: true }).catch(() => null);
  if (current?.file) {
    const local = await window.api.artThumbnail(current.file).catch(() => window.api.artPreviewFile(current.file).catch(() => null));
    if (local) return local;
  }
  if (art?.automatic) {
    if (art.appliedFile || art.file) {
      const file = art.appliedFile || art.file;
      const local = await window.api.artThumbnail(file).catch(() => window.api.artPreviewFile(file).catch(() => null));
      if (local) return local;
    }
    if (art.thumb || art.url) return { src: art.thumb || art.url, fallback: art.url };
  }
  const appid = row.source === 'steam' ? row.steamAppid : null;
  const sgdbId = row.sgdbId || (row.source === 'steam' && S.cfg.api_key
    ? (await window.api.sgdbBySteam(row.steamAppid).catch(() => null))?.id : null);
  if (sgdbId && S.previewCache[sgdbId]) return S.previewCache[sgdbId];
  const saved = await window.api.coverCacheGet({ sgdbId, appid }).catch(() => null);
  if (!sgdbId || !S.cfg.api_key) return saved;
  const items = await window.api.artList({ sgdbId, kind: 'grid' }).catch(() => []);
  const preview = items[0]?.thumb || items[0]?.url || null;
  if (!preview) return saved;
  const source = { src: preview, fallback: items[0]?.url || null };
  S.previewCache[sgdbId] = source;
  window.api.coverCachePut({ sgdbId, appid, src: source.src, fallback: source.fallback }).catch(() => {});
  return source;
}

let coverRequests = 0;
const waitingCovers = [];
async function requestCardCover(row) {
  await new Promise(resolve => {
    if (coverRequests < 4) { coverRequests++; resolve(); }
    else waitingCovers.push(resolve);
  });
  try {
    return await (row.source === 'desktop' ? desktopCardCoverSource(row) : cardCoverSource(row));
  } finally {
    const next = waitingCovers.shift();
    if (next) next();
    else coverRequests--;
  }
}

function loadCardCover(row, tr) {
  const image = $('.game-cover', tr);
  const fallback = $('.cover-fallback', tr);
  const token = image.dataset.coverToken;
  const cached = S.cardArtCache.get(token);
  const request = cached || requestCardCover(row);
  if (!cached) S.cardArtCache.set(token, request);
  let alternate;
  image.onload = () => {
    if (!image.isConnected || image.dataset.coverToken !== token) return;
    image.hidden = false;
    fallback.hidden = true;
  };
  image.onerror = () => {
    if (alternate && image.getAttribute('src') !== alternate) { image.src = alternate; alternate = null; return; }
    image.hidden = true;
    fallback.hidden = false;
    S.cardArtCache.delete(token);
    if (row.sgdbId) delete S.previewCache[row.sgdbId];
  };
  request.then((source) => {
    if (!image.isConnected || image.dataset.coverToken !== token) return;
    if (!source) { S.cardArtCache.delete(token); return; }
    alternate = source.fallback;
    image.src = source.src || source;
  }).catch(() => { S.cardArtCache.delete(token); });
}

function updateLibraryActions() {
  const pending = S.rows.filter((row) => row.pendingArt || row.pendingDetails).length;
  $('#library-pending').hidden = pending === 0;
  $('#library-pending').textContent = pending ? `${pending} ready to apply` : '';
  const button = $('#btn-add');
  const busy = S.applyingSteam || S.loadingLibrary;
  const count = reviewCandidates('library').length;
  const missingCount = missingShortcuts('library').length;
  button.disabled = busy || (!count && !missingCount);
  $('#btn-clear').disabled = busy;
  button.textContent = count ? `Review ${count} change${count === 1 ? '' : 's'}`
    : missingCount ? 'Add to Steam' : 'Review changes';
  $('#btn-refresh').disabled = busy;
}

function renderEmptyLibrary(body, message, action, run) {
  const row = body.insertRow();
  row.className = 'empty-row';
  const content = document.createElement('div');
  content.className = 'list-empty';
  const copy = document.createElement('p');
  copy.textContent = message;
  content.append(copy);
  if (action) {
    const button = document.createElement('button');
    button.className = 'btn sm';
    button.textContent = action;
    button.addEventListener('click', (e) => { e.stopPropagation(); run(); });
    content.append(button);
  }
  row.insertCell().append(content);
}

function renderRows() {
  const body = $('#games-body');
  body.innerHTML = '';
  S.coverObserver?.disconnect();
  const visible = visibleSteamRows();
  const observerRoot = $('#page-library');
  S.coverObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        S.coverObserver.unobserve(entry.target);
        loadCardCover(entry.target._gameRow, entry.target);
      }
    }, { root: observerRoot, rootMargin: '420px 0px' }) : null;
  if (!visible.length) {
    if (S.loadingLibrary) renderEmptyLibrary(body, 'Loading games…');
    else if (S.rows.length) renderEmptyLibrary(body, 'No games match these filters.', 'Clear filters', () => {
      $('#filter').value = S.filter = '';
      $('#source-filter').checked = S.nonSteamOnly = false;
      $('#hide-owned').checked = S.hideOwned = false;
      renderRows();
      $('#filter').focus();
    });
    else if (S.steamFound && S.cfg.steam_user_id) renderEmptyLibrary(body, 'No games found.', 'Add games folder', openFolders);
  }
  for (const row of visible) {
    const key = rowKey(row);
    const [state, stateClass] = cardStatus(row);
    const detail = cardSubtitle(row);
    const tr = document.createElement('tr');
    tr.className = 'game-card-row';
    tr.dataset.key = key;
    tr.innerHTML = `<td><div class="game-tile"><button class="game-open" type="button" aria-label="Choose artwork for ${esc(row.display)}">
      <div class="cover-wrap">
        <div class="cover-fallback"><img src="../assets/app-icon.svg" alt=""><span>${esc(initials(row.display))}</span></div>
        <img class="game-cover" data-cover-token="${esc(coverToken(row))}" alt="Cover art for ${esc(row.display)}" decoding="async" hidden>
      </div></button>
      <div class="game-card-copy">
        <button class="game-name" type="button" aria-label="Details for ${esc(row.display)}" title="Game details">${esc(row.display)}</button>
        <span class="game-meta"><span class="source-label" title="${esc(cardSource(row))}">${esc(cardSource(row))}</span>${state ? `<span class="game-state ${stateClass}">${esc(state)}</span>` : ''}</span>
        <span class="game-subtitle" title="${esc(detail)}">${wrapText(detail)}</span>
      </div>
    </div></td>`;
    tr._gameRow = row;
    body.appendChild(tr);
    if (S.coverObserver) S.coverObserver.observe(tr);
    else loadCardCover(row, tr);
  }
  $('#library-count').textContent = `${S.rows.length} game${S.rows.length === 1 ? '' : 's'}`;
  $('#library-grid-count').textContent = visible.length === S.rows.length ? '' : `${visible.length} game${visible.length === 1 ? '' : 's'} shown`;
  updateLibraryActions();
}

function rowKey(r) {
  return `${r.source}:${r.folder}`;
}

function rowByKey(key) {
  return S.rows.find((r) => rowKey(r) === key);
}

function renderChoiceList(pick) {
  const list = pick.nextElementSibling;
  const focused = list.contains(document.activeElement) ? document.activeElement.dataset.index : null;
  list.setAttribute('role', 'group');
  list.setAttribute('aria-label', pick.getAttribute('aria-label'));
  list.innerHTML = [...pick.options].map((option, index) => `<button type="button" data-index="${index}" aria-pressed="${option.selected}" tabindex="${option.selected || pick.selectedIndex < 0 && index === 0 ? 0 : -1}" title="${esc(option.title || option.textContent)}">${esc(option.textContent)}</button>`).join('');
  list.onclick = event => {
    const button = event.target.closest('button[data-index]');
    if (!button) return;
    const index = Number(button.dataset.index);
    const changed = index !== pick.selectedIndex;
    pick.selectedIndex = index;
    for (const item of list.children) {
      item.setAttribute('aria-pressed', String(item === button));
      item.tabIndex = item === button ? 0 : -1;
    }
    if (changed) pick.dispatchEvent(new Event('change', { bubbles: true }));
  };
  list.onkeydown = event => {
    const buttons = [...list.children];
    const index = buttons.indexOf(event.target);
    if (index < 0) return;
    const to = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: buttons.length - 1 }[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = buttons[Math.min(buttons.length - 1, Math.max(0, to))];
    event.target.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
  };
  if (focused != null && list.children[Number(focused)]) {
    list.children[Number(focused)].focus({ preventScroll: true });
  }
}

function updateLauncherChoice(pick) {
  const choices = pick.closest('.launcher-candidates');
  const summary = $('summary', choices);
  const multiple = pick.options.length > 1;
  $('span', summary).textContent = pick.selectedOptions[0]?.textContent || 'No launcher selected';
  summary.title = pick.value;
  summary.tabIndex = multiple ? 0 : -1;
  summary.onclick = multiple ? null : event => event.preventDefault();
  choices.classList.toggle('has-alternatives', multiple);
  if (!multiple) choices.open = false;
  renderChoiceList(pick);
}

function renderSteamGameSettings(row) {
  const editable = row.source !== 'steam';
  $('#steam-game-settings .launcher-editor').hidden = !editable;
  $('#btn-remove').hidden = !canRemoveSteamShortcut(row);
  $('#d-name').value = row.display;
  const pick = $('#d-exe-pick');
  pick.innerHTML = '';
  if (row.source === 'steam') {
    const o = document.createElement('option');
    o.value = row.exe || '';
    o.textContent = 'Managed by Steam';
    pick.appendChild(o);
  } else if (row.candidates.length) {
    const names = new Map();
    for (const c of row.candidates) {
      const name = baseName(c.path).toLowerCase();
      names.set(name, (names.get(name) || 0) + 1);
    }
    row.candidates.forEach((c) => {
      const o = document.createElement('option');
      const rel = !row.fromExecutableSearch && c.path.startsWith(row.folder)
        ? c.path.slice(row.folder.length).replace(/^[\\/]/, '') : c.path;
      o.value = c.path;
      o.title = c.path;
      o.textContent = `${names.get(baseName(c.path).toLowerCase()) > 1 ? rel : baseName(c.path)} · ${fmtMB(c.size)}`;
      pick.appendChild(o);
    });
  }
  if (row.exe && ![...pick.options].some((o) => o.value === row.exe)) {
    const o = document.createElement('option');
    o.value = row.exe;
    o.textContent = baseName(row.exe);
    pick.appendChild(o);
  }
  if (!pick.options.length) {
    const o = document.createElement('option');
    o.value = '';
    o.textContent = 'No launcher found';
    pick.appendChild(o);
  }
  pick.value = row.exe || '';
  pick.closest('details').open = false;
  updateLauncherChoice(pick);
  const locked = row.source === 'steam';
  $('#d-name').disabled = locked;
  pick.disabled = locked;
  $('#d-browse').disabled = locked;
  $('#steam-launch-settings').hidden = locked;
  const launch = S.cfg.steam_launch?.[folderKey(row.folder)];
  $('#d-startdir').value = launch?.startDir ?? String(row.startDir || '').replace(/^"|"$/g, '');
  $('#d-args').value = launch?.launchOptions ?? row.launchOptions ?? '';
}

function steamDraftScope() {
  return S.cfg.steam_path && S.cfg.steam_user_id
    ? JSON.stringify([folderKey(S.cfg.steam_path), String(S.cfg.steam_user_id)]) : null;
}
function steamDraftKey(row) {
  // Executable identity survives a scanned folder becoming a Steam shortcut.
  if (row.exe) return `exe:${folderKey(row.exe)}`;
  if (row.source === 'steam') return `steam:${row.steamAppid}`;
  if (row.source === 'shortcut' && row.appid != null) return `shortcut:${row.appid}`;
  return `folder:${folderKey(row.folder)}`;
}
function insideGameFolder(file, folder) {
  const dir = folderKey(folder);
  const key = folderKey(file);
  return !!dir && !!key && (key === dir || key.startsWith(`${dir}\\`));
}
function steamDraftKeys(row) {
  const key = steamDraftKey(row);
  if (row.source !== 'steam' || !row.startDir) return [key];
  // Older scanned choices remain readable without migrating config on Refresh.
  const drafts = S.cfg.steam_art_drafts?.[steamDraftScope()] || {};
  return [key, ...Object.keys(drafts).filter(k => k.startsWith('exe:')
    && insideGameFolder(k.slice(4), row.startDir)).sort()];
}
function restoreSteamDraft(row) {
  const scope = steamDraftScope();
  // Account changes clear the previous account's in-memory choices.
  if (row.artDraftScope !== undefined && row.artDraftScope !== scope) {
    row.art = {}; row.pendingArt = false; row.artApplied = false;
    delete row.logoPosition;
  }
  row.artDraftScope = scope;
  const drafts = steamDraftKeys(row).map(key => S.cfg.steam_art_drafts?.[scope]?.[key])
    .filter(draft => draft?.art && typeof draft.art === 'object');
  if (!row.pendingArt && !Object.keys(row.art || {}).length && drafts.length) {
    row.art = JSON.parse(JSON.stringify(Object.assign({}, ...drafts.map(d => d.art).reverse())));
    row.pendingArt = Object.keys(row.art).length > 0;
    row.sgdbId = drafts[0].sgdbId ?? row.sgdbId;
    row.sgdbName = drafts[0].sgdbName || row.sgdbName;
  }
  if (drafts[0]?.logoPosition !== undefined) {
    row.logoPosition = drafts[0].logoPosition;
    row.pendingArt = true;
  }
  return row;
}
async function saveSteamDrafts(rows, removedKeys = []) {
  const scope = steamDraftScope();
  if (!scope) return;
  const updates = Object.fromEntries(removedKeys.map(key => [key, null]));
  for (const row of rows) {
    if (row.source === 'desktop' || row.artDraftScope !== undefined && row.artDraftScope !== scope) continue;
    const art = Object.fromEntries(Object.entries(row.art || {}).filter(([, image]) =>
      image && !image.current && !image.automatic && !image.appliedFile));
    for (const key of steamDraftKeys(row)) updates[key] = null;
    updates[steamDraftKey(row)] = row.pendingArt && (Object.keys(art).length || row.logoPosition !== undefined)
      ? { art, sgdbId: row.sgdbId, sgdbName: row.sgdbName,
        ...(row.logoPosition !== undefined ? { logoPosition: row.logoPosition } : {}) } : null;
  }
  await window.api.steamDraftsSave({ scope, updates });
  await syncCfg();
}
function toRow(g, useLegacy = false) {
  const folderName = baseName(g.fromExecutableSearch ? g.startDir : g.folder);
  const key = folderKey(g.folder);
  const title = (S.cfg.title_map && (S.cfg.title_map[key]
    || (useLegacy && S.cfg.title_map[folderName]))) || g.displayName;
  const sgdbKeys = [key, ...(useLegacy ? [folderName, title, g.displayName] : [])];
  const savedSgdb = sgdbKeys.map((k) => Number(S.cfg.sgdb_map[k] || S.cfg.sgdb_cache[k]))
    .find((id) => Number.isFinite(id) && id > 0) || null;
  const row = {
    folder: g.folder, folderName, display: title, exe: g.exePath, startDir: g.startDir,
    launchOptions: '', candidates: g.candidates || [], score: g.score || 0, reason: g.reason || '',
    query: title, steamAppid: g.steamAppid ?? null, idMethod: g.idMethod || 'folder',
    fromExecutableSearch: !!g.fromExecutableSearch,
    confidence: g.confidence || 0, source: 'folder',
    sgdbId: savedSgdb, sgdbName: savedSgdb ? '(cached)' : '',
    inSteam: false, managed: false, shortcutIdx: null, appid: null, art: {},
    defaults: { folder: g.folder, folderName, display: g.displayName, query: g.displayName,
      exe: g.exePath, startDir: g.startDir, reason: g.reason || '' },
  };
  const savedExe = !g.fromExecutableSearch && S.cfg.exe_map && (S.cfg.exe_map[key]
    || (useLegacy && S.cfg.exe_map[folderName]));
  if (savedExe && row.candidates.length) {
    const hit = row.candidates.find((c) =>
      baseName(c.path).toLowerCase() === baseName(savedExe).toLowerCase()
      || c.path.toLowerCase().endsWith(String(savedExe).toLowerCase()));
    if (hit) {
      row.exe = hit.path;
      row.startDir = parentDir(hit.path) || row.startDir;
      row.reason = `saved pick: ${baseName(hit.path)}`;
    }
  }
  return restoreSteamDraft(row);
}

// ------------------------------------------------------------------ steam library
// Steam's own rows: existing non-Steam shortcuts ('shortcut') and installed
// store games ('steam'). Steam rows replace duplicates from scanned folders.
async function syncSteamLibrary(entries, installed) {
  if (!entries) { try { entries = await window.api.steamRead(); } catch { entries = []; } }
  if (!installed) { try { installed = await window.api.steamGames(); } catch { installed = []; } }
  const keep = new Map();
  for (const r of S.rows) {
    if (r.source === 'folder') continue;
    keep.set(r.source === 'steam' ? `steam:${r.steamAppid}` : `${r.source}:${(r.exe || r.display).toLowerCase()}`, r);
  }
  S.rows = S.rows.filter((r) => r.source === 'folder');
  S.ownedAppids = new Set(installed.map((g) => g.appid));

  for (const e of entries) {
    const exe = String(e.exe || '').replace(/^"|"$/g, '');
    const name = String(e.appName || '(unnamed)');
    const old = keep.get(`shortcut:${(exe || name).toLowerCase()}`);
    const folder = `shortcut://${e.appid ?? e.index}`;
    const sgdbId = old?.sgdbId || S.cfg.sgdb_map?.[folderKey(folder)] || S.cfg.sgdb_cache?.[folderKey(folder)] || null;
    let query = name;
    let steamAppid = null;
    try {
      const id = await window.api.resolveName(name);
      if (id && id.parsed) { query = id.title; steamAppid = id.steamAppid; }
    } catch { /* display-only guess. Matching does the real work. */ }
    const startDir = String(e.startDir || parentDir(exe));
    S.rows.push({
      folder, folderName: name, display: name,
      exe: exe || null, startDir, launchOptions: e.launchOptions || '',
      candidates: exe ? [{ path: exe, size: 0, depth: 0, score: 0, reason: 'existing shortcut' }] : [],
      score: 0, reason: 'already in Steam as a non-Steam shortcut', query,
      steamAppid, idMethod: 'shortcut', confidence: 0.5, source: 'shortcut',
      sgdbId,
      sgdbName: old?.sgdbName || (sgdbId ? '(cached)' : ''), inSteam: true, managed: !!e.managed,
      shortcutIdx: e.index, appid: e.appid, art: old ? old.art || {} : {},
      pendingArt: !!old?.pendingArt, pendingDetails: !!old?.pendingDetails, artApplied: !!old?.artApplied,
      artDraftScope: old?.artDraftScope,
      defaults: { display: name, query, exe: exe || null, startDir },
    });
  }
  for (const g of installed) {
    const old = keep.get(`steam:${g.appid}`);
    S.rows.push({
      folder: `steam:${g.appid}`, folderName: g.name, display: g.name,
      exe: null, startDir: g.installdir || '', launchOptions: '', candidates: [],
      score: 0, reason: 'installed Steam store game (managed by Steam)', query: g.name,
      steamAppid: g.appid, idMethod: 'steam', confidence: 1, source: 'steam',
      sgdbId: old ? old.sgdbId : (S.cfg.sgdb_map?.[`steam:${g.appid}`] || S.cfg.sgdb_cache?.[`steam:${g.appid}`] || null),
      sgdbName: old ? old.sgdbName : '', inSteam: true, managed: false,
      shortcutIdx: null, appid: null, art: old ? old.art || {} : {},
      pendingArt: !!old?.pendingArt, artApplied: !!old?.artApplied,
      artDraftScope: old?.artDraftScope,
    });
  }
  S.rows.forEach(restoreSteamDraft);
  // Shortcuts identify their executable. Native games identify their install folder.
  const shortcutByExe = new Map();
  const nativeRows = S.rows.filter(row => row.source === 'steam' && row.startDir)
    .sort((a, b) => folderKey(b.startDir).length - folderKey(a.startDir).length);
  for (const row of S.rows) {
    if (row.source !== 'shortcut' || !row.exe) continue;
    const key = folderKey(row.exe);
    if (!shortcutByExe.has(key)) shortcutByExe.set(key, row);
  }
  S.rows = S.rows.filter((row) => {
    if (row.source !== 'folder') return true;
    const owner = (!row.fromExecutableSearch && nativeRows.find(native => insideGameFolder(row.folder, native.startDir)))
      || row.exe && shortcutByExe.get(folderKey(row.exe));
    if (!owner) return true;
    if (owner.source === 'shortcut') {
      const known = new Set(owner.candidates.map(candidate => folderKey(candidate.path)));
      for (const candidate of row.candidates || []) {
        const path = folderKey(candidate.path);
        if (known.has(path)) continue;
        owner.candidates.push(candidate);
        known.add(path);
      }
    }
    // Pending edits take priority over applied previews. Steam edits win ties.
    if ((!owner.pendingArt && row.pendingArt)
      || !Object.keys(owner.art || {}).length && Object.keys(row.art || {}).length) {
      owner.art = row.art;
      owner.pendingArt = row.pendingArt;
      owner.artApplied = row.artApplied;
      if (row.logoPosition !== undefined && owner.logoPosition === undefined) owner.logoPosition = row.logoPosition;
      owner.sgdbId = row.sgdbId;
      owner.sgdbName = row.sgdbName;
    }
    return false;
  });
  renderRows();
}

function scannedRows(games) {
  const prev = new Map(S.rows.map((r) => [r.folder, r]));
  const folderCounts = new Map();
  for (const g of games) {
    const name = baseName(g.folder).toLowerCase();
    folderCounts.set(name, (folderCounts.get(name) || 0) + 1);
  }
  const rows = [];
  for (const g of games) {
    const old = prev.get(g.folder);
    const row = toRow(g, folderCounts.get(baseName(g.folder).toLowerCase()) === 1);
    if (old && (old.artDraftScope === undefined || old.artDraftScope === steamDraftScope())) {
      row.sgdbId = old.sgdbId;
      row.sgdbName = old.sgdbName;
      row.art = old.art || {};
      row.pendingArt = !!old.pendingArt;
      row.pendingDetails = !!old.pendingDetails;
      row.artApplied = !!old.artApplied;
      row.launchOptions = old.launchOptions || '';
    }
    // Rows without an exe or candidates cannot launch a game.
    if (!row.exe && !row.candidates.length) continue;
    if (!row.sgdbName && row.sgdbId) row.sgdbName = '(cached)';
    rows.push(row);
  }
  return rows;
}

function doFindExecutables() {
  const roots = (S.cfg.games_roots || []).filter(Boolean);
  if (!roots.length) { toast('Add a game folder before searching for launchers.'); return; }
  if (S.exePicker?.open) return;
  S.exePicker?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'exe-picker';
  dialog.setAttribute('closedby', 'any');
  dialog.setAttribute('aria-labelledby', 'exe-heading');
  dialog.innerHTML = `<h2 id="exe-heading">Find executables</h2>
    <p class="muted">Search added folders up to 10 levels down, including utilities and uninstallers. Select the executables you want to work with in Lib Shammes.</p>
    <p id="exe-summary" role="status" hidden></p>
    <div id="exe-results"></div>
    <div class="modal-foot"><button class="btn sm" id="exe-select-all" hidden>Select all</button>
      <button class="btn sm" id="exe-select-none" hidden>Select none</button><span class="spacer"></span>
      <button class="btn sm" id="exe-cancel">Cancel</button>
      <button class="btn sm primary" id="exe-search" hidden>Retry</button>
      <button class="btn sm primary" id="exe-add" hidden disabled>Show selected in Lib Shammes</button></div>`;
  document.body.appendChild(dialog);
  S.exePicker = dialog;
  const q = (sel) => dialog.querySelector(sel);
  dialog.addEventListener('close', () => {
    if (S.exePicker === dialog) S.exePicker = null;
    dialog.remove();
  }, { once: true });
  q('#exe-cancel').onclick = () => dialog.close();
  const scan = handleAction('Executable search', async () => {
    const search = q('#exe-search');
    const summary = q('#exe-summary');
    const results = q('#exe-results');
    const add = q('#exe-add');
    const selectAll = q('#exe-select-all');
    const selectNone = q('#exe-select-none');
    search.disabled = true;
    summary.hidden = false;
    summary.textContent = 'Searching…';
    try {
      const claimed = (libraryView() === 'desktop' ? S.desktop.rows : S.rows).filter((r) => r.exe).map((r) => r.exe);
      const { games, truncated } = await window.api.findExecutables({ roots, claimed });
      if (!dialog.open) return;
      summary.textContent = `${games.length} executable(s) found. Already listed executables are excluded.`
        + (truncated ? ' Search limit reached. Search smaller folders to see more results.' : '');
      const selected = new Set();
      const choices = [];
      const updateSelection = () => {
        add.disabled = !selected.size;
        add.textContent = selected.size ? `Show ${selected.size} in Lib Shammes` : 'Show selected in Lib Shammes';
      };
      const fragment = document.createDocumentFragment();
      for (const game of games) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.onchange = () => {
          if (checkbox.checked) selected.add(game); else selected.delete(game);
          updateSelection();
        };
        const name = document.createElement('span');
        name.textContent = game.exePath;
        label.append(checkbox, name);
        fragment.appendChild(label);
        choices.push([checkbox, game]);
      }
      results.replaceChildren(fragment);
      search.hidden = true;
      selectAll.hidden = selectNone.hidden = false;
      selectAll.disabled = selectNone.disabled = !choices.length;
      selectAll.onclick = () => {
        for (const [checkbox, game] of choices) { checkbox.checked = true; selected.add(game); }
        updateSelection();
      };
      selectNone.onclick = () => {
        for (const [checkbox] of choices) checkbox.checked = false;
        selected.clear();
        updateSelection();
      };
      add.hidden = false;
      add.onclick = handleAction('Add executables', async () => {
        const setting = executableSetting();
        await savePatch({ [setting]: [...(S.cfg[setting] || []), ...selected] });
        dialog.close();
        await showLibrary();
        log(`Added ${selected.size} launcher(s).`, libraryView());
      });
    } catch (e) {
      if (!dialog.open) return;
      summary.textContent = 'Search failed. You can try again.';
      search.hidden = false;
      throw e;
    } finally {
      search.disabled = false;
    }
  });
  q('#exe-search').onclick = scan;
  dialog.showModal();
  scan();
}

async function refreshSteamState(entries) {
  try {
    entries ||= await window.api.steamRead();
  } catch (e) {
    renderRows();
    return; // Steam not configured yet - fine on first run
  }
  const byExe = new Map(entries.map((e) => [String(e.exe).replace(/^"|"$/g, '').toLowerCase(), e]));
  const byAppid = new Map(entries.map((e) => [Number(e.appid), e]));
  for (const r of S.rows) {
    if (r.source !== 'folder') continue; // steam-native rows carry their own flags
    const known = r.managed && r.appid != null ? byAppid.get(Number(r.appid)) : null;
    r.inSteam = false;
    r.managed = false;
    r.shortcutIdx = null;
    r.appid = null;
    const hit = known || (r.exe && byExe.get(String(r.exe).toLowerCase()));
    if (hit) {
      r.inSteam = true;
      r.managed = !!hit.managed;
      r.shortcutIdx = hit.index;
      r.appid = hit.appid;
      r.startDir = hit.startDir || r.startDir;
      r.launchOptions = hit.launchOptions || '';
    }
  }
  renderRows();
}

let libraryLoad = null;
let loadedLibraryKey = null;
function libraryKey() {
  return JSON.stringify([S.cfg.games_roots, S.cfg.folder_depths, S.cfg.steam_path, S.cfg.steam_user_id, S.cfg.steam_executables]);
}
function loadLibrary(force = false) {
  if (S.applyingSteam) return Promise.resolve();
  const key = libraryKey();
  if (libraryLoad) return libraryLoad.then(() => libraryKey() !== loadedLibraryKey ? loadLibrary() : undefined);
  if (!force && key === loadedLibraryKey) return Promise.resolve();
  libraryLoad = refreshLibrary(force).then(() => { loadedLibraryKey = key; }).finally(() => { libraryLoad = null; });
  return libraryLoad;
}
async function doRefresh() {
  if (S.applyingSteam) return Promise.resolve();
  await steamPresentOrToast();
  return loadLibrary(true);
}

async function refreshLibrary(force = false) {
  const button = $('#btn-refresh');
  button.disabled = true;
  S.loadingLibrary = true;
  S.cardArtCache.clear();
  renderRows();
  try {
    const roots = (S.cfg.games_roots || []).filter(Boolean);
    status('Refreshing library…');
    const [games, entries, installed] = await Promise.all([
      roots.length || S.cfg.steam_executables?.length ? window.api.scanStart({ roots, force }) : [],
      window.api.steamRead(), window.api.steamGames(),
    ]);
    S.rows = [...scannedRows(games), ...S.rows.filter((r) => r.source !== 'folder')];
    await syncSteamLibrary(entries, installed);
    await refreshSteamState(entries);
    status('Steam library refreshed.');
  } finally {
    S.loadingLibrary = false;
    button.disabled = false;
    renderRows();
  }
}

async function doClear() {
  if (S.applyingSteam || S.loadingLibrary) return;
  if (!await confirmDlg('Clear unapplied changes?',
    "Clear changes that haven't been applied to Steam?\n\nNames and launchers already in Steam will be kept. Artwork already written to Steam won't be deleted. Your selection will stay the same.",
    { confirmText: 'Clear' })) return;
  const entries = await window.api.steamRead();
  const byAppid = new Map(entries.map((entry) => [Number(entry.appid), entry]));
  const byExe = new Map(entries.map((entry) => [folderKey(String(entry.exe || '').replace(/^"|"$/g, '')), entry]));
  const patch = Object.fromEntries(['title_map', 'exe_map', 'sgdb_map', 'sgdb_cache', 'steam_launch']
    .map((key) => [key, { ...S.cfg[key] }]));
  const resets = [];
  for (const row of S.rows) {
    delete patch.steam_launch[folderKey(row.folder)];
    if (row.source === 'steam') {
      for (const key of ['sgdb_map', 'sgdb_cache']) delete patch[key][folderKey(row.folder)];
      resets.push([row, { art: {}, sgdbId: null, sgdbName: '', pendingArt: false, pendingDetails: false, artApplied: false, logoPosition: undefined }, null]);
      continue;
    }
    const reset = { ...row.defaults, art: {}, sgdbId: null, sgdbName: '', pendingArt: false, pendingDetails: false, artApplied: false, logoPosition: undefined };
    const entry = (row.appid != null && byAppid.get(Number(row.appid)))
      || (row.exe && byExe.get(folderKey(row.exe))) || (reset.exe && byExe.get(folderKey(reset.exe)));
    if (entry) {
      reset.display = reset.query = entry.appName;
      reset.exe = String(entry.exe || '').replace(/^"|"$/g, '');
      reset.startDir = String(entry.startDir || '').replace(/^"|"$/g, '') || parentDir(reset.exe);
      if (row.fromExecutableSearch) {
        reset.folder = reset.exe;
        reset.folderName = baseName(reset.startDir);
      }
    }
    for (const map of Object.values(patch)) {
      for (const key of [folderKey(row.folder), folderKey(row.defaults?.folder), row.folderName, row.display, row.defaults?.display]) delete map[key];
    }
    resets.push([row, reset, entry]);
  }
  for (const [row, reset, entry] of resets) {
    if (entry && row.source === 'folder') {
      const folder = reset.folder || row.folder;
      patch.title_map[folderKey(folder)] = reset.display;
      if (!row.fromExecutableSearch) patch.exe_map[folderKey(folder)] = reset.exe.startsWith(folder)
        ? reset.exe.slice(folder.length).replace(/^[\\/]/, '') : baseName(reset.exe);
    }
  }
  await savePatch(patch);
  await saveSteamDrafts([], S.rows.flatMap(steamDraftKeys));
  for (const [row, reset] of resets) Object.assign(row, reset);
  const folderExes = new Set(S.rows.filter((row) => row.source === 'folder' && row.exe).map((row) => folderKey(row.exe)));
  const unique = new Map();
  S.rows = S.rows.filter((row) => {
    const key = row.exe && folderExes.has(folderKey(row.exe)) ? `exe:${folderKey(row.exe)}` : rowKey(row);
    const existing = unique.get(key);
    if (!existing) { unique.set(key, row); return true; }
    return false;
  });
  await refreshSteamState(entries);
  status('Unapplied changes cleared.');
}

function rowPayload(r) {
  return {
    folder: r.folder, display: r.display, exe: r.exe, startDir: r.startDir,
    launchOptions: r.launchOptions, sgdbId: r.sgdbId, art: r.art,
    source: r.source, shortcutIdx: r.shortcutIdx, appid: r.appid, steamAppid: r.steamAppid,
    ...(r.logoPosition !== undefined ? { logoPosition: r.logoPosition } : {}),
    launchSettings: S.cfg.steam_launch?.[folderKey(r.folder)],
  };
}

async function writeArtwork(rows, kinds) {
  const result = await window.api.artDownload({
    rows: rows.map(rowPayload),
    kinds,
  });
  const byFolder = new Map(result.rows.map((r) => [r.folder, r]));
  for (const r of S.rows) {
    const u = byFolder.get(r.folder);
    if (u) {
      r.art = { ...r.art, ...u.art };
      for (const kind of u.appliedKinds || []) if (!u.art[kind]) delete r.art[kind];
      if (u.logoPositionApplied) delete r.logoPosition;
      r.pendingArt = !!u.failedKinds?.length || r.logoPosition !== undefined;
      r.artApplied ||= !!u.appliedKinds?.length;
    }
  }
  S.cardArtCache.clear();
  result.lines.forEach(line => log(line));
  await saveSteamDrafts(S.rows.filter(r => byFolder.has(r.folder)));
  renderRows();
  return result;
}

function reportArtwork({ saved, failed, warning }, success) {
  const message = failed ? `${saved} artwork saved, ${failed} failed. Check the log.`
    : saved ? success : 'No artwork changed. Check the log for skipped images.';
  const entry = log(message);
  status(message);
  toast(warning ? `${message} ${warning}` : message, entry);
}

function canWriteShortcut(row) {
  return !!row.exe && (row.source === 'folder' || (row.source === 'shortcut' && row.managed));
}
async function doAddToSteam(targetRows) {
  if (S.applyingSteam || S.loadingLibrary) return;
  S.applyingSteam = true;
  updateLibraryActions();
  try {
    if (!await steamPresentOrToast()) return;
    await applyToSteam(targetRows);
  } finally { S.applyingSteam = false; updateLibraryActions(); }
}
async function applyToSteam(targetRows) {
  const selected = targetRows;
  const native = selected.filter((r) => r.source === 'steam');
  const nativeArt = native.map((r) => ({ ...r, art: Object.fromEntries(
    Object.entries(r.art || {}).filter(([, art]) => !art.automatic && !art.current)
  ) })).filter((r) => Object.keys(r.art).length || r.logoPosition !== undefined);
  const eligible = selected.filter(canWriteShortcut);
  const noExe = selected.filter((r) => !r.exe && r.source !== 'steam');
  if (noExe.length) log(`Skipping ${noExe.length} without exe: ${noExe.slice(0, 5).map((r) => r.display).join(', ')}`);
  if (!eligible.length) {
    if (native.length) {
      if (!nativeArt.length) { toast('Choose artwork first.'); return; }
      status(`Applying artwork to ${nativeArt.length} Steam games…`);
      reportArtwork(await writeArtwork(nativeArt, []), 'Artwork applied to Steam.');
      return;
    }
    toast('No selected games with a .exe.'); return;
  }
  status(`Adding ${eligible.length} games to Steam…`);
  log(`Adding ${eligible.length} games…`);
  let writeCompleted = false;
  try {
    const draftKeys = eligible.map(steamDraftKey);
    const { rows: back, nativeRows = [], lines, added, updated, artworkSaved, artworkFailed = 0, warning } = await window.api.steamAdd({
      rows: eligible.map(rowPayload),
      nativeRows: nativeArt.map(rowPayload),
      kinds: [...new Set(eligible.flatMap(row => Object.keys(row.art || {})))],
    });
    writeCompleted = true;
    const byFolder = new Map(back.map((r) => [r.folder, r]));
    for (const r of S.rows) {
      const u = byFolder.get(r.folder);
      if (u) {
        r.shortcutIdx = u.shortcutIdx;
        r.appid = u.appid;
        r.managed = u.managed;
        if (r.source === 'shortcut') {
          r.folder = `shortcut://${u.appid}`;
        }
        r.inSteam = true;
        if (u.logoPositionApplied) delete r.logoPosition;
        r.pendingArt = !!u.failedKinds?.length || r.logoPosition !== undefined;
        r.pendingDetails = false;
        r.artApplied = !!Object.keys(u.art || {}).length || r.artApplied;
        if (u.art) r.art = u.art;
      }
    }
    await syncCfg();
    S.cardArtCache.clear();
    lines.forEach(line => log(line));
    for (const row of nativeRows) {
      const original = S.rows.find(r => r.folder === row.folder);
      if (original) { original.art = row.art;
        if (row.logoPositionApplied) delete original.logoPosition;
        original.pendingArt = !!row.failedKinds?.length || original.logoPosition !== undefined;
        original.artApplied ||= !!row.appliedKinds?.length; }
    }
    await saveSteamDrafts([...eligible, ...native], draftKeys);
    renderRows();
    const failed = artworkFailed;
    const changed = added + updated + artworkSaved;
    const message = changed || failed ? `${added} added, ${updated} updated, ${artworkSaved} artwork saved.`
      + (failed ? ` ${failed} failed. Check the log.` : '')
      : 'No changes were made. Check the log.';
    const entry = log(message);
    status(message);
    toast(warning ? `${message} ${warning}` : message, entry);
  } catch (e) {
    const message = writeCompleted ? 'Steam write completed, but the library could not update' : 'Write failed';
    const feedback = `${message}: ${e.message || e}`;
    toast(feedback, log(feedback));
  }
}

function canRemoveSteamShortcut(row) {
  return !!row?.inSteam && (row.source === 'shortcut' || row.managed);
}

async function doRemoveFromSteam() {
  const row = steamEditorRow();
  const rows = canRemoveSteamShortcut(row) ? [row] : [];
  if (!rows.length || S.applyingSteam || S.loadingLibrary) return;
  const names = rows.slice(0, 12).map((r) => `• ${r.display}`).join('\n')
    + (rows.length > 12 ? `\n… and ${rows.length - 12} more` : '');
  if (!await confirmDlg('Remove from Steam',
    `Remove ${rows.length} shortcuts?\n\n${names}\n\nArt files are left alone. Steam will close and reopen if it is running.`)) return;
  const { removed, backup, warning } = await window.api.steamRemove({
    rows: rows.map(rowPayload),
  });
  for (const r of rows) {
    r.inSteam = false;
    r.managed = false;
    r.shortcutIdx = null;
    r.appid = null;
  }
  await closeArtModal(false);
  await refreshSteamState();
  await syncSteamLibrary(); // drop shortcut rows whose entries just vanished
  log(`Removed ${removed} shortcuts. Backup: ${backup || 'none'}.`);
  status(`Removed ${removed}.`);
  if (warning) toast(warning, log(warning));
}

async function steamPresentOrToast() {
  if (!S.cfg.steam_path) return true;
  const ok = await window.api.steamVerify(S.cfg.steam_path).catch(() => false);
  if (!ok) {
    S.steamFound = false;
    if ($('#library-setup')?.nodeType) renderLibrarySetup();
    toast('Steam was not found at the saved path. Use Connect Steam to update it.');
  }
  return ok;
}

async function doPruneMissing() {  let stale;
  try {
    stale = await window.api.steamPrune();
  } catch (e) {
    toast(e.message || String(e));
    return;
  }
  if (!stale.length) {
    toast('No stale shortcuts - every game the app added still exists.');
    log('Prune check: nothing stale.');
    return;
  }
  const names = stale.slice(0, 12).map((s) => `• ${s.display}`).join('\n')
    + (stale.length > 12 ? `\n… and ${stale.length - 12} more` : '');
  if (!await confirmDlg('Prune missing games',
    `${stale.length} shortcut(s) the app added point at exes that no longer exist:\n\n${names}\n\nRemove them? Art files are left alone. Steam will close and reopen if it is running.`)) return;
  const { removed, backup, warning } = await window.api.steamRemove({
    rows: stale.map((s) => ({ display: s.display, exe: s.exe })),
  });
  await refreshSteamState();
  await syncSteamLibrary();
  log(`Pruned ${removed} stale shortcuts. Backup: ${backup || 'none'}.`);
  status(`Pruned ${removed}.`);
  if (warning) toast(warning, log(warning));
}

let desktopSave = Promise.resolve();
const desktopEditFields = ['display', 'exe', 'args', 'admin', 'iconChoice', 'sgdbId', 'sgdbName'];
const desktopChoiceFields = [...desktopEditFields, 'icon', 'iconIndex'];
function groupDesktopDestinations(rows) {
  rows = rows.map(row => ({ ...row, destination: row.destination || 'desktop' }));
  const gameKey = row => folderKey(row.exePath || row.exe);
  const groups = [];
  const existing = rows.filter(row => row.shortcut);
  for (const row of rows.filter(row => row.shortcut || !existing.some(link => gameKey(link) === gameKey(row)))) {
    const group = groups.find(group => gameKey(group[0]) === gameKey(row));
    if (group) group.push(row);
    else groups.push([row]);
  }
  for (const group of groups) {
    group.sort((a, b) => Number(a.destination === 'start-menu') - Number(b.destination === 'start-menu'));
    const source = group[0];
    for (const destination of ['desktop', 'start-menu']) if (!group.some(row => row.destination === destination)) {
      const placeholder = rows.find(row => !row.shortcut && row.destination === destination
        && gameKey(row) === gameKey(source) && !groups.some(group => group.some(member => member.id === row.id)));
      group.push({ ...source, id: placeholder?.id || `paired:${destination}:${source.id}`, destination,
        shortcut: null, signature: undefined });
    }
  }
  return groups;
}
function desktopGameMembers(row) {
  return S.desktop.groups?.find(group => group.includes(row)) || [row];
}
function desktopMembers(row) {
  const destination = S.cfg?.desktop_destination || 'both';
  return desktopGameMembers(row).filter(member => destination === 'both' || member.destination === destination);
}
function desktopChoiceKey(row) {
  return row.choiceKey || folderKey(row.exePath || row.exe);
}
function desktopChoiceState(choice, applied = false) {
  return { ...choice, draft: applied ? null : choice || null,
    art: choice?.iconChoice ? { icon: choice.iconChoice } : {}, saved: applied };
}
function desktopCards() {
  return S.desktop.groups?.map(group => group[0]) || S.desktop.rows;
}
function desktopLocationState(members) {
  if (members.every(member => member.shortcut)) return 'Existing';
  const existing = members.find(member => member.shortcut);
  return existing ? existing.destination === 'start-menu' ? 'Start menu only' : 'Desktop only' : 'Not added';
}
function desktopApplyRows(cards) {
  return cards.flatMap(row => {
    const choice = S.cfg?.desktop_choices?.[desktopChoiceKey(row)];
    const shared = Object.fromEntries(desktopChoiceFields.map(key => [key, (choice || row)[key]]));
    if (choice) shared.choiceRevision = choice.revision;
    return desktopMembers(row).map(member => ({ ...member, ...shared }));
  });
}
function saveDesktopDraft(row, update = row) {
  const members = desktopGameMembers(row);
  const key = desktopChoiceKey(row);
  const edits = Object.fromEntries(desktopChoiceFields.map(field => [field, update[field]]));
  desktopSave = desktopSave.catch(() => {}).then(async () => {
    const choice = { ...edits, revision: (S.cfg.desktop_choices?.[key]?.revision || 0) + 1 };
    await savePatch({ desktop_choices: { ...S.cfg.desktop_choices, [key]: choice } });
    for (const member of members) {
      Object.assign(member, desktopChoiceState(choice), { choiceKey: key });
    }
  });
  return desktopSave;
}

async function refreshDesktop(force = true) {
  const d = S.desktop;
  if (d.busy) return;
  const key = JSON.stringify([S.cfg.games_roots, S.cfg.folder_depths, S.cfg.desktop_executables]);
  if (!force && d.loadedKey === key) return;
  if (force) S.cardArtCache.clear();
  d.busy = true;
  renderDesktop();
  try {
    await desktopSave;
    const old = new Map(d.rows.map((row) => [row.id, row]));
    const result = await window.api.desktopScan(force);
    const groups = groupDesktopDestinations(result.rows);
    const choices = { ...S.cfg.desktop_choices };
    let migrated = false;
    for (const group of groups) {
      const key = desktopChoiceKey(group[0]);
      for (const member of group) member.choiceKey = key;
      if (choices[key]) continue;
      const legacy = group.map(member => ({ member, draft: S.cfg.desktop_overrides[member.id] }))
        .find(({ member, draft }) => draft && Object.hasOwn(draft, 'args') && draft.signature === member.signature);
      if (!legacy) continue;
      const saved = { ...legacy.member, ...legacy.draft };
      choices[key] = { ...Object.fromEntries(desktopChoiceFields.map(field => [field, saved[field]])), revision: 1 };
      migrated = true;
    }
    if (migrated) await savePatch({ desktop_choices: choices });
    d.rows = groups.flat().map((row) => {
      const previous = old.get(row.id);
      const choice = S.cfg.desktop_choices?.[row.choiceKey];
      const record = S.cfg.desktop_overrides[row.id];
      if (choice) {
        const applied = record?.choiceRevision === choice.revision && record.signature === row.signature;
        return { ...row, ...desktopChoiceState(choice, applied), source: 'desktop', error: '' };
      }
      let draft = previous?.draft || record;
      if (draft?.display === '(cached)' && draft.sgdbName === '(cached)' && row.query) {
        draft = { ...draft, display: row.query, sgdbName: row.query, exe: row.exe, args: row.args };
      }
      const stale = draft && draft.signature !== row.signature;
      const pending = draft && Object.hasOwn(draft, 'args');
      const sameGame = folderKey(draft?.exe || previous?.exe) === folderKey(row.exe);
      const match = stale && sameGame ? { sgdbId: draft.sgdbId, sgdbName: draft.sgdbName } : {};
      return { ...row, ...match, ...(stale ? {} : draft), source: 'desktop',
        draft: stale || !pending ? null : draft, art: draft?.iconChoice && !stale ? { icon: draft.iconChoice } : {},
        saved: !stale && previous?.saved, error: '' };
    });
    d.groups = groups.map(group => group.map(row => d.rows.find(member => member.id === row.id)));
    for (const group of d.groups || []) {
      const source = group.find(row => row.draft) || group[0];
      const match = group.find(row => row.sgdbId);
      if (!source.sgdbId && match) Object.assign(source, { sgdbId: match.sgdbId, sgdbName: match.sgdbName });
      for (const member of group) if (member !== source) {
        for (const field of [...desktopEditFields, 'icon', 'iconIndex']) member[field] = source[field];
        member.art = { ...source.art };
      }
    }
    result.warnings.forEach(line => log(line, 'desktop'));
    d.loadedKey = key;
    status(d.rows.length ? 'Windows library refreshed.' : 'No Windows games found.');
  } finally { d.busy = false; renderDesktop(); }
}

function desktopVisible() {
  const query = $('#desktop-filter').value.toLocaleLowerCase();
  return desktopCards().filter((row) => (!$('#desktop-hide').checked || desktopMembers(row).some(member => !member.shortcut))
    && `${row.display} ${row.exe} ${row.shortcut || ''} ${row.args}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.display.localeCompare(b.display, undefined, { sensitivity: 'base', numeric: true }));
}

async function desktopCardCoverSource(row) {
  const choice = row.iconChoice || row.art?.icon;
  if (choice?.exeIcon) return window.api.desktopIcon(row.exe).catch(() => null);
  if (choice?.file) return /\.(exe|dll)$/i.test(choice.file)
    ? window.api.desktopIcon(choice.file, 0).catch(() => null)
    : window.api.artThumbnail(choice.file).catch(() => window.api.artPreviewFile(choice.file).catch(() => null));
  if (choice?.thumb) return { src: choice.thumb, fallback: choice.url };
  if (choice?.url) return choice.url;
  return desktopIconPreview(row).catch(() => null);
}

function renderDesktop() {
  const d = S.desktop;
  const visible = desktopVisible();
  const reviewCount = reviewCandidates('desktop').length;
  const missingCount = missingShortcuts('desktop').length;
  $('#desktop-add').textContent = reviewCount ? `Review ${reviewCount} change${reviewCount === 1 ? '' : 's'}`
    : missingCount ? 'Create shortcuts' : 'Review changes';
  const cards = desktopCards();
  $('#desktop-count').textContent = `${cards.length} game${cards.length === 1 ? '' : 's'}`;
  const pending = reviewCount;
  $('#desktop-pending').hidden = pending === 0;
  $('#desktop-pending').textContent = pending ? `${pending} ready to apply` : '';
  $('#desktop-grid-count').textContent = visible.length === cards.length ? '' : `${visible.length} game${visible.length === 1 ? '' : 's'} shown`;
  const body = $('#desktop-games tbody');
  body.innerHTML = '';
  d.coverObserver?.disconnect();
  const root = $('#page-desktop');
  d.coverObserver = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      for (const entry of entries) if (entry.isIntersecting) {
        d.coverObserver.unobserve(entry.target);
        loadCardCover(entry.target._desktopRow, entry.target);
      }
    }, { root, rootMargin: '420px 0px' }) : null;
  if (!visible.length) {
    if (d.busy) renderEmptyLibrary(body, 'Loading Windows games…');
    else if (cards.length) renderEmptyLibrary(body, 'No games match these filters.', 'Clear filters', () => {
      $('#desktop-filter').value = '';
      $('#desktop-hide').checked = false;
      renderDesktop();
      $('#desktop-filter').focus();
    });
    else renderEmptyLibrary(body, 'No games found for Windows shortcuts.', 'Add games folder', openFolders);
  }
  for (const row of visible) {
    const members = desktopMembers(row);
    const state = members.some(member => member.error) ? ['Issue', 'issue'] : members.some(member => member.saving) ? ['Saving…', 'pending']
      : members.some(member => member.draft) ? ['Ready', 'pending'] : members.every(member => member.saved) ? ['Applied', '']
        : [desktopLocationState(members), ''];
    const destination = members.length > 1 ? 'Desktop + Start menu' : row.destination === 'start-menu' ? 'Start menu'
      : row.destination === 'both' ? 'Desktop + Start menu' : 'Desktop';
    const token = desktopCoverToken(row);
    const tr = document.createElement('tr');
    tr.dataset.key = row.id;
    tr.className = 'game-card-row';
    const subtitle = [baseName(row.exe) || 'No launcher', row.args || ''].filter(Boolean).join(' · ');
    tr.innerHTML = `<td><div class="game-tile"><button class="game-open" type="button" aria-label="Choose icon for ${esc(row.display)}">
      <div class="cover-wrap">
        <div class="cover-fallback"><img src="../assets/app-icon.svg" alt=""><span>${esc(initials(row.display))}</span></div>
        <img class="game-cover desktop-cover" data-cover-token="${esc(token)}" alt="Shortcut icon for ${esc(row.display)}" decoding="async" hidden>
        </div></button>
        <div class="game-card-copy"><button class="game-name" type="button" aria-label="Settings for ${esc(row.display)}">${esc(row.display)}</button>
        <span class="game-meta"><span class="source-label">${esc(destination)}</span><span class="game-state ${state[1]}">${esc(state[0])}</span></span>
        <span class="game-subtitle" title="${esc(`${row.exe || ''}${row.args ? ` · ${row.args}` : ''}`)}">${wrapText(subtitle)}</span></div>
      </div></td>`;
    tr._desktopRow = row;
    body.appendChild(tr);
    if (d.coverObserver) d.coverObserver.observe(tr);
    else loadCardCover(row, tr);
  }
  for (const id of ['desktop-add', 'desktop-refresh']) $('#' + id).disabled = d.busy;
  $('#shortcut-location').disabled = d.busy;
  $('#desktop-add').disabled ||= !reviewCount && !missingCount;
  $('#desktop-games').inert = d.busy && !d.applying;
  for (const id of ['desktop-hide']) $('#' + id).disabled = d.busy && !d.applying;
}

function desktopCoverToken(row) {
  return `desktop:${JSON.stringify([row.id, row.exe, row.icon, row.iconIndex, row.signature, row.iconChoice || row.art?.icon])}`;
}
function desktopIconPreview(row) {
  if (/\.(ico|png|jpe?g|webp|bmp)$/i.test(row.icon || '')) return window.api.artPreviewFile(row.icon);
  if (/\.(exe|dll)$/i.test(row.icon || '')) return window.api.desktopIcon(row.icon, row.iconIndex || 0);
  return window.api.desktopIcon(row.icon ? row.shortcut || row.icon : row.exe);
}

function localArtPreview(file) {
  return /\.(exe|dll)$/i.test(file) ? window.api.desktopIcon(file, 0) : window.api.artPreviewFile(file);
}

function renderDesktopGameSettings(row) {
  const host = $('#desktop-game-settings');
  const members = desktopMembers(row);
  const exes = [...new Set([row.exe, ...(row.candidates || []).map(item => item.path)])];
  host.innerHTML = `<details class="launcher-editor" open><summary>Name and launcher</summary><label class="fld"><span>Shortcut name</span><input type="text" data-field="display" value="${esc(row.display)}"></label>
    <label class="field-label" for="desktop-exe">Executable</label><div class="launcher-choice"><details class="launcher-candidates"><summary><span></span></summary><select id="desktop-exe" aria-label="Executable choices" data-field="exe" hidden>${exes.map(exe => `<option value="${esc(exe)}" ${exe === row.exe ? 'selected' : ''}>${esc(baseName(exe))}</option>`).join('')}</select><div class="choice-list"></div></details>
    <button class="btn sm" data-desktop="browse" type="button">Browse</button></div>
    <label class="fld"><span>Launch arguments</span><input type="text" data-field="args" value="${esc(row.args)}"></label>
    <label class="check desktop-admin"><input type="checkbox" data-field="admin" ${row.admin ? 'checked' : ''}> Run as administrator</label>
    <div class="status-line">${members.map(member => esc(member.error || member.shortcut || '')).filter(Boolean).join('<br>')}</div></details>
    <div class="manage-actions"><button class="btn sm" id="desktop-game-apply" type="button">${S.cfg.desktop_destination === 'start-menu' ? 'Apply to Start menu' : S.cfg.desktop_destination === 'both' ? 'Apply shortcuts' : 'Apply to Desktop'}</button></div>`;
  updateLauncherChoice($('#desktop-exe', host));
  $('#desktop-game-apply', host).onclick = handleAction('Add to Desktop', async () => {
    const modal = S.modal;
    await closeArtModal(artworkSelectionChanged(modal));
    if (!S.modal) await applyDesktopShortcuts([row]);
  });
  for (const input of $$('[data-field]', host)) input.onchange = handleAction('Save Desktop changes', async () => {
    if (input.dataset.field === 'display' && S.modal?.row === row) S.modal.renamedShortcut = true;
    row[input.dataset.field] = input.type === 'checkbox' ? input.checked : input.value;
    if (input.dataset.field === 'exe') updateLauncherChoice(input);
    await saveDesktopDraft(row);
    renderDesktop();
    if (S.modal?.row === row) $('#art-title').textContent = row.display;
  });
  $('[data-desktop="browse"]', host).onclick = handleAction('Choose launcher', async () => {
    const modal = S.modal;
    const exe = await window.api.filesPickExe(parentDir(row.exe));
    if (!exe || S.modal !== modal) return;
    row.exe = exe;
    await saveDesktopDraft(row);
    renderDesktop();
    if (S.modal === modal) renderDesktopGameSettings(row);
  });
}

async function renderDesktopIconChoices() {
  const m = S.modal;
  const exe = await window.api.desktopIcon(m.row.exe).catch(() => null);
  if (S.modal !== m) return;
  const slot = $('#art-stock');
  slot.hidden = !exe;
  slot.replaceChildren(...(exe ? [artThumb({ url: exe, width: 256, height: 256 }, 'Executable icon', { exeIcon: true, current: !m.row.icon })] : []));
  const choice = m.row.iconChoice;
  const url = choice?.file ? await localArtPreview(choice.file).catch(() => null) : choice?.url
    || (m.row.icon ? await desktopIconPreview(m.row).catch(() => null) : null);
  if (S.modal !== m || !url || choice?.exeIcon) return;
  const current = $('#art-choice');
  current.hidden = false;
  current.replaceChildren(artThumb({ ...choice, url, width: 256, height: 256 }, 'Current icon', choice || { current: true, keepIcon: true }));
  $$('#art-grid > .thumb').forEach((cell) => { cell.hidden = cell._broken || sameArtwork(choice, cell._art); });
}

function wireDesktop() {
  $('#desktop-refresh').onclick = handleAction('Refresh Desktop', refreshDesktop);
  $('#desktop-filter').addEventListener('input', () => renderDesktop());
  $('#desktop-hide').addEventListener('change', () => renderDesktop());
  $('#desktop-games tbody').onclick = (e) => {
    const card = e.target.closest('.game-card-row');
    const row = S.desktop.rows.find((item) => item.id === card?.dataset.key);
    if (!row) return;

    openArtModal(row, e.target.closest('.game-open') ? 'icon' : 'manage');
  };
  $('#desktop-add').onclick = () => openReview('desktop');
}

async function applyDesktopShortcuts(rowsOverride, options = {}) {
  const d = S.desktop;
  if (d.busy) return;
  d.busy = true; renderDesktop();
  try {
    await desktopSave;
    const rows = desktopApplyRows(rowsOverride);
    if (!rows.length) return;
    const updates = rows.filter((row) => row.shortcut).length;
    const title = rowsOverride ? $('#desktop-game-apply')?.textContent || $('#desktop-add').textContent : $('#desktop-add').textContent;
    const creates = rows.length - updates;
    if (!options.reviewed && !await confirmDlg(title, `Create ${creates} shortcut${creates === 1 ? '' : 's'} and update ${updates} existing shortcut${updates === 1 ? '' : 's'}?`)) return;
    d.applying = true;
    rows.forEach((row) => { d.rows.find(member => member.id === row.id).saving = true; });
    renderDesktop();
    const results = await window.api.desktopApply(rows);
    await syncCfg();
    for (const result of results) {
      const row = d.rows.find((item) => item.id === result.id);
      if (result.ok || result.refreshed) {
        const choice = S.cfg.desktop_choices?.[desktopChoiceKey(row)];
        Object.assign(row, result.row || { shortcut: null, signature: undefined },
          desktopChoiceState(choice, result.ok), { error: '' });
      } else row.error = result.error;
      log(`${row.display}: ${result.ok ? 'Shortcut saved.' : result.error}`, 'desktop');
      if (result.warning) log(result.warning, 'desktop');
    }
    const refreshed = results.filter((result) => result.refreshed).length;
    const saved = results.filter(result => result.ok).length;
    status(`${saved} shortcut${saved === 1 ? '' : 's'} saved, ${results.filter((result) => !result.ok && !result.refreshed).length} failed.`);
    if (refreshed) toast('Shortcut refreshed. Review changes and apply again.');
  } finally {
    d.busy = false; d.applying = false;
    d.rows.forEach((row) => { row.saving = false; });
    renderDesktop();
  }
}

// ------------------------------------------------------- artwork modal
const ART_TABS = [['grid', 'Cover'], ['wide', 'Wide cover'], ['hero', 'Background'], ['logo', 'Logo'], ['icon', 'Icon']];
const modalTabs = () => S.modal?.row.source === 'desktop' ? [['icon', 'Icon'], ['manage', 'Manage']] : [...ART_TABS, ['manage', 'Manage']];
let artModalMotion = 0;

function animateArtModal(open) {
  const overlay = $('#art-overlay');
  const modal = $('#art-modal');
  const motion = ++artModalMotion;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const opacity = overlay.hidden || reduced ? 0 : getComputedStyle(overlay).opacity;
  const transform = overlay.hidden || reduced ? 'translateY(8px) scale(.99)' : getComputedStyle(modal).transform;
  overlay.getAnimations({ subtree: true }).forEach(animation => animation.cancel());
  overlay.inert = !open;
  if (reduced) {
    overlay.hidden = !open;
    return;
  }
  overlay.hidden = false;
  const options = { duration: open ? 240 : 150, easing: 'cubic-bezier(.2,.8,.2,1)', fill: 'both' };
  const animations = [
    overlay.animate([{ opacity }, { opacity: open ? 1 : 0 }], options),
    modal.animate([{ transform }, { transform: open ? 'none' : 'translateY(4px) scale(.99)' }], options),
  ];
  const finished = Promise.allSettled(animations.map(animation => animation.finished));
  let timer;
  const fallback = new Promise((resolve) => { timer = setTimeout(resolve, options.duration + 250); });
  finished.then(() => clearTimeout(timer));
  Promise.race([finished, fallback]).then(() => {
    if (motion !== artModalMotion) return;
    overlay.hidden = !open;
    animations.forEach(animation => animation.cancel());
  });
}

const ART_DIMENSIONS = {
  grid: ['600x900', '342x482', '660x930', '512x512', '1024x1024'],
  wide: ['460x215', '920x430', '512x512', '1024x1024'],
  hero: ['1920x620', '3840x1240', '1600x650'],
  icon: [1024, 768, 512, 310, 256, 194, 192, 180, 160, 152, 150, 144, 128, 120, 114,
    100, 96, 90, 80, 76, 72, 64, 60, 57, 56, 54, 48, 40, 35, 32, 28, 24, 20, 16, 14, 10, 8].map(String),
};
const dimensionLabel = (kind, value) => kind === 'icon' ? `${value}x${value}` : value;

function savedPickerFilters(kind, defaultsOnly = false) {
  return { static: true, animated: !!S.cfg.include_animated, untagged: true,
    nsfw: !!S.cfg.include_nsfw, humor: !!S.cfg.include_humor, epilepsy: true,
    ...(ART_DIMENSIONS[kind] ? { dimensions: ART_DIMENSIONS[kind].filter(value =>
      !['grid', 'wide'].includes(kind) || !['512x512', '1024x1024'].includes(value)) } : {}),
    ...(defaultsOnly ? {} : S.cfg.artwork_filters?.[kind]) };
}

function pickerFilters(kind, row = S.modal?.row) {
  return { ...savedPickerFilters(kind), ...(row?.source === 'desktop' ? { static: true, animated: false } : {}) };
}

function collectSavedPickerFilters(kind, inputs) {
  inputs = [...inputs];
  const next = { ...(S.cfg.artwork_filters?.[kind] || {}) };
  for (const input of inputs) {
    if (input.disabled) continue;
    const field = input.dataset.filter;
    if (['styles', 'mimes', 'dimensions'].includes(field)) {
      next[field] = inputs.filter(node => node.dataset.filter === field && node.checked).map(node => node.value);
    } else next[field] = input.checked;
  }
  return next;
}

function artworkCacheKey(m) {
  return `${m.sgdbId}:${m.tab}:${JSON.stringify(pickerFilters(m.tab))}`;
}

function renderArtFilters() {
  const m = S.modal;
  if (!m) return;
  const kind = m.tab;
  $('#art-filters').hidden = kind === 'manage' || !S.cfg.api_key;
  $('#art-clear').hidden = m.row.source === 'desktop' || kind === 'manage';
  $('#art-clear').textContent = m.row.source === 'steam' || m.row.inSteam ? 'Restore default' : 'Clear selection';
  $('#art-file').hidden = kind === 'manage';
  $('#art-url').hidden = m.row.source === 'desktop' || kind === 'manage';
  if (kind === 'manage') return;
  const values = pickerFilters(kind);
  const styles = kind === 'logo' ? ['official', 'white', 'black', 'custom']
    : kind === 'icon' ? ['official', 'custom']
    : ['alternate', ...(kind === 'hero' ? [] : ['white_logo', 'no_logo']), 'blurred', 'material'];
  const dimensions = ART_DIMENSIONS[kind] || [];
  const formats = kind === 'icon' ? ['image/png', 'image/vnd.microsoft.icon']
    : kind === 'logo' ? ['image/png', 'image/webp'] : ['image/png', 'image/jpeg', 'image/webp'];
  const labels = { static: 'Static', animated: 'Animated', untagged: 'Untagged', nsfw: 'Adult Content',
    humor: 'Humor', epilepsy: 'Epilepsy', material: 'Minimal', white_logo: 'White Logo', no_logo: 'No Logo',
    'image/png': 'PNG', 'image/jpeg': 'JPEG', 'image/webp': 'WebP', 'image/vnd.microsoft.icon': 'ICO' };
  const groups = [['Motion', null, ['static', 'animated']], ['Content', null, ['untagged', 'nsfw', 'humor', 'epilepsy']],
    ['Style', 'styles', styles], ['Format', 'mimes', formats], ['Dimensions', 'dimensions', dimensions]];
  const host = $('#art-filter-fields');
  const dimensionsOpen = host.dataset.kind === kind && $('.filter-size-disclosure', host)?.open;
  host.dataset.kind = kind;
  host.innerHTML = groups.filter(([, , options]) => options.length).map(([title, field, options]) => {
    const choices = options.map(value => {
      const selected = field ? values[field]?.includes(value) ?? true : values[value];
      const label = field === 'dimensions' ? dimensionLabel(kind, value) : labels[value] || value.charAt(0).toUpperCase() + value.slice(1);
      return `<label class="check"><input type="checkbox" data-filter="${field || value}" value="${value}" ${selected ? 'checked' : ''}
        ${m.row.source === 'desktop' && ['static', 'animated'].includes(value) ? 'disabled' : ''}>${label}</label>`;
    }).join('');
    if (field === 'dimensions' && options.length > 12) {
      const count = options.filter(value => values.dimensions?.includes(value) ?? true).length;
      return `<fieldset class="filter-dimensions"><legend class="sr-only">${title}</legend>
        <details class="filter-size-disclosure" ${dimensionsOpen ? 'open' : ''}><summary>${title}<span data-size-count>${count} selected</span></summary>
        <div class="filter-options">${choices}</div></details></fieldset>`;
    }
    return `<fieldset ${title === 'Motion' && m.row.source === 'desktop' ? 'hidden' : ''}><legend class="sr-only">${title}</legend>
      <div class="filter-row"><span aria-hidden="true">${title}</span><div class="filter-options">${choices}</div></div></fieldset>`;
  }).join('');
  host.onchange = event => handleAction('Artwork filters', async () => {
    const inputs = [...event.target.closest('fieldset').querySelectorAll('input')];
    if (!inputs.some(input => input.checked) && ['static', 'animated'].includes(event.target.dataset.filter)) {
      inputs.find(input => input !== event.target).checked = true;
    }
    const next = collectSavedPickerFilters(kind, host.querySelectorAll('input'));
    const sizes = $('[data-size-count]', host);
    if (sizes) sizes.textContent = `${next.dimensions.length} selected`;
    await savePatch({ artwork_filters: { ...S.cfg.artwork_filters, [kind]: next } });
    if (S.modal !== m || m.tab !== kind) return;
    await loadArtTabs();
  })();
  $('#art-filter-reset').onclick = handleAction('Reset filters', async () => {
    const filters = { ...S.cfg.artwork_filters };
    delete filters[kind];
    await savePatch({ artwork_filters: filters });
    if (S.modal !== m || m.tab !== kind) return;
    renderArtFilters();
    await loadArtTabs();
  });
}

async function openArtModal(row, focusKind) {
  if (S.modal || S.applyingSteam || S.desktop.busy) return;
  S.artReturn = S.reviewReturn = null;
  S.modal = {
    row, tab: focusKind || 'grid',
    returnFocus: document.activeElement,
    sgdbId: row.sgdbId || null,
    steamId: row.source === 'steam' ? row.steamAppid : null,
    cache: {},           // `${sgdbId}:${kind}` -> items
    current: {},
    stock: {},
    sel: { ...(row.art || {}) },
    initialLogoPosition: row.logoPosition,
    games: [],
  };
  $('#art-filters').open = false;
  $('#art-title').textContent = row.display;
  $('.thumbScroll').scrollTop = 0;
  const desktop = row.source === 'desktop';
  $('#art-find-for-me').hidden = !S.cfg.api_key;
  $('#art-find-for-me').disabled = false;
  $('#art-find-for-me').textContent = desktop ? 'Find an icon for me' : 'Find artwork for me';
  $('#steam-game-settings').hidden = desktop;
  $('#desktop-game-settings').hidden = !desktop;
  $('#game-settings-title').textContent = row.source === 'steam' ? 'Game actions' : 'Shortcut settings';
  if (desktop) renderDesktopGameSettings(row);
  else {
    renderSteamGameSettings(row);
    $('#steam-game-settings .launcher-editor').open = true;
  }
  const keyless = !S.cfg.api_key;
  $('.art-id-advanced').hidden = keyless;
  $('#art-q').placeholder = keyless ? 'Search Steam' : 'Search SteamGridDB';
  $('#art-q').setAttribute('aria-label', keyless ? 'Search Steam' : 'Search SteamGridDB');
  $('#art-key-notice').hidden = !keyless;
  if (keyless) $('#art-key-notice-text').textContent = 'Search Steam for official artwork, or choose your own images.';
  $('#art-url').hidden = row.source === 'desktop';
  $('#art-clear').hidden = row.source === 'desktop';
  $('#art-q').value = row.query || row.display;
  $('#art-id').value = row.sgdbId || '';
  $('#art-matches').hidden = true;
  $('#art-games').innerHTML = '';
  for (const id of ['art-q', 'art-search', 'art-games', 'art-id']) $('#' + id).disabled = keyless && id === 'art-id';
  $('#art-url-entry').hidden = true;
  closeArtPreview();
  $('#art-grid').replaceChildren();
  renderArtTabs();
  renderArtFilters();
  animateArtModal(true);
  if (row.source !== 'desktop') {
    const m = S.modal;
    window.api.artLogoPosition(rowPayload(row)).then(position => {
      if (S.modal !== m || m.logoPosition !== undefined || row.logoPosition !== undefined) return;
      m.initialLogoPosition = position;
      renderLogoPosition();
    }).catch(e => log(`Logo position: ${e.message}`));
  }
  const focusTarget = S.modal.tab === 'manage' ? $('#game-settings-title') : $('#art-q');
  focusTarget.focus({ preventScroll: true });
  if (keyless || row.sgdbId) await loadArtTabs();
  else await Promise.all([loadArtTabs(), findInitialArtworkMatch(S.modal)]);
}

async function findInitialArtworkMatch(m) {
  const row = m.row;
  if (row.source === 'steam') {
    const search = m.search;
    artStatus('Matching Steam AppID…');
    const game = await window.api.sgdbBySteam(row.steamAppid).catch(() => null);
    if (S.modal !== m || m.search !== search) return;
    if (game) {
      m.sgdbId = game.id;
      m.games = [game];
      $('#art-id').value = game.id;
      await loadArtTabs();
    } else await artSearch();
  } else await artSearch();
}

function artworkSelectionChanged(modal) {
  return modal.sgdbId !== (modal.row.sgdbId || null)
    || JSON.stringify(modal.sel) !== JSON.stringify(modal.row.art || {});
}

async function closeArtModal(save, remind = false) {
  const m = S.modal;
  if (!m || m.applying) return;
  if (save && m.row.source !== 'desktop') {
    m.applying = true;
    $('#art-modal').inert = true;
    try {
      if (m.row.source !== 'steam' && steamLauncherChanged(m.row) && !await saveSteamLauncher()) return;
      await saveSteamDrafts([{ ...m.row, art: m.sel,
        logoPosition: m.logoPosition !== undefined ? m.logoPosition : m.row.logoPosition,
        pendingArt: m.row.pendingArt || m.logoPosition !== undefined || JSON.stringify(m.row.art || {}) !== JSON.stringify(m.sel || {}),
        sgdbId: m.sgdbId, sgdbName: m.games.find(game => game.id === m.sgdbId)?.name || m.row.sgdbName }]);
    } catch (error) {
      artStatus(`Choices could not be saved: ${error.message || error}`);
      return;
    } finally { m.applying = false; $('#art-modal').inert = false; }
  }
  if (save && m.row.source === 'desktop') {
    m.applying = true;
    $('#art-modal').inert = true;
    const match = m.games.find(game => game.id === m.sgdbId);
    const updated = { ...m.row, iconChoice: m.sel.icon || null, art: { ...m.sel }, sgdbId: m.sgdbId,
      ...(match && m.sgdbId !== m.row.sgdbId
        ? { display: m.renamedShortcut || m.keepName ? m.row.display : match.name, sgdbName: match.name } : {}) };
    try { await saveDesktopDraft(m.row, updated); Object.assign(m.row, Object.fromEntries([...desktopEditFields, 'art'].map(key => [key, updated[key]])));  }
    catch (error) { artStatus(`Choices could not be saved: ${error.message || error}`); return; }
    finally { m.applying = false; $('#art-modal').inert = false; }
  }
  m.moreObserver?.disconnect();
  if (m.preview) closeArtPreview();
  $('#art-url-entry').hidden = true;
  S.modal = null;
  $('#game-settings').hidden = true;
  animateArtModal(false);
  if (save) {
    if (m.row.source === 'desktop') {
      renderDesktop();
      if (remind && reviewCandidates('desktop').length) toast('Ready to review');
      restoreArtFocus(m);
      return;
    }
    if (m.sgdbId && m.sgdbId !== m.row.sgdbId) {
      m.row.sgdbId = m.sgdbId;
      m.row.sgdbName = m.games.find((game) => game.id === m.sgdbId)?.name || '(picked)';
      S.cfg.sgdb_map[folderKey(m.row.folder)] = m.sgdbId;
      savePatch({ sgdb_map: S.cfg.sgdb_map });
    }
    const artworkChanged = JSON.stringify(m.row.art || {}) !== JSON.stringify(m.sel || {});
    m.row.art = { ...m.sel };
    if (m.logoPosition !== undefined) { m.row.logoPosition = m.logoPosition; m.row.pendingArt = true; }
    if (artworkChanged) m.row.pendingArt = true;
    S.cardArtCache.delete(coverToken(m.row));
    renderRows();
    if (remind && reviewCandidates('library').length) toast('Ready to review');
    log(`'${m.row.display}': artwork selection updated.`);
  }
  restoreArtFocus(m);
}

function renderLogoPosition() {
  const m = S.modal;
  $('#art-logo-position').hidden = !m || m.row.source === 'desktop' || m.tab !== 'logo';
  const position = m?.logoPosition !== undefined ? m.logoPosition : m?.initialLogoPosition;
  $('#art-logo-anchor').value = position?.pinnedPosition || 'BottomLeft';
  $$('[data-logo-anchor]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.logoAnchor === $('#art-logo-anchor').value)));
}

function restoreArtFocus(m) {
  const target = m.returnFocus?.isConnected ? m.returnFocus
    : $$(m.row.source === 'desktop' ? '#desktop-games .game-card-row' : '#games .game-card-row')
      .find(card => card.dataset.key === (m.row.source === 'desktop' ? m.row.id : rowKey(m.row)))?.querySelector('.game-open');
  if (target?.isConnected) target.focus({ preventScroll: true });
}

function artStatus(t) { $('#art-status').textContent = t; }

function renderArtTabs() {
  const m = S.modal;
  const host = $('#art-tabs');
  renderLogoPosition();
  $('#game-settings').hidden = m.tab !== 'manage';
  host.innerHTML = '';
  for (const [kind, label] of modalTabs()) {
    const b = document.createElement('button');
    b.className = `tab${m.tab === kind ? ' on' : ''}`;
    b.textContent = label;
    const picked = m.sel[kind];
    if (picked) b.textContent += ' ★';
    b.addEventListener('click', () => {
      const restoreFocus = document.activeElement === b;
      $('#art-url-entry').hidden = true;
      m.tab = kind;
      renderArtTabs();
      if (restoreFocus) $('.tab.on', host)?.focus({ preventScroll: true });
      renderArtFilters();
      loadArtTabs();
    });
    host.appendChild(b);
  }
  $$('#art-grid .thumb').forEach((cell) => {
    const picked = isPicked(m.tab, cell._art);
    cell.classList.toggle('picked', picked);
    $('.thumb-select', cell)?.setAttribute('aria-pressed', String(picked));
  });
  const selected = m.sel[m.tab];
  $('#art-view-full').hidden = !(selected?.file || selected?.url);
}

function closeArtPreview(restoreFocus = false) {
  const preview = S.modal?.preview;
  if (preview?.loader) preview.loader.removeAttribute('src');
  if (S.modal) S.modal.preview = null;
  if (restoreFocus && preview) S.modal.previewReturn = preview;
  const wallpaperOptions = $('#wallpaper-options');
  if (wallpaperOptions?.open) wallpaperOptions.close();
  $('#art-preview').hidden = true;
  $('#art-grid').hidden = false;
  $('#game-settings').hidden = S.modal?.tab !== 'manage';
  const image = $('#art-preview-image');
  image.hidden = true;
  image.removeAttribute('src');
  if (preview) $('.thumbScroll').scrollTop = preview.galleryScroll;
  if (restoreFocus && preview?.trigger?.isConnected) preview.trigger.focus({ preventScroll: true });
}

async function openArtPreview(item, trigger = document.activeElement, kind = S.modal?.tab) {
  const m = S.modal;
  if (!m || !item) return;
  closeArtPreview();
  const preview = { item, kind, trigger, galleryScroll: $('.thumbScroll').scrollTop };
  m.previewReturn = null;
  m.preview = preview;
  const active = () => S.modal === m && m.preview === preview;
  const host = $('#art-preview');
  const image = $('#art-preview-image');
  const dimensions = $('#art-preview-size');
  const zoom = $('#art-preview-zoom');
  const wallpaper = $('#art-preview-wallpaper');
  $('#art-filters').open = false;
  $('#art-matches').hidden = true;
  host.hidden = false;
  zoom.disabled = wallpaper.disabled = true;
  zoom.textContent = 'Actual size';
  wallpaper.hidden = true;
  const canSet = ['grid', 'wide', 'hero'].includes(kind)
    ? window.api.artWallpaperAvailable?.().catch(() => false) : false;
  dimensions.textContent = 'Loading full image…';
  $('#art-grid').hidden = true;
  $('#game-settings').hidden = true;
  $('.thumbScroll').scrollTop = 0;
  $('#art-preview-back').focus({ preventScroll: true });
  const decode = async src => {
    if (!src) throw new Error('No image source.');
    const loader = preview.loader = new Image();
    loader.src = src;
    await loader.decode();
    return loader;
  };
  try {
    let full = true;
    let decoded;
    try {
      const src = item.url || (item.file ? await localArtPreview(item.file) : null);
      if (!active()) return;
      decoded = await decode(src);
    } catch {
      if (!active()) return;
      full = false;
      decoded = await decode(item.thumb && item.thumb !== item.url ? item.thumb : null);
    }
    if (!active()) return;
    image.src = decoded.src;
    image.hidden = false;
    dimensions.textContent = `${decoded.naturalWidth} × ${decoded.naturalHeight}${full ? '' : ' · preview only'}`;
    preview.image = decoded;
    setPreviewZoom(preview);
    const display = full ? await canSet : null;
    if (active() && display?.width > 0 && display.height > 0) {
      preview.display = display;
      wallpaper.hidden = wallpaper.disabled = false;
    }
  } catch {
    if (active()) dimensions.textContent = 'Could not load this image.';
  }
}

function setPreviewZoom(preview, requested, point) {
  if (!preview?.image) return;
  const box = $('.preview-image-wrap');
  const image = $('#art-preview-image');
  const width = preview.image.naturalWidth;
  const height = preview.image.naturalHeight;
  const fit = Math.min(1, box.offsetWidth / width, box.offsetHeight / height);
  if (!fit) return;
  const scale = Math.min(4, Math.max(fit, requested ?? fit));
  const bounds = box.getBoundingClientRect();
  const x = point?.clientX ?? bounds.left + box.clientWidth / 2;
  const y = point?.clientY ?? bounds.top + box.clientHeight / 2;
  const before = image.getBoundingClientRect();
  const u = before.width ? Math.min(1, Math.max(0, (x - before.left) / before.width)) : .5;
  const v = before.height ? Math.min(1, Math.max(0, (y - before.top) / before.height)) : .5;
  image.style.width = `${Math.max(1, Math.floor(width * scale))}px`;
  image.style.height = `${Math.max(1, Math.floor(height * scale))}px`;
  const zoomed = scale > fit;
  if (zoomed) {
    const after = image.getBoundingClientRect();
    box.scrollBy(after.left + after.width * u - x, after.top + after.height * v - y);
  } else box.scrollTo(0, 0);
  Object.assign(preview, { scale, zoomed });
  box.classList.toggle('pannable', box.scrollWidth > box.clientWidth || box.scrollHeight > box.clientHeight);
  const button = $('#art-preview-zoom');
  button.disabled = !zoomed && fit === 1;
  button.textContent = zoomed ? 'Fit to window' : 'Actual size';
}

function wirePreviewZoom() {
  const box = $('.preview-image-wrap');
  $('#art-preview-zoom').onclick = () => {
    const preview = S.modal?.preview;
    setPreviewZoom(preview, preview?.zoomed ? undefined : 1);
  };
  box.addEventListener('wheel', event => {
    const preview = S.modal?.preview;
    if (!preview?.image || !event.deltaY) return;
    event.preventDefault();
    const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 120 : 1);
    setPreviewZoom(preview, preview.scale * Math.exp(-Math.max(-240, Math.min(240, delta)) / 480), event);
  }, { passive: false });
  let drag;
  box.addEventListener('pointerdown', event => {
    if (!S.modal?.preview || !box.classList.contains('pannable') || event.button !== 0
      || event.target.id !== 'art-preview-image') return;
    drag = { id: event.pointerId, x: event.clientX, y: event.clientY, left: box.scrollLeft, top: box.scrollTop };
    box.setPointerCapture(event.pointerId);
    box.classList.add('dragging');
  });
  box.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) box.scrollTo(drag.left + drag.x - event.clientX, drag.top + drag.y - event.clientY);
  });
  box.addEventListener('lostpointercapture', () => { drag = null; box.classList.remove('dragging'); });
  new ResizeObserver(() => {
    const preview = S.modal?.preview;
    if (preview?.image) setPreviewZoom(preview, preview.zoomed ? preview.scale : undefined);
  }).observe(box);
}

function wallpaperImageSize(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const scale = Math.min(1, 8192 / Math.max(width, height), Math.sqrt(36_000_000 / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function encodeWallpaper(image) {
  const { width, height } = wallpaperImageSize(image);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', .94);
}

const wallpaperFitNotes = {
  fill: 'Fills the screen and crops the edges if needed.',
  fit: 'Shows the whole image, with space around it if needed.',
  stretch: 'Fills the screen and may distort the image.',
  center: 'Shows the image at its original size in the center.',
};

function updateWallpaperSample() {
  const { fit } = $('#wallpaper-form').elements;
  $('.wallpaper-sample').dataset.fit = fit.value;
  $('#wallpaper-fit-note').textContent = wallpaperFitNotes[fit.value];
}

function openWallpaperOptions() {
  const preview = S.modal?.preview;
  const dialog = $('#wallpaper-options');
  if (!preview?.display || dialog.open) return;
  const { width, height } = preview.display;
  const sample = $('.wallpaper-sample');
  const ratio = width / height;
  sample.style.aspectRatio = ratio;
  sample.style.width = `min(100%, ${Math.min(372, 210 * ratio)}px)`;
  sample.style.setProperty('--wallpaper-center-width', `${100 * wallpaperImageSize(preview.image).width / width}%`);
  $('img', sample).src = preview.image.src;
  $('#wallpaper-form').reset();
  $('#wallpaper-feedback').hidden = true;
  updateWallpaperSample();
  dialog.showModal();
}

async function setPreviewWallpaper(fit) {
  const preview = S.modal?.preview;
  const dialog = $('#wallpaper-options');
  const apply = $('#wallpaper-apply');
  const cancel = $('#wallpaper-cancel');
  const choices = $('.wallpaper-modes');
  const feedback = $('#wallpaper-feedback');
  if (!preview?.display || !dialog.open || apply.disabled || !Object.hasOwn(wallpaperFitNotes, fit)) return;
  apply.disabled = cancel.disabled = choices.disabled = true;
  const active = () => S.modal?.preview === preview;
  feedback.textContent = 'Setting desktop background…';
  feedback.hidden = false;
  try {
    let jpeg;
    try { jpeg = encodeWallpaper(preview.image); }
    catch (error) {
      if (error.name !== 'SecurityError') throw error;
      const bytes = await window.api.artWallpaperSource(preview.image.src);
      const bitmap = await createImageBitmap(new Blob([bytes]));
      try { jpeg = encodeWallpaper(bitmap); } finally { bitmap.close(); }
    }
    if (!active()) return;
    await window.api.artSetWallpaper(preview.kind, jpeg, fit);
    if (active()) {
      dialog.close();
      artStatus('Desktop background set.');
    }
  } catch (error) {
    if (active()) feedback.textContent = `Could not set desktop background: ${error.message || error}`;
  } finally { apply.disabled = cancel.disabled = choices.disabled = false; }
}

async function loadArtTabs(more = false) {
  const m = S.modal;
  if (!m) return;
  if (!more) {
    if (m.preview) closeArtPreview();
    m.previewReturn = null;
    $('.thumbScroll').scrollTop = 0;
  }
  if (m.tab === 'manage') { await renderArtManage(); return; }
  if (!S.cfg.api_key) {
    const kind = m.tab, appid = m.steamId;
    const image = appid ? await stockArtwork(m, kind) : null;
    if (S.modal !== m || m.tab !== kind || m.steamId !== appid) return;
    renderArtGrid();
    if (image && m.row.source === 'desktop') $('#art-grid').appendChild(artThumb(image, 'Steam artwork', { file: image.file }));
    artStatus(image ? 'Select an image.' : appid ? 'No Steam artwork found for this type.' : 'Search Steam to find a game.');
    return;
  }
  if (!m.sgdbId || !S.cfg.api_key) { renderArtGrid(); return; }
  const { sgdbId, tab: kind } = m;
  const key = artworkCacheKey(m);
  const page = m.cache[key] ||= { items: [], next: 0, more: true, pending: null };
  const start = more ? page.items.length : 0;
  if (!more && (!page.next || page.pending)) renderArtGrid(true);
  if (more && (!page.more || page.pending)) return;
  if (!page.next || more || page.pending) {
    artStatus(`Loading artwork for SGDB ${sgdbId}…`);
    if ($('#art-more')) $('#art-more').disabled = true;
  }
  try {
    if (!page.pending && (!page.next || more)) {
      page.pending = window.api.artList({ sgdbId, kind, page: page.next,
        filters: pickerFilters(kind) })
        .then(items => {
          const urls = new Set(page.items.map(item => item.url));
          page.items.push(...items.filter(item => !urls.has(item.url)));
          page.next++;
          page.more = items.length === 30;
        }).finally(() => { page.pending = null; });
    }
    await page.pending;
    if (S.modal !== m || artworkCacheKey(m) !== key) return;
    artStatus(`SGDB ${sgdbId}: ${page.items.length} images. Select an image.`);
    renderArtGrid(false, start);
  } catch (e) {
    if (S.modal !== m || artworkCacheKey(m) !== key) return;
    artStatus(`Load failed: ${e.message || e}`);
    if (start === 0 && !page.items.length) {
      const grid = $('#art-grid');
      grid.replaceChildren();
      const panel = document.createElement('div');
      panel.className = 'art-load-error';
      const message = document.createElement('div');
      message.className = 'muted';
      message.textContent = `Load failed: ${e.message || e}`;
      const retry = document.createElement('button');
      retry.className = 'btn sm';
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => loadArtTabs());
      panel.append(message, retry);
      grid.append(panel);
    }
    if ($('#art-more')) $('#art-more').disabled = false;
  }
}

function sameArtwork(a, b) {
  return !!(a && b && ((a.file && a.file === b.file) || (a.url && a.url === b.url)
    || (a.exeIcon && b.exeIcon) || (a.keepIcon && b.keepIcon)));
}

async function stockArtwork(m, kind) {
  const row = !S.cfg.api_key && m.steamId ? { source: 'steam', steamAppid: m.steamId } : rowPayload(m.row);
  m.stock[kind] ||= window.api.artCurrent({ row, kind, stock: true })
    .then(current => current || (row.source === 'steam' ? window.api.artOfficial({ row, kind }) : null))
    .catch(e => { log(`Stock artwork: ${e.message}`); return null; });
  return m.stock[kind];
}

async function suggestArtwork(row, art, sgdbId, sgdbName) {
  const desktop = row.source === 'desktop';
  const kinds = desktop ? ['icon'] : ART_TABS.map(([kind]) => kind);
  const missing = kinds.filter(kind => !art[kind] && !(desktop && row.iconChoice));
  if (!missing.length) return null;
  const payload = rowPayload(row);
  if (!sgdbId) {
    const { rows: [match] } = await window.api.matchAuto({ rows: [{ ...payload, query: row.query }], persist: false });
    if (!match?.sgdbId) return null;
    ({ sgdbId, sgdbName } = match);
  }
  const choices = await Promise.all(missing.map(async kind => {
    if (desktop) {
      const custom = desktopGameMembers(row).some(member => member.shortcut
        && member.icon && folderKey(member.icon) !== folderKey(member.exe));
      if (custom) return null;
    } else {
      const request = { row: payload, kind, existsOnly: true };
      const current = await window.api.artCurrent(request);
      if (current && (row.source !== 'steam'
        || current.file !== (await window.api.artCurrent({ ...request, stock: true }))?.file)) return null;
    }
    const images = await window.api.artList({ sgdbId, kind, page: 0, filters: pickerFilters(kind, row) });
    const image = images.find(item => item.url);
    return image ? [kind, image] : null;
  }));
  const found = Object.fromEntries(choices.filter(Boolean));
  return Object.keys(found).length ? { sgdbId, sgdbName, art: found } : null;
}

async function findArtworkForGame() {
  const m = S.modal;
  const button = $('#art-find-for-me');
  if (!m || button.disabled || !S.cfg.api_key) return;
  const id = m.sgdbId;
  const key = S.cfg.api_key;
  const search = m.search;
  button.disabled = true;
  artStatus('Finding artwork…');
  try {
    const result = await suggestArtwork(m.row, m.sel, id, m.row.sgdbName);
    if (S.modal !== m || S.cfg.api_key !== key || m.search !== search
      || (m.sgdbId !== id && result?.sgdbId !== m.sgdbId)) return;
    if (!result) { artStatus('No missing artwork found.'); return; }
    const additions = Object.keys(result.art).filter(kind => !m.sel[kind]);
    if (!additions.length) return;
    if (m.sgdbId !== result.sgdbId) m.search = (m.search || 0) + 1;
    m.sgdbId = result.sgdbId;
    m.keepName = true;
    if (!m.games.some(game => game.id === result.sgdbId) && result.sgdbName) {
      m.games.push({ id: result.sgdbId, name: result.sgdbName });
    }
    $('#art-id').value = result.sgdbId;
    for (const kind of additions) m.sel[kind] = result.art[kind];
    renderArtTabs();
    await loadArtTabs();
    if (S.modal === m) artStatus(`Found ${additions.length} artwork choice${additions.length === 1 ? '' : 's'}. Save to review.`);
  } catch (error) {
    if (S.modal === m) artStatus(`Artwork search failed: ${error.message || error}`);
  } finally { if (S.modal === m) button.disabled = false; }
}

async function renderArtManage() {
  const m = S.modal;
  m.moreObserver?.disconnect();
  closeArtPreview();
  const grid = $('#art-grid');
  grid.replaceChildren();
  grid.dataset.kind = 'manage';
  artStatus('');
  await Promise.all(modalTabs().filter(([kind]) => kind !== 'manage').map(async ([kind, label]) => {
    const cell = document.createElement('div');
    cell.className = 'manage-artwork';
    cell.innerHTML = `<strong>${label}</strong><div class="manage-preview"><button type="button" class="manage-preview-open" aria-label="View full ${esc(label.toLowerCase())} image" hidden><img alt=""></button></div><span class="muted small">Loading…</span>
      <div class="row"><button class="btn sm" data-manage="change">Change</button><button class="text-btn" data-manage="restore">${m.row.source === 'steam' || m.row.inSteam ? 'Restore default' : 'Clear selection'}</button></div>`;
    grid.appendChild(cell);
    $('[data-manage="change"]', cell).onclick = () => { m.tab = kind; renderArtTabs(); renderArtFilters(); loadArtTabs(); };
    $('[data-manage="restore"]', cell).hidden = m.row.source === 'desktop';
    $('[data-manage="restore"]', cell).onclick = () => {
      restoreArtKind(kind);
      $('span', cell).textContent = m.sel[kind]?.reset ? 'Default artwork will be restored.' : 'Selection cleared.';
      renderArtTabs();
    };
    const choice = m.sel[kind];
    const current = m.row.source === 'desktop' ? { url: choice?.file
      ? await localArtPreview(choice.file).catch(() => null)
      : choice?.thumb || choice?.url || await desktopIconPreview(m.row).catch(() => null) }
      : choice?.reset ? await stockArtwork(m, kind)
      : choice?.file || choice?.url ? choice : await window.api.artCurrent({ row: rowPayload(m.row), kind }).catch(() => null);
    if (S.modal !== m || m.tab !== 'manage' || !cell.isConnected) return;
    $('span', cell).textContent = choice?.reset ? 'Default artwork will be restored.'
      : choice && !choice.appliedFile ? 'Selected artwork' : current ? 'Current artwork' : 'No custom artwork';
    if (current) {
      const image = $('img', cell);
      const button = $('.manage-preview-open', cell);
      image.onload = () => { button.hidden = false; };
      image.onerror = () => { button.hidden = true; $('span', cell).textContent = 'Preview could not load.'; };
      button.onclick = () => openArtPreview(current.file || current.url ? current : { url: image.src }, button, kind);
      image.src = current.thumb || current.url || await localArtPreview(current.file).catch(() => null) || '';
    }
  }));
}

function isPicked(kind, item) {
  const choice = S.modal.sel[kind];
  return choice ? sameArtwork(choice, item) : !!item.current;
}

async function renderArtChoice() {
  const m = S.modal;
  const kind = m.tab;
  const current = await m.current[kind];
  const stock = await m.stock[kind];
  if (S.modal !== m || m.tab !== kind) return;
  const choice = m.row.art[kind];
  const applied = current && (!choice || choice.file === current.file || choice.appliedFile === current.file);
  const item = applied ? current : choice || current;
  const url = item?.url || (item?.file ? await window.api.artPreviewFile(item.file).catch((e) => {
    log(`Artwork preview failed for ${item.file}: ${e.message || e}`);
    return null;
  }) : null);
  if (S.modal !== m || m.tab !== kind || m.row.art[kind] !== choice) return;
  const slot = $('#art-choice');
  if (!slot) return;
  const stockSlot = $('#art-stock');
  stockSlot.hidden = !stock;
  stockSlot.replaceChildren(...(stock ? [artThumb(stock, 'Stock Steam artwork', { file: stock.file, current: !choice && sameArtwork(stock, current) })] : []));
  slot.hidden = !item || sameArtwork(stock, item);
  slot.replaceChildren(...(item && !sameArtwork(stock, item) ? [artThumb({ ...item, url }, applied ? 'Current artwork' : '',
    choice || { file: current.file, current: true })] : []));
  $$('#art-grid > .thumb').forEach((cell) => { cell.hidden = cell._broken || sameArtwork(choice, cell._art); });
}

function renderArtGrid(loading = false, start = 0) {
  if (!start) closeArtPreview();
  const m = S.modal;
  m?.moreObserver?.disconnect();
  const grid = $('#art-grid');
  if (!start) grid.innerHTML = '';
  else $('#art-more')?.remove();
  if (!m) return;
  const kind = m.tab;
  grid.dataset.kind = kind;
  for (const id of start ? [] : ['art-stock', 'art-choice']) {
    const slot = document.createElement('div');
    slot.id = id;
    slot.hidden = true;
    grid.appendChild(slot);
  }
  if (m.row.source === 'desktop') handleAction('Icon preview', renderDesktopIconChoices)();
  else {
    m.current[kind] ||= window.api.artCurrent({ row: rowPayload(m.row), kind }).catch(() => null);
    stockArtwork(m, kind);
    handleAction('Artwork preview', renderArtChoice)();
  }
  if (!S.cfg.api_key) return;
  if (loading || !m.sgdbId) {
    grid.insertAdjacentHTML('beforeend', `<div class="muted">${m.sgdbId ? 'Loading…' : 'Search or enter an SGDB game ID first.'}</div>`);
    return;
  }
  const page = m.cache[artworkCacheKey(m)];
  const items = page?.items || [];
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'art-load-error muted';
    empty.textContent = 'No SGDB images of this type.';
    const defaults = savedPickerFilters(kind, true);
    if (m.row.source === 'desktop') Object.assign(defaults, { static: true, animated: false });
    const changed = $$('#art-filter-fields input').some(input => {
      const value = defaults[input.dataset.filter];
      return input.checked !== (Array.isArray(value) ? value.includes(input.value) : value ?? true);
    });
    if (changed) {
      const reset = document.createElement('button');
      reset.className = 'btn sm';
      reset.textContent = 'Reset filters';
      reset.onclick = () => $('#art-filter-reset').click();
      empty.appendChild(reset);
    }
    grid.appendChild(empty);
    return;
  }
  for (const im of items.slice(start)) grid.appendChild(artThumb(im));
  if (page.more) {
    const button = document.createElement('button');
    button.id = 'art-more';
    button.className = 'btn';
    button.textContent = 'Load more';
    button.addEventListener('click', () => loadArtTabs(true));
    grid.appendChild(button);
    const sgdbId = m.sgdbId;
    m.moreObserver = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || !button.isConnected
        || S.modal !== m || m.tab !== kind || m.sgdbId !== sgdbId || button.disabled) return;
      m.moreObserver.disconnect();
      loadArtTabs(true);
    }, { root: grid.parentElement, rootMargin: '100px' });
    m.moreObserver.observe(button);
  }
}

function artThumb(im, label = '', selection = im) {
  const modal = S.modal;
  const kind = S.modal.tab;
  const cell = document.createElement('div');
  cell._art = selection;
  cell.className = `thumb${isPicked(kind, selection) ? ' picked' : ''}`;
  const selectionLabel = label || (im.id ? `${kind} image ${im.id} by ${im.author || 'unknown author'}` : `${kind} image ${baseName(im.file) || im.url || ''}`);
  cell.innerHTML = `<button class="thumb-select" type="button" aria-label="Select ${esc(selectionLabel)}" aria-pressed="${String(isPicked(kind, selection))}">
      <span class="thumb-image"><img loading="lazy" decoding="async" width="${Number(im.width) || 600}" height="${Number(im.height) || 900}" src="${esc(im.thumb || im.url)}" alt=""></span>
      ${label ? `<span class="meta">${esc(label)}</span>` : ''}</button>`;
  $('.thumb-select', cell).addEventListener('click', () => pickArt(kind, selection));
  const image = $('img', cell);
  image.addEventListener('error', () => {
    log(`Artwork image failed to load: ${im.file || (image.src.startsWith('data:') ? 'local image data' : image.src)}`,
      modal.row.source === 'desktop' ? 'desktop' : 'library');
    if (im.url && image.getAttribute('src') !== im.url) { image.src = im.url; return; }
    cell._broken = true;
    cell.hidden = true;
    if (['art-choice', 'art-stock'].includes(cell.parentElement?.id)) cell.parentElement.hidden = true;
    if (S.modal === modal && modal.tab === kind) artStatus('An image could not load and was hidden. Details are in the log.');
  });
  $('.thumb-select', cell).addEventListener('dblclick', e => openArtPreview(im, e.currentTarget, kind));
  return cell;
}

function pickArt(kind, item) {
  S.modal.sel[kind] = item.file ? { file: item.file, appliedFile: item.appliedFile } : item;
  artStatus(item.id ? `${kind}: selected #${item.id} by ${item.author}.`
    : `${kind}: ${item.file ? 'local file' : 'custom URL'} set.`);
  renderArtTabs();
}

function restoreArtKind(kind) {
  const m = S.modal;
  if (m.row.source === 'steam' || m.row.inSteam) m.sel[kind] = { reset: true };
  else delete m.sel[kind];
  artStatus(m.sel[kind]?.reset ? `${kind}: default artwork will be restored when you apply.` : `${kind}: selection cleared.`);
  renderArtTabs();
}

async function artSearch(showMatches = false) {
  const m = S.modal;
  const q = $('#art-q').value.trim();
  if (!q) return;
  const search = m.search = (m.search || 0) + 1;
  artStatus(`Searching ${S.cfg.api_key ? 'SGDB' : 'Steam'} for '${q}'...`);
  try {
    const games = await (S.cfg.api_key ? window.api.sgdbSearch(q) : window.api.steamArtworkSearch(q));
    if (S.modal !== m || m.search !== search) return;
    m.games = games;
    const sel = $('#art-games');
    const matches = $('#art-matches');
    matches.hidden = !showMatches || games.length < 2;
    sel.innerHTML = '';
    if (!games.length) { artStatus(S.cfg.api_key ? 'No SGDB matches. Try another query or paste an ID.' : 'No Steam matches. Try another search.'); return; }
    for (const g of games) {
      const o = document.createElement('option');
      o.value = String(g.id);
      o.textContent = `${g.name}  [${g.id}]`;
      o.title = o.textContent;
      sel.appendChild(o);
    }
    const g = games.find((game) => game.id === (S.cfg.api_key ? m.sgdbId : m.steamId)) || games[0];
    sel.value = String(g.id);
    renderChoiceList(sel);
    if (!S.cfg.api_key) { m.stock = {}; m.steamId = g.id; await loadArtTabs(); return; }
    m.sgdbId = g.id;
    $('#art-id').value = String(g.id);
    artStatus(`Matched '${g.name}' (${g.id}). Loading artwork…`);
    await loadArtTabs();
  } catch (e) {
    if (S.modal === m && m.search === search) artStatus(`Search failed: ${e.message || e}`);
  }
}

async function artLoadId() {
  const m = S.modal;
  const value = $('#art-id').value.trim();
  if (!m || !value) return;
  const gid = Number(value);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(gid) || gid <= 0) {
    artStatus('Enter a valid SGDB game ID.');
    return;
  }
  if (gid === m.sgdbId) return;
  $('#art-matches').hidden = true;
  m.search = (m.search || 0) + 1;
  m.sgdbId = gid;
  await loadArtTabs();
}

// ------------------------------------------------------------------ boot
function wireToolbar() {
  renderSettingsCards();
  $('#art-find-for-me').onclick = findArtworkForGame;
  document.addEventListener('click', event => {
    for (const menu of $$('#preferences[open], #art-filters[open]')) {
      if (!menu.contains(event.target) && !(menu.id === 'preferences' && event.target.closest('[data-setup=key], #art-key-settings'))) menu.open = false;
    }
    if (!$('#art-matches').contains(event.target)) $('#art-matches').hidden = true;
  });
  wireWorkspace();
  wireDesktop();
  $('#theme-cycle').onclick = handleAction('Theme change', async () => {
    await savePatch({ theme: document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' });
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
  const dock = $('#bottomdock');
  const dockToggle = $('#dock-toggle');
  dockToggle.addEventListener('click', () => {
    const collapsed = dock.classList.toggle('collapsed');
    dockToggle.setAttribute('aria-expanded', String(!collapsed));
    dockToggle.textContent = collapsed ? 'Show log' : 'Hide log';
  });
  $('#btn-refresh').addEventListener('click', handleAction('Refresh', doRefresh));
  $('#btn-add').addEventListener('click', () => openReview('library'));
  $('#btn-remove').addEventListener('click', handleAction('Shortcut removal', doRemoveFromSteam));
  $('#btn-prune').addEventListener('click', handleAction('Prune', doPruneMissing));
  $('#btn-clear').addEventListener('click', handleAction('Clear', doClear));
  $('#hide-owned').addEventListener('change', (e) => {
    S.hideOwned = e.target.checked;
    renderRows();
  });
  $('#filter').addEventListener('input', (e) => { S.filter = e.target.value; renderRows(); });
  $('#source-filter').addEventListener('change', (e) => { S.nonSteamOnly = e.target.checked; renderRows(); });
  $('#games-body').addEventListener('click', (e) => {
    const tr = e.target.closest('tr');
    if (!tr?.dataset.key) return;

    const row = rowByKey(tr.dataset.key);
    if (row) openArtModal(row, e.target.closest('.game-open') ? 'grid' : 'manage');
    else selectRow(tr.dataset.key);
  });
  $('#d-exe-pick').addEventListener('change', e => updateLauncherChoice(e.target));
  $('#d-browse').addEventListener('click', async () => {
    const r = steamEditorRow();
    const p = await window.api.filesPickExe(r ? (r.fromExecutableSearch ? r.startDir : r.folder) : null);
    if (p) {
      const pick = $('#d-exe-pick');
      if (![...pick.options].some((o) => o.value === p)) {
        const o = document.createElement('option');
        o.value = p;
        o.textContent = baseName(p);
        pick.appendChild(o);
      }
      pick.value = p;
      updateLauncherChoice(pick);
    }
  });
  $('#d-open').addEventListener('click', () => {
    const r = steamEditorRow();
    if (!r) return;
    const folder = r.source === 'steam' ? r.startDir
      : r.source === 'shortcut' || r.fromExecutableSearch ? (r.startDir || parentDir(r.exe)) : r.folder;
    if (folder) window.api.shellOpen(folder);
  });
  // modal
  $('#art-search').addEventListener('click', () => artSearch(true));
  $('#art-q').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.repeat) return;
    e.preventDefault();
    $('#art-search').click();
  });
  const artId = $('#art-id');
  let artIdTimer;
  artId.addEventListener('input', () => {
    clearTimeout(artIdTimer);
    const modal = S.modal;
    if (!modal) return;
    const search = modal.search = (modal.search || 0) + 1;
    artIdTimer = setTimeout(() => {
      if (S.modal === modal && modal.search === search) artLoadId();
    }, 450);
  });
  artId.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.isComposing) return;
    event.preventDefault();
    clearTimeout(artIdTimer);
    artLoadId();
  });
  $('#art-view-full').addEventListener('click', e => openArtPreview(S.modal?.sel[S.modal.tab], e.currentTarget));
  $('#art-preview-back').addEventListener('click', () => closeArtPreview(true));
  wirePreviewZoom();
  $('#art-preview-wallpaper').addEventListener('click', openWallpaperOptions);
  const wallpaperForm = $('#wallpaper-form');
  wallpaperForm.addEventListener('change', updateWallpaperSample);
  wallpaperForm.addEventListener('submit', event => {
    event.preventDefault();
    setPreviewWallpaper(wallpaperForm.elements.fit.value);
  });
  const wallpaperOptions = $('#wallpaper-options');
  $('#wallpaper-cancel').onclick = () => wallpaperOptions.close();
  wallpaperOptions.addEventListener('cancel', event => {
    if ($('#wallpaper-apply').disabled) event.preventDefault();
  });
  wallpaperOptions.addEventListener('close', () => {
    if (!wallpaperOptions.open) $('.wallpaper-sample img').removeAttribute('src');
  });
  const artGames = $('#art-games');
  artGames.addEventListener('change', async (e) => {
    const m = S.modal;
    const g = (m.games || []).find((x) => String(x.id) === e.target.value);
    if (g) {
      m.search = (m.search || 0) + 1;
      if (!S.cfg.api_key) { m.stock = {}; m.steamId = g.id; await loadArtTabs(); return; }
      m.sgdbId = g.id;
      $('#art-id').value = String(g.id);
      await loadArtTabs();
    }
  });
  const dismissMatches = () => {
    $('#art-matches').hidden = true;
    $('#art-search').focus();
  };
  artGames.nextElementSibling.addEventListener('click', event => {
    if (event.target.closest('button[data-index]')) dismissMatches();
  });
  $('#art-url').addEventListener('click', () => {
    $('#art-url-input').value = S.modal.sel[S.modal.tab]?.custom ? S.modal.sel[S.modal.tab].url || '' : '';
    $('#art-url-entry').hidden = false;
    $('#art-url-input').focus();
  });
  $('#art-url-cancel').addEventListener('click', () => { $('#art-url-entry').hidden = true; });
  $('#art-url-entry').addEventListener('submit', (e) => {
    e.preventDefault();
    const m = S.modal;
    const url = $('#art-url-input').value.trim();
    if (url) {
      closeArtPreview();
      m.sel[m.tab] = { url, custom: true };
      renderArtTabs();
      artStatus(`${m.tab}: custom URL set.`);
    }
    $('#art-url-entry').hidden = true;
  });
  $('#art-file').addEventListener('click', handleAction('Artwork preview', async () => {
    const m = S.modal;
    const p = await (m.tab === 'icon' ? window.api.desktopPickIcon() : window.api.filesPickImage());
    if (p) {
      if (S.modal !== m) return;
      closeArtPreview();
      m.sel[m.tab] = { file: p, custom: true };
      renderArtTabs();
      artStatus(`${m.tab}: local file set.`);
      await openArtPreview(m.sel[m.tab]);
    }
  }));
  $('#art-clear').addEventListener('click', () => {
    restoreArtKind(S.modal.tab);
    closeArtPreview();
  });
  $('#art-cancel').addEventListener('click', () => closeArtModal(false));
  $('#art-save').addEventListener('click', () => closeArtModal(true, true));
  $('#art-key-settings').addEventListener('click', () => {
    closeArtModal(false);
    $('#preferences').open = true;
    $('[data-r="key"]')?.focus();
  });
  $$('[data-logo-anchor]').forEach(button => {
    button.onclick = () => {
      const input = $('#art-logo-anchor');
      input.value = button.dataset.logoAnchor;
      input.dispatchEvent(new Event('change'));
      renderLogoPosition();
    };
  });
  $('#art-logo-anchor').addEventListener('change', () => {
    S.modal.logoPosition = { pinnedPosition: $('#art-logo-anchor').value };
  });
  $('#art-logo-reset').addEventListener('click', () => { S.modal.logoPosition = null; renderLogoPosition(); });
  let artOverlayPressed = false;
  $('#art-overlay').addEventListener('mousedown', e => { artOverlayPressed = e.target.id === 'art-overlay'; });
  $('#art-overlay').addEventListener('click', e => {
    if (artOverlayPressed && e.target.id === 'art-overlay') closeArtModal(false);
    artOverlayPressed = false;
  });
  document.addEventListener('keydown', (e) => {
    if (e.defaultPrevented) return;
    if (S.exePicker) return;
    if ($('#wallpaper-options').open) return;
    if (e.key === 'Escape' && dismissTopPopup()) { e.preventDefault(); return; }
    if (S.modal && e.key === 'Tab') {
      const focusable = $$('#art-modal button:not(:disabled), #art-modal input:not(:disabled), #art-modal select:not(:disabled), #art-modal summary, #art-modal .preview-image-wrap')
        .filter((element) => element.tabIndex >= 0 && !element.closest('[hidden]') && element.getClientRects().length);
      const at = focusable.indexOf(document.activeElement);
      if (e.shiftKey && at <= 0) { e.preventDefault(); focusable.at(-1)?.focus(); }
      else if (!e.shiftKey && at === focusable.length - 1) { e.preventDefault(); focusable[0]?.focus(); }
    }
    if (e.key === 'Escape' && S.modal) {
      if (!$('#art-url-entry').hidden) $('#art-url-entry').hidden = true;
      else if (S.modal.preview) closeArtPreview(true);
      else closeArtModal(false);
    }
    if (e.altKey && ['ArrowLeft', 'ArrowRight'].includes(e.key)) {
      e.preventDefault();
      moveNavigation(e.key === 'ArrowLeft' ? 'back' : 'fwd', 'key');
    }
  });
  document.addEventListener('mouseup', event => {
    if (event.button === 3 || event.button === 4) moveNavigation(event.button === 3 ? 'back' : 'fwd', 'mouse');
  });
}

function steamLauncherChanged(row) {
  return $('#d-name').value.trim() !== row.display || $('#d-exe-pick').value.trim() !== (row.exe || '')
    || $('#d-startdir').value.trim() !== (S.cfg.steam_launch?.[folderKey(row.folder)]?.startDir ?? String(row.startDir || '').replace(/^"|"$/g, ''))
    || $('#d-args').value !== (S.cfg.steam_launch?.[folderKey(row.folder)]?.launchOptions ?? row.launchOptions ?? '');
}

async function saveSteamLauncher() {
  const r = steamEditorRow();
  if (!r) return false;
  if (r.source === 'steam') { toast('Steam store games cannot be edited here - Steam manages them.'); return false; }
  const oldLaunch = S.cfg.steam_launch?.[folderKey(r.folder)];
  const oldStartDir = oldLaunch?.startDir ?? String(r.startDir || '').replace(/^"|"$/g, '');
  const oldArgs = oldLaunch?.launchOptions ?? r.launchOptions ?? '';
  const name = $('#d-name').value.trim();
  const exe = $('#d-exe-pick').value.trim();
  let startDir = $('#d-startdir').value.trim();
  if (exe !== r.exe && folderKey(startDir) === folderKey(parentDir(r.exe || ''))) startDir = parentDir(exe);
  const fieldsChanged = (!!name && name !== r.display) || (!!exe && exe !== r.exe)
    || startDir !== oldStartDir || $('#d-args').value !== oldArgs;
  if (r.fromExecutableSearch && exe && folderKey(exe) !== folderKey(r.folder)) {
    if (S.rows.some((other) => other !== r && other.exe && folderKey(other.exe) === folderKey(exe))) {
      toast('That executable is already listed.');
      return false;
    }
    const oldKey = folderKey(r.folder);
    const newKey = folderKey(exe);
    for (const map of [S.cfg.title_map, S.cfg.sgdb_map, S.cfg.sgdb_cache, S.cfg.steam_launch ||= {}]) {
      if (Object.hasOwn(map, oldKey)) map[newKey] = map[oldKey];
      else delete map[newKey];
      delete map[oldKey];
    }
    delete S.cfg.exe_map[oldKey];
    r.folder = exe;
    r.folderName = baseName(parentDir(exe));
  }
  if (name) {
    r.display = name;
    r.query = name;
    S.cfg.title_map[folderKey(r.folder)] = name;
  }
  if (exe) {
    const launcherChanged = exe !== r.exe;
    r.exe = exe;
    if (launcherChanged) r.startDir = parentDir(exe);
    if (!r.fromExecutableSearch) {
      S.cfg.exe_map[folderKey(r.folder)] = exe.startsWith(r.folder)
        ? exe.slice(r.folder.length).replace(/^[\\/]/, '') : baseName(exe);
    }
  }
  r.reason = 'manual';
  S.cfg.steam_launch ||= {};
  S.cfg.steam_launch[folderKey(r.folder)] = { startDir: startDir || parentDir(r.exe), launchOptions: $('#d-args').value };
  if (fieldsChanged) r.pendingDetails = true;
  await savePatch({ title_map: S.cfg.title_map, exe_map: S.cfg.exe_map,
    sgdb_map: S.cfg.sgdb_map, sgdb_cache: S.cfg.sgdb_cache, steam_launch: S.cfg.steam_launch });
  await refreshSteamState();
  log(`Updated '${r.display}'.`);
  return true;
}

async function boot() {
  window.api.checkUpdate?.().then(version => {
    if (!version) return;
    const button = $('#update-available');
    button.textContent = `${version} available`;
    button.hidden = false;
    button.onclick = () => window.api.openUrl('https://github.com/Kirkland-Pickles/lib-shammes/releases/latest');
  }).catch(() => {});
  S.cfg = await window.api.cfgGet();
  const showIntro = !S.cfg.library_intro_seen && !S.cfg.steam_path && !S.cfg.api_key
    && !S.cfg.games_roots?.length && libraryView() === 'library';
  applyTheme();
  try { await detectSteam(); }
  catch (error) { log(`Steam detection failed: ${error.message}`); }
  wireToolbar();
  window.api.onNav(direction => moveNavigation(direction, 'app-command'));
  window.api.onProgress((p) => {
    setBar(p.current || 0, p.total || 0);
    if (p.label) status(p.label);
  });
  await showLibrary();
  if (showIntro) {
    $('#intro-key').append(keyCard());
    $('#library-intro').showModal();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  boot().catch((e) => {
    document.body.innerHTML = `<pre style="padding:20px">Failed to start: ${esc(e.message || e)}</pre>`;
  });
});

function wireWorkspace() {
  wireReview();
  const intro = $('#library-intro');
  intro.addEventListener('close', handleAction('Save setup preference', async () => {
    renderSettingsCards($('#intro-key').firstElementChild);
    await savePatch({ library_intro_seen: true });
  }));
  $('#intro-continue').onclick = () => intro.close();
  $('#intro-add-folders').onclick = () => { intro.close(); openFolders(); };
  $('#add-folders').onclick = openFolders;
  $('#close-add').onclick = () => $('#page-add').close();
  $('#close-steam-setup').onclick = () => { $('#steam-setup').close(); handleAction('Refresh Steam', doRefresh)(); };
  $('#steam-setup').addEventListener('cancel', () => handleAction('Refresh Steam', doRefresh)());
  const picker = $('#desktop-destination');
  picker.onclick = event => {
    const button = event.target.closest('[data-destination]');
    if (!button || button.getAttribute('aria-pressed') === 'true' || picker.inert) return;
    return handleAction('Change destination', async () => {
      picker.inert = $('#center').inert = true;
      S.artReturn = S.reviewReturn = null;
      try {
        await savePatch({ startup_library: button.dataset.destination });
        await showLibrary(true);
      } finally { picker.inert = $('#center').inert = false; button.focus({ preventScroll: true }); }
    })();
  };
  const location = $('#shortcut-location');
  location.onchange = handleAction('Change shortcut location', async () => {
    const destination = location.value;
    location.disabled = true;
    try {
      await savePatch({ desktop_destination: destination });
      S.artReturn = S.reviewReturn = null;
    } finally {
      location.value = S.cfg.desktop_destination || 'desktop';
      renderDesktop();
    }
  });
  for (const [id, depth] of [['add-single', 0], ['add-collection', 1]]) {
    $('#' + id).onclick = handleAction('Add games', async () => {
      const folder = await window.api.foldersBrowse();
      if (!folder) return;
      await savePatch({ games_roots: [...new Set([...(S.cfg.games_roots || []), folder])],
        folder_depths: { ...S.cfg.folder_depths, [folderKey(folder)]: depth } });
      renderSources();
      await showLibrary();
    });
  }
  $('#find-overlooked').onclick = handleAction('Find missing games', async () => {
    if (!S.cfg.games_roots?.some(Boolean)) {
      toast('Add a game folder before searching for launchers.');
      return;
    }
    const desktop = libraryView() === 'desktop';
    $('#page-add').close();
    if (desktop) await refreshDesktop(false); else await loadLibrary();
    doFindExecutables();
  });
}

// A batch is explicit. An empty selection never means every game.
function reviewCandidates(destination) {
  if (destination === 'desktop') {
    const rows = desktopCards().filter(row => desktopMembers(row).some(member => member.draft));
    return rows.filter(row => row.exe);
  }
  const rows = S.rows.filter(row => row.pendingArt || row.pendingDetails);
  return rows.filter(row => canWriteShortcut(row) || row.source === 'steam' && row.pendingArt);
}
function missingShortcuts(destination) {
  if (destination !== 'desktop') return S.rows.filter(row => canWriteShortcut(row)
    && !row.inSteam && !row.pendingArt && !row.pendingDetails);
  return desktopCards().filter(row => row.exe && !desktopMembers(row).some(member => member.draft)
    && desktopMembers(row).some(member => !member.shortcut));
}
function reviewScope(destination) {
  return destination === 'desktop' ? String(S.cfg.desktop_destination || 'desktop') : steamDraftScope();
}
function openReview(destination) {
  if (S.applyingSteam || S.loadingLibrary || S.desktop.busy) return;
  const rows = reviewCandidates(destination);
  const optional = missingShortcuts(destination);
  if (!rows.length && !optional.length) { toast('Save artwork or shortcut changes first.'); return; }
  S.review = { destination, scope: reviewScope(destination), rows: [...rows, ...optional],
    savedCount: rows.length, included: new Set(rows) };
  const panel = $('#page-review');
  panel.showModal();
  renderReview();
}
function renderReview() {
  const review = S.review;
  if (!review) return;
  const desktop = review.destination === 'desktop';
  const destination = desktop ? ({ desktop: 'Desktop', 'start-menu': 'Start menu', both: 'Desktop and Start menu' }[S.cfg.desktop_destination || 'desktop']) : 'Steam';
  $('#review-title').textContent = !review.savedCount
    ? desktop ? 'Create shortcuts' : 'Add to Steam' : 'Review changes';
  const rowChecks = new Map();
  const groupChecks = new Map();
  const updateSelection = () => {
    const total = review.rows.length;
    $('#review-summary').textContent = `${review.included.size} of ${total} selected for ${destination}`;
    $('#review-apply').disabled = !review.included.size;
    for (const [check, rows] of groupChecks) {
      const selected = rows.filter(row => review.included.has(row)).length;
      check.checked = selected === rows.length;
      check.indeterminate = selected > 0 && !check.checked;
    }
  };
  $('#review-note')?.remove();
  if (desktop) $('#page-review .library-head').insertAdjacentHTML('afterend', '<p id="review-note" class="note">Choose which shortcuts to create or update. Your game files are not changed.</p>');
  $('#review-apply').textContent = `Apply to ${destination}`;
  $('#review-status').textContent = '';
  const host = $('#review-list');
  host.replaceChildren();
  for (const [index, row] of review.rows.entries()) {
    if (index === 0 || index === review.savedCount) {
      const heading = document.createElement('h2');
      heading.className = 'review-section-title';
      heading.textContent = index < review.savedCount ? 'Saved changes'
        : desktop ? 'Create missing shortcuts' : 'Add missing shortcuts';
      const rows = index < review.savedCount ? review.rows.slice(0, review.savedCount) : review.rows.slice(index);
      const sectionHead = document.createElement('div');
      sectionHead.className = 'review-section-head';
      sectionHead.append(heading);
      if (rows.length > 1) {
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.setAttribute('aria-label', `Select all for ${heading.textContent.toLowerCase()}`);
        check.onchange = () => {
          for (const member of rows) {
            if (check.checked) review.included.add(member); else review.included.delete(member);
            rowChecks.get(member).checked = check.checked;
          }
          updateSelection();
        };
        label.append(check, 'Select all');
        sectionHead.append(label);
        groupChecks.set(check, rows);
      }
      host.append(sectionHead);
    }
    const label = document.createElement('label');
    label.className = 'review-row';
    const action = desktop ? (desktopMembers(row).every(member => member.shortcut) ? 'Update shortcut' : 'Create missing shortcuts')
      : row.source === 'steam' ? 'Update artwork' : row.inSteam ? 'Update Steam shortcut' : 'Add to Steam';
    const art = Object.keys(row.art || {}).filter(kind => !row.art[kind].current);
    if (row.logoPosition !== undefined) art.push('logo position');
    const artwork = art.map(kind => ({ grid: 'cover', wide: 'wide cover', hero: 'background' }[kind] || kind)).join(', ');
    label.innerHTML = `<input type="checkbox" ${review.included.has(row) ? 'checked' : ''}><img class="review-cover" alt="" hidden><strong>${esc(row.display)}</strong><span>${action}${artwork ? `<small>${esc(artwork)}</small>` : ''}</span>`;
    const check = label.querySelector('input');
    rowChecks.set(row, check);
    check.onchange = event => {
      if (event.target.checked) review.included.add(row); else review.included.delete(row);
      updateSelection();
    };
    host.appendChild(label);
    const image = label.querySelector('img');
    (desktop ? desktopCardCoverSource(row) : cardCoverSource(row)).then(src => {
      if (!src || !image.isConnected) return;
      image.onerror = () => { image.hidden = true; };
      image.src = src; image.hidden = false;
    }).catch(() => {});
  }
  updateSelection();
}
function closeReview(remember = true) {
  if (!S.review) return;
  S.reviewReturn = remember ? S.review.destination : null;
  S.review = null;
  $('#page-review').close();
}
function dismissTopPopup() {
  if (S.modal && !$('#art-matches').hidden) {
    $('#art-matches').hidden = true;
    $('#art-search').focus({ preventScroll: true });
    return true;
  }
  const popup = $(S.modal ? '#art-filters[open]' : '#preferences[open]');
  if (!popup) return false;
  popup.open = false;
  $('summary', popup).focus({ preventScroll: true });
  return true;
}

let lastNavigation;
function moveNavigation(direction, source) {
  const time = performance.now();
  if (lastNavigation?.direction === direction && lastNavigation.source !== source && time - lastNavigation.time < 100) return;
  lastNavigation = { direction, source, time };
  if ($('#wallpaper-options').open) {
    if (direction === 'back' && !$('#wallpaper-apply').disabled) $('#wallpaper-options').close();
    return;
  }
  if ($('#confirm-overlay') || $('#page-review').inert || $('#library-intro').open) return;
  if (direction === 'back' && dismissTopPopup()) return;
  const dialog = $('#exe-picker[open], #page-add[open], #steam-setup[open]');
  if (dialog) {
    if (direction === 'back') {
      if (dialog.id === 'steam-setup') $('#close-steam-setup').click();
      else dialog.close();
    }
    return;
  }
  const modal = S.modal;
  if (modal) {
    if (modal.applying) return;
    if (direction === 'back') {
      if (!$('#art-url-entry').hidden) $('#art-url-entry').hidden = true;
      else if (modal.preview) closeArtPreview(true);
      else {
        S.artReturn = { row: modal.row, tab: modal.tab, preview: modal.previewReturn, scope: reviewScope(libraryView()) };
        closeArtModal(false);
      }
    } else if (!modal.preview && modal.previewReturn) {
      const { item, kind, trigger } = modal.previewReturn;
      openArtPreview(item, trigger, kind);
    }
    return;
  }
  if (direction === 'back') {
    if (S.review) closeReview();
    return;
  }
  if (S.review) return;
  const destination = libraryView();
  const saved = S.artReturn;
  if (saved?.scope === reviewScope(destination)
    && (destination === 'desktop' ? desktopCards() : S.rows).includes(saved.row)) {
    handleAction('Reopen artwork picker', async () => {
      await openArtModal(saved.row, saved.tab);
      if (S.modal?.row === saved.row) S.modal.previewReturn = saved.preview;
    })();
  } else if (S.reviewReturn === destination) openReview(destination);
}
function wireReview() {
  $('#review-back').onclick = () => closeReview();
  $('#page-review').addEventListener('cancel', event => {
    event.preventDefault();
    if (!$('#page-review').inert) closeReview();
  });
  $('#review-apply').onclick = handleAction('Apply reviewed changes', async () => {
    const review = S.review;
    if (!review || !review.included.size || S.applyingSteam || S.desktop.busy) return;
    const live = review.destination === 'desktop' ? desktopCards() : S.rows;
    if (review.scope !== reviewScope(review.destination) || [...review.included].some(row => !live.includes(row))) {
      $('#review-status').textContent = 'The library or destination changed. Go back and review the current games before applying.';
      $('#review-apply').disabled = true;
      return;
    }
    $('#page-review').inert = $('#page-nav').inert = true;
    try {
      if (review.destination === 'desktop') await applyDesktopShortcuts([...review.included], { reviewed: true });
      else await doAddToSteam([...review.included]);
      closeReview(false);
    } finally { $('#page-review').inert = $('#page-nav').inert = false; }
  });
}
