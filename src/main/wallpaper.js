'use strict';
const { execFile } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');

const exec = promisify(execFile);
const positions = { center: 0, stretch: 2, fit: 3, fill: 4 };
const wallpaperInterop = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

[ComImport, Guid("B92B56A9-8B55-4E14-9A89-0199BBB6F93B")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IDesktopWallpaper {
    void SetWallpaper([MarshalAs(UnmanagedType.LPWStr)] string monitor,
                      [MarshalAs(UnmanagedType.LPWStr)] string file);
    void GetWallpaper(IntPtr monitor, out IntPtr wallpaper);
    void GetMonitorDevicePathAt(uint index, out IntPtr monitor);
    void GetMonitorDevicePathCount(out uint count);
    void GetMonitorRECT(IntPtr monitor, IntPtr rect);
    void SetBackgroundColor(uint color);
    void GetBackgroundColor(out uint color);
    void SetPosition(int position);
    void GetPosition(out int position);
}

public static class DesktopWallpaper {
    public static void Set(string file, int position) {
        var type = Type.GetTypeFromCLSID(new Guid("C2CF3110-460E-4FC1-B9D0-8A1C0C9CC4BD"));
        var wallpaper = (IDesktopWallpaper)Activator.CreateInstance(type);
        try {
            int previous;
            wallpaper.GetPosition(out previous);
            wallpaper.SetPosition(position);
            try { wallpaper.SetWallpaper(null, file); }
            catch {
                wallpaper.SetPosition(previous);
                throw;
            }
        } finally { Marshal.ReleaseComObject(wallpaper); }
    }
}
'@
`;

async function setWallpaper(folder, jpeg, fit = 'fill') {
  if (process.platform !== 'win32') throw new Error('Desktop backgrounds are available on Windows.');
  if (!Object.hasOwn(positions, fit)) throw new Error('Invalid desktop background fit.');
  const hash = createHash('sha256').update(jpeg).digest('hex').slice(0, 16);
  const file = path.join(folder, `Artwork-${hash}.jpg`);
  await fs.mkdir(folder, { recursive: true });
  const existing = await fs.stat(file).catch(error => {
    if (error.code !== 'ENOENT') throw error;
  });
  if (existing?.size !== jpeg.length) {
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(temporary, jpeg, { flag: 'wx' });
      await fs.rename(temporary, file);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
  await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command',
    `$ErrorActionPreference = 'Stop'\n${wallpaperInterop}\n[DesktopWallpaper]::Set($env:SHAMMES_WALLPAPER, ${positions[fit]})`], {
    env: { ...process.env, SHAMMES_WALLPAPER: file }, windowsHide: true, timeout: 20000,
  });
}

module.exports = { setWallpaper };
