'use strict';

const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createWriteStream } = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { promisify } = require('node:util');

const run = promisify(execFile);
const installKey = 'Software\\549f8bdd-176e-556e-a89d-b773b7ce58c0';

async function installedScope(executable) {
  for (const [hive, scope] of [['HKCU', '/currentuser'], ['HKLM', '/allusers']]) {
    try {
      const { stdout } = await run('reg.exe', ['query', `${hive}\\${installKey}`, '/v', 'InstallLocation', '/reg:64'], {
        timeout: 3000, windowsHide: true,
      });
      const directory = stdout.match(/\bInstallLocation\s+REG_SZ\s+([^\r\n]+)/i)?.[1].trim();
      if (directory && path.resolve(directory).toLowerCase() === path.dirname(executable).toLowerCase()) return scope;
    } catch { /* The installation may be registered in the other hive. */ }
  }
  return null;
}

async function prepareUpdate(asset, directory, onProgress = () => {}) {
  const target = path.join(directory, 'Shammes-Update.exe');
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error('Could not download the update.');
  const hash = createHash('sha256');
  let bytes = 0;
  let percent = 0;
  await pipeline(response.body, async function* (chunks) {
    for await (const chunk of chunks) {
      bytes += chunk.length;
      if (bytes > asset.size) throw new Error('The update file is larger than expected.');
      hash.update(chunk);
      const next = Math.floor(bytes * 100 / asset.size);
      if (next !== percent) onProgress(percent = next);
      yield chunk;
    }
  }, createWriteStream(target, { flags: 'wx' }));
  if (bytes !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) {
    throw new Error('The update file could not be verified.');
  }
  return target;
}

function launchUpdate(executable, scope) {
  const script = `
    $ErrorActionPreference = 'Stop'
    try {
      Wait-Process -Id $env:SHAMMES_UPDATE_PARENT -Timeout 30 -ErrorAction SilentlyContinue
      for ($i = 0; $i -lt 30 -and (Get-Process -Name Shammes -ErrorAction SilentlyContinue); $i++) {
        Start-Sleep -Milliseconds 500
      }
      if (Get-Process -Name Shammes -ErrorAction SilentlyContinue) {
        throw 'Close all Shammes windows before updating.'
      }
      $installer = Start-Process -FilePath $env:SHAMMES_UPDATE_EXE -ArgumentList @('/S', '--updated', '--force-run', $env:SHAMMES_UPDATE_SCOPE) -Wait -PassThru -WindowStyle Hidden
      if ($installer.ExitCode -ne 0) { throw 'The installer could not finish the update.' }
    } catch {
      Add-Type -AssemblyName PresentationFramework
      [System.Windows.MessageBox]::Show($_.Exception.Message, 'Shammes update') | Out-Null
    } finally {
      Remove-Item -LiteralPath $env:SHAMMES_UPDATE_EXE -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath (Split-Path -Parent $env:SHAMMES_UPDATE_EXE) -ErrorAction SilentlyContinue
    }
  `;
  const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = Buffer.from(script, 'utf16le').toString('base64');
  const bootstrap = `Start-Process -FilePath (Get-Process -Id $PID).Path -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', '${command}') -WindowStyle Hidden -ErrorAction Stop`;
  return run(powershell, ['-NoProfile', '-NonInteractive', '-Command', bootstrap], {
    timeout: 10000, windowsHide: true,
    env: { ...process.env, SHAMMES_UPDATE_EXE: executable, SHAMMES_UPDATE_SCOPE: scope, SHAMMES_UPDATE_PARENT: String(process.pid) },
  });
}

module.exports = { installedScope, prepareUpdate, launchUpdate };
