// src/main.js - Electron entry point: tray, terminal window, IPC
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, Notification, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const Store = require('electron-store');
const { VMManager } = require('./vm-manager');
const { UpdateChecker } = require('./update-checker');

const store = new Store();
let tray = null;
let vmManager = null;
let updateChecker = null;
let setupWindow = null;
let terminalWindow = null;
let downloadWindow = null;
let bootWindow = null;

// Single-instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (terminalWindow && terminalWindow.isVisible()) {
      if (terminalWindow.isMinimized()) terminalWindow.restore();
      terminalWindow.focus();
    }
  });

  app.whenReady().then(init);
}

async function init() {
  const userDataPath = app.getPath('userData');

  // Resolve vendor/ path: inside resources when packaged, project root in dev
  const vendorPath = app.isPackaged
    ? path.join(process.resourcesPath, 'vendor')
    : path.join(__dirname, '..', 'vendor');

  // If user previously pointed us to a custom QEMU path, use it
  const savedQemuPath = store.get('qemuPath');
  vmManager = new VMManager(userDataPath, vendorPath);
  if (savedQemuPath) vmManager.setQEMUPath(savedQemuPath);
  updateChecker = new UpdateChecker(vendorPath);

  setupIPC();

  // Check QEMU availability - if not found, let user browse for it
  let qemuCheck = await vmManager.checkQEMUAvailable();
  if (!qemuCheck.available) {
    const result = await dialog.showMessageBox({
      type: 'warning',
      title: 'QEMU Not Found',
      message: 'QEMU is required but was not found automatically.\nWould you like to locate it?',
      buttons: ['Browse...', 'Quit'],
      defaultId: 0
    });

    if (result.response === 0) {
      const exe = process.platform === 'win32' ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64';
      const filters = process.platform === 'win32'
        ? [{ name: 'QEMU', extensions: ['exe'] }]
        : [{ name: 'QEMU', extensions: ['*'] }];

      const { filePaths } = await dialog.showOpenDialog({
        title: `Select ${exe}`,
        filters,
        properties: ['openFile']
      });

      if (filePaths && filePaths[0]) {
        store.set('qemuPath', filePaths[0]);
        vmManager.setQEMUPath(filePaths[0]);
        qemuCheck = await vmManager.checkQEMUAvailable();
      }
    }

    if (!qemuCheck.available) {
      dialog.showErrorBox('QEMU Not Found', 'Cannot start without QEMU.');
      app.quit();
      return;
    }
  }

  const isFirstRun = !store.has('config');

  if (isFirstRun) {
    await showSetupWizard();
  } else {
    await startApp();
  }
}

// ==================== Setup ====================

async function showSetupWizard() {
  setupWindow = new BrowserWindow({
    width: 700,
    height: 650,
    resizable: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  setupWindow.loadFile(path.join(__dirname, '../ui/setup.html'));

  ipcMain.once('setup-complete', async (event, config) => {
    store.set('config', config);
    setupWindow.close();
    setupWindow = null;

    // Download VM image (split files from GitHub releases)
    await downloadVMImage();

    await startApp();
  });
}

async function downloadVMImage() {
  // Skip download if image already exists on disk
  const vmDir = path.join(app.getPath('userData'), 'vm');
  const existingImage = path.join(vmDir, 'openclaw-headless.qcow2');
  if (fs.existsSync(existingImage)) {
    console.log('VM image already exists, skipping download.');
    return;
  }

  downloadWindow = new BrowserWindow({
    width: 500,
    height: 220,
    resizable: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  downloadWindow.loadFile(path.join(__dirname, '../ui/download.html'));

  try {
    const result = await updateChecker.downloadAndExtractVM(vmDir, (progress) => {
      if (downloadWindow && !downloadWindow.isDestroyed()) {
        downloadWindow.webContents.send('download-progress', {
          percent: progress.percent,
          downloaded: progress.downloaded,
          total: progress.total,
          speed: progress.speed,
          status: progress.status
        });
      }
    });

    store.set('currentVMVersion', result.version);

    if (downloadWindow && !downloadWindow.isDestroyed()) {
      downloadWindow.close();
    }
    downloadWindow = null;

    new Notification({
      title: 'OpenClaw VM',
      body: 'VM image download complete!'
    }).show();

  } catch (error) {
    if (downloadWindow && !downloadWindow.isDestroyed()) {
      downloadWindow.close();
    }
    downloadWindow = null;
    dialog.showErrorBox('Download Failed', error.message);
    app.quit();
  }
}

// ==================== Boot Status Window ====================

function showBootWindow() {
  if (bootWindow && !bootWindow.isDestroyed()) {
    bootWindow.focus();
    return;
  }

  bootWindow = new BrowserWindow({
    width: 440,
    height: 480,
    resizable: false,
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  bootWindow.loadFile(path.join(__dirname, '../ui/boot.html'));

  bootWindow.on('closed', () => {
    bootWindow = null;
  });
}

function sendBootStatus(stage, message) {
  if (bootWindow && !bootWindow.isDestroyed()) {
    bootWindow.webContents.send('boot-status', { stage, message });
  }
  // Also update tray tooltip
  if (tray) {
    tray.setToolTip(`OpenClaw VM - ${message}`);
  }
}

function closeBootWindow() {
  if (bootWindow && !bootWindow.isDestroyed()) {
    bootWindow.close();
  }
  bootWindow = null;
}

// ==================== Main App ====================

async function startApp() {
  createTray();

  const config = store.get('config');
  const isFirstRun = !store.has('onboardingComplete');

  // Show boot status window
  showBootWindow();

  try {
    // Stage 1: Starting QEMU
    sendBootStatus('qemu', 'Starting QEMU...');

    // Listen for login status events from terminal manager
    const onLoginStatus = (stage, message) => {
      console.log(`Login status: ${stage} - ${message}`);
      if (stage === 'waiting_boot') {
        sendBootStatus('boot', message);
      } else if (stage === 'login_prompt' || stage === 'authenticating') {
        sendBootStatus('login', message);
      } else if (stage === 'configuring' || stage === 'ready') {
        sendBootStatus('login', message);
      }
    };
    vmManager.terminal.on('login-status', onLoginStatus);

    await vmManager.start(config);

    vmManager.terminal.removeListener('login-status', onLoginStatus);

    if (isFirstRun) {
      // First run: launch onboarding in terminal
      sendBootStatus('done', 'Ready');
      closeBootWindow();

      await vmManager.runOnboarding();
      showTerminalWindow();

      new Notification({
        title: 'OpenClaw VM',
        body: 'Complete the setup in the terminal window.'
      }).show();

      // Wait for OpenClaw to come up after onboarding
      try {
        await vmManager.waitForOpenClaw();
        store.set('onboardingComplete', true);
        updateTrayMenu();

        new Notification({
          title: 'OpenClaw VM',
          body: 'OpenClaw is ready!'
        }).show();
      } catch (err) {
        console.log('OpenClaw not detected yet - user may still be onboarding.');
      }
    } else {
      // Normal start: wait for OpenClaw, then notify
      sendBootStatus('openclaw', 'Waiting for OpenClaw service...');

      await vmManager.waitForOpenClaw();

      sendBootStatus('done', 'Ready');
      closeBootWindow();

      new Notification({
        title: 'OpenClaw VM',
        body: 'OpenClaw is ready!'
      }).show();
    }

    if (tray) tray.setToolTip('OpenClaw VM - Running');
    updateTrayMenu();

  } catch (error) {
    closeBootWindow();
    dialog.showErrorBox('Startup Failed', error.message);
  }

  // Auto-start on login
  if (config.autoStart) {
    app.setLoginItemSettings({
      openAtLogin: true,
      path: process.execPath
    });
  }
}

// ==================== Terminal Window ====================

function showTerminalWindow() {
  if (terminalWindow && !terminalWindow.isDestroyed()) {
    terminalWindow.show();
    terminalWindow.focus();
    return;
  }

  terminalWindow = new BrowserWindow({
    width: 900,
    height: 600,
    minWidth: 400,
    minHeight: 300,
    title: 'OpenClaw Terminal',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  terminalWindow.loadFile(path.join(__dirname, '../ui/terminal.html'));

  terminalWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      terminalWindow.hide();
      return;
    }
  });

  terminalWindow.on('closed', () => {
    terminalWindow = null;
  });
}

// ==================== System Tray ====================

function createTray() {
  const iconPath = path.join(__dirname, '../assets/icon.png');
  if (!fs.existsSync(iconPath)) {
    fs.ensureDirSync(path.join(__dirname, '../assets'));
  }

  try {
    tray = new Tray(iconPath);
  } catch (e) {
    console.error('Failed to create tray with icon:', e.message);
    return;
  }

  tray.setToolTip('OpenClaw VM Manager');
  updateTrayMenu();

  tray.on('double-click', () => {
    vmManager.openBrowser();
  });

  // Periodically update tray icon
  setInterval(() => {
    updateTrayIcon();
  }, 5000);
}

function updateTrayMenu() {
  if (!tray) return;

  const isRunning = vmManager && vmManager.isRunning;
  const statusLabel = isRunning ? 'OpenClaw Running' : 'OpenClaw Stopped';

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'OpenClaw VM Manager',
      enabled: false
    },
    {
      label: statusLabel,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Open Web UI',
      enabled: isRunning,
      click: () => vmManager.openBrowser()
    },
    {
      label: 'Open Terminal',
      click: () => showTerminalWindow()
    },
    { type: 'separator' },
    {
      label: 'Update OpenClaw',
      enabled: isRunning,
      click: () => {
        showTerminalWindow();
        // Small delay to ensure terminal window is ready
        setTimeout(async () => {
          try {
            await vmManager.updateOpenClaw();
          } catch (error) {
            dialog.showErrorBox('Update Failed', error.message);
          }
        }, 500);
      }
    },
    {
      label: 'Restart VM',
      click: async () => {
        try {
          showBootWindow();
          sendBootStatus('qemu', 'Restarting VM...');

          const onLoginStatus = (stage, message) => {
            if (stage === 'waiting_boot') sendBootStatus('boot', message);
            else if (stage === 'login_prompt' || stage === 'authenticating') sendBootStatus('login', message);
            else if (stage === 'ready') sendBootStatus('login', message);
          };
          vmManager.terminal.on('login-status', onLoginStatus);

          await vmManager.restart();

          vmManager.terminal.removeListener('login-status', onLoginStatus);

          sendBootStatus('openclaw', 'Waiting for OpenClaw service...');
          await vmManager.waitForOpenClaw();

          sendBootStatus('done', 'Ready');
          closeBootWindow();

          updateTrayMenu();
          if (tray) tray.setToolTip('OpenClaw VM - Running');
          new Notification({
            title: 'OpenClaw VM',
            body: 'VM restarted successfully.'
          }).show();
        } catch (error) {
          closeBootWindow();
          dialog.showErrorBox('Restart Failed', error.message);
        }
      }
    },
    {
      label: 'View Logs',
      click: () => vmManager.openLogs()
    },
    {
      label: 'Open Shared Folder',
      click: () => vmManager.openSharedFolder()
    },
    { type: 'separator' },
    {
      label: 'Settings',
      click: () => showSettings()
    },
    {
      label: 'About',
      click: () => showAbout()
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: async () => {
        app.isQuitting = true;
        if (tray) tray.setToolTip('OpenClaw VM - Shutting down...');
        await vmManager.stop();
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function updateTrayIcon() {
  if (!tray) return;

  const activeIconPath = path.join(__dirname, '../assets/icon-active.png');
  const iconPath = path.join(__dirname, '../assets/icon.png');

  try {
    if (vmManager && vmManager.isRunning && fs.existsSync(activeIconPath)) {
      tray.setImage(activeIconPath);
    } else if (fs.existsSync(iconPath)) {
      tray.setImage(iconPath);
    }
  } catch (e) {
    // Ignore icon update errors
  }
}

// ==================== IPC Handlers ====================

function setupIPC() {
  // Terminal I/O
  ipcMain.on('terminal-input', (event, data) => {
    if (vmManager && vmManager.terminal) {
      vmManager.terminal.write(data);
    }
  });

  ipcMain.on('terminal-resize', (event, { cols, rows }) => {
    if (vmManager && vmManager.terminal) {
      vmManager.terminal.resize(cols, rows);
    }
  });

  // Forward serial output to terminal window
  const setupTerminalRelay = () => {
    if (vmManager && vmManager.terminal) {
      vmManager.terminal.on('data', (data) => {
        if (terminalWindow && !terminalWindow.isDestroyed()) {
          terminalWindow.webContents.send('terminal-output', data);
        }
      });
    }
  };

  // Re-check terminal relay periodically until connected
  const relayCheck = setInterval(() => {
    if (vmManager && vmManager.terminal && vmManager.terminal.connected) {
      setupTerminalRelay();
      clearInterval(relayCheck);
    }
  }, 1000);

  // VM Status
  ipcMain.handle('get-vm-status', () => {
    if (vmManager) {
      return vmManager.getStatus();
    }
    return { isRunning: false };
  });

  // Folder selection
  ipcMain.handle('select-folder', async () => {
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });
}

// ==================== Settings ====================

function showSettings() {
  const settingsWindow = new BrowserWindow({
    width: 700,
    height: 650,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  // Remove the menu bar entirely for this window
  settingsWindow.setMenu(null);

  settingsWindow.loadFile(path.join(__dirname, '../ui/setup.html'));

  settingsWindow.webContents.on('did-finish-load', () => {
    settingsWindow.webContents.send('load-config', store.get('config'));
  });

  ipcMain.once('setup-complete', async (event, newConfig) => {
    const oldConfig = store.get('config');
    store.set('config', newConfig);

    if (oldConfig.memory !== newConfig.memory ||
        oldConfig.cpus !== newConfig.cpus ||
        oldConfig.sharedFolder !== newConfig.sharedFolder) {
      try {
        await vmManager.restart();
        updateTrayMenu();
      } catch (error) {
        dialog.showErrorBox('Restart Failed', error.message);
      }
    }

    settingsWindow.close();
  });
}

function showAbout() {
  dialog.showMessageBox({
    type: 'info',
    title: 'About OpenClaw VM Manager',
    message: 'OpenClaw VM Manager',
    detail: `Version: ${app.getVersion()}\n\nPersonal AI Assistant VM Manager\n\nPowered by QEMU & Electron`
  });
}

// ==================== App Lifecycle ====================

app.on('before-quit', async () => {
  app.isQuitting = true;
  if (vmManager && vmManager.isRunning) {
    await vmManager.stop();
  }
});

app.on('window-all-closed', () => {
  // Don't quit - keep running in tray
});

app.on('activate', () => {
  if (setupWindow === null && !store.has('config')) {
    showSetupWizard();
  }
});
