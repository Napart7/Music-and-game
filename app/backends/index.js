'use strict';
// Platform routing: one place that knows where the backend scripts live, how to run them,
// and what each OS can/cannot do. main.js never hard-codes an interpreter again.
const path = require('path');

/**
 * @param {string} platform  process.platform value ('win32' | 'darwin' | 'linux')
 * @param {(name: string) => string} resolve  maps a bundled script name to an absolute path
 *        (dev: __dirname; packaged: process.resourcesPath)
 */
function backendFor(platform, resolve) {
  if (platform === 'darwin') {
    return {
      id: 'darwin',
      capabilities: {
        transparency: 'full',          // Electron transparent window works on macOS 10.15+
        alwaysOnTop: 'screen-saver',
        globalHotkeys: true,
        tray: true,
        loginItem: 'electron',         // app.setLoginItemSettings is supported
        windowProbe: 'accessibility',  // needs Accessibility permission
        clickThrough: true
      },
      media: {
        cmd: 'osascript',
        args: (s) => ['-l', 'JavaScript', s],
        script: resolve('backends/media-mac.js')
      },
      control: {
        cmd: 'osascript',
        args: (s, action) => ['-l', 'JavaScript', s, action],
        script: resolve('backends/control-mac.js')
      },
      window: {
        cmd: 'osascript',
        args: (s) => ['-l', 'JavaScript', s],
        script: resolve('backends/window-mac.js')
      }
    };
  }
  if (platform === 'linux') {
    return {
      id: 'linux',
      capabilities: {
        transparency: 'compositor',    // needs a compositing WM; Wayland varies
        alwaysOnTop: 'screen-saver',
        globalHotkeys: true,           // X11 ok; Wayland: compositor-dependent
        tray: 'appindicator',          // needs libappindicator on some distros
        loginItem: 'xdg-autostart',    // Electron does not implement Linux login items
        windowProbe: 'x11',            // xdotool/xprop; Wayland unsupported
        clickThrough: true
      },
      media: {
        cmd: 'bash',
        args: (s) => [s],
        script: resolve('backends/media-linux.sh')
      },
      control: {
        cmd: 'bash',
        args: (s, action) => [s, action],
        script: resolve('backends/control-linux.sh')
      },
      window: {
        cmd: 'bash',
        args: (s) => [s],
        script: resolve('backends/window-linux.sh')
      }
    };
  }
  // default: win32
  return {
    id: 'win32',
    capabilities: {
      transparency: 'full',
      alwaysOnTop: 'screen-saver',
      globalHotkeys: true,
      tray: true,
      loginItem: 'electron',
      windowProbe: 'win32',
      clickThrough: true
    },
    media: {
      cmd: 'powershell.exe',
      args: (s) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', s],
      script: resolve('smtc-bridge.ps1')
    },
    control: {
      cmd: 'powershell.exe',
      args: (s, action) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', s, '-Action', action],
      script: resolve('smtc-control.ps1')
    },
    window: {
      cmd: 'powershell.exe',
      args: (s) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', s],
      script: resolve('window-probe.ps1')
    }
  };
}

/** Tray icon format differs per OS: .ico on Windows, .png elsewhere. */
function trayIconName(platform) {
  return platform === 'win32' ? 'assets/icon.ico' : 'assets/icon.png';
}

module.exports = { backendFor, trayIconName, path };
