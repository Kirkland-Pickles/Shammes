'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULTS = {
  theme: 'system',
  games_root: '',
  games_roots: [],
  folder_depths: {},
  steam_path: '',
  steam_user_id: '',
  api_key: '',
  api_key_check: null,
  scan_depth: 1,
  include_animated: false,
  include_nsfw: false,
  include_humor: false,
  artwork_filters: {},
  sgdb_map: {},
  sgdb_cache: {},
  exe_map: {},
  title_map: {},
  steam_launch: {},
  steam_art_drafts: {},
  desktop_overrides: {},
  desktop_choices: {},
  desktop_executables: [],
  desktop_destination: 'desktop',
  steam_executables: [],
  startup_library: 'steam',
  library_intro_seen: false,
};

function dataDir(name, fallback) {
  if (process.env.APPDATA) return path.join(process.env.APPDATA, name);
  return path.join(os.homedir(), fallback);
}

function configDir() {
  const previous = previousConfigDir();
  // Undo records and wallpapers can reference files in this directory.
  return fs.existsSync(previous) ? previous : dataDir('Shammes', '.shammes');
}

function previousConfigDir() {
  return dataDir('Lib Shammes', '.lib-shammes');
}

function legacyConfigDir() {
  return dataDir('ShammesForge', '.shammesforge');
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function dedupe(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter(item => typeof item === 'string' && item.trim()))];
}

// Crash-safe write: temp file + rename, so a mid-write crash never leaves a
// half-written config or journal behind.
function writeFileAtomic(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, filePath);
}

function load() {
  const cfg = structuredClone(DEFAULTS);
  // load AppData first, then check for an old portable config
  for (const p of [configPath(), path.join(legacyConfigDir(), 'config.json'), path.join(process.cwd(), 'config.json')]) {
    try {
      if (!fs.existsSync(p)) continue;
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      Object.assign(cfg, sanitizePatch(data));
      break;
    } catch { /* unreadable config - try the next location */ }
  }
  // Migrate the old single-root key. save() keeps it mirrored.
  if ((!cfg.games_roots || !cfg.games_roots.length) && cfg.games_root) {
    cfg.games_roots = [cfg.games_root];
  }
  cfg.games_roots = dedupe(cfg.games_roots);
  cfg.folder_depths = { ...cfg.folder_depths };
  for (const root of cfg.games_roots) {
    cfg.folder_depths[folderKey(root)] ??= cfg.scan_depth;
  }
  return cfg;
}

function save(cfg) {
  cfg.games_roots = dedupe(cfg.games_roots);
  cfg.games_root = cfg.games_roots[0] || '';
  writeFileAtomic(configPath(), JSON.stringify(cfg, null, 2));
  return cfg;
}

// Accept only known config keys and block prototype injection.
function sanitizePatch(patch) {
  const clean = {};
  if (!patch || typeof patch !== 'object') return clean;
  for (const k of Object.keys(DEFAULTS)) {
    const value = patch[k], expected = DEFAULTS[k];
    const record = value !== null && typeof value === 'object' && !Array.isArray(value);
    const valid = Array.isArray(expected) ? Array.isArray(value)
      : expected === null ? value === null || record
        : typeof expected === 'object' ? record
          : typeof value === typeof expected && (typeof value !== 'number' || Number.isFinite(value));
    if (valid) clean[k] = value;
  }
  return clean;
}

function folderKey(folder) {
  return String(folder || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

function rememberSgdb(cfg, folder, gameId) {
  const id = Number(gameId);
  if (!Number.isFinite(id)) return;
  const key = folderKey(folder);
  if (key) cfg.sgdb_cache[key] = id;
}

function sgdbIdFor(cfg, folder) {
  const key = folderKey(folder);
  for (const bucket of [cfg.sgdb_map, cfg.sgdb_cache]) {
    const v = Number(bucket[key]);
    if (Number.isFinite(v) && v > 0) return v;
  }
  return null;
}

// ------------------------------------------------------------------ journal
/* Change journal: Records every change the app makes to Steam, with its inverse,
 * so purge can undo all of it. A missing journal falls back to shortcut tags.
 * Shape: { shortcuts: [{appid, appName}], fields: [{appid, field, before}],
 *          files: [{path, size, mtimeMs}] } (appid = signed int32). */
function changesPath() {
  return path.join(configDir(), 'changes.json');
}

function dataDirs() {
  return [dataDir('Shammes', '.shammes'), previousConfigDir(), legacyConfigDir()];
}

function dataFiles() {
  return dataDirs().flatMap((dir) => ['config.json', 'changes.json', 'cover-cache.json'].map((file) => path.join(dir, file)));
}

function blankChanges() {
  return { shortcuts: [], fields: [], files: [] };
}

function loadChanges() {
  for (const p of [changesPath(), path.join(legacyConfigDir(), 'changes.json')]) {
    try {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      return {
        shortcuts: Array.isArray(data.shortcuts) ? data.shortcuts : [],
        fields: Array.isArray(data.fields) ? data.fields : [],
        files: Array.isArray(data.files) ? data.files : [],
      };
    } catch { /* unreadable journal - try the next location */ }
  }
  return blankChanges();
}

function saveChanges(ch) {
  writeFileAtomic(changesPath(), JSON.stringify(ch, null, 2));
  return ch;
}

function statSig(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

module.exports = {
  DEFAULTS, configDir, load, save, sanitizePatch, folderKey, rememberSgdb, sgdbIdFor,
  dataDirs, dataFiles, blankChanges, loadChanges, saveChanges, statSig, writeFileAtomic,
};
