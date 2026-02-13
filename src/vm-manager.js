// src/vm-manager.js - QEMU lifecycle: spawn, serial+QMP, ports
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs-extra');
const http = require('http');
const net = require('net');
const { shell } = require('electron');
const { QMPClient } = require('./qmp-client');
const { TerminalManager } = require('./terminal-manager');

class VMManager {
  constructor(userDataPath, vendorPath) {
    this.userDataPath = userDataPath;
    this.vendorPath = vendorPath;
    this.vmProcess = null;
    this.isRunning = false;
    this.qemuPath = this.getQEMUPath();
    this.vmPath = path.join(userDataPath, 'vm');
    this.logsPath = path.join(userDataPath, 'logs');

    this.qmp = new QMPClient();
    this.terminal = new TerminalManager();

    this.serialPort = null;
    this.qmpPort = null;

    fs.ensureDirSync(this.vmPath);
    fs.ensureDirSync(this.logsPath);
  }

  getQEMUPath(customPath) {
    const platform = process.platform;
    const exe = platform === 'win32' ? 'qemu-system-x86_64.exe' : 'qemu-system-x86_64';

    // 0. User-configured custom path (from store)
    if (customPath) {
      // Could be a direct exe path or a directory containing it
      if (fs.existsSync(customPath) && customPath.endsWith(exe)) {
        return customPath;
      }
      const inDir = path.join(customPath, exe);
      if (fs.existsSync(inDir)) return inDir;
    }

    // 1. Bundled in vendor/qemu/ (release build)
    const vendorQemu = path.join(this.vendorPath, 'qemu', exe);
    if (fs.existsSync(vendorQemu)) return vendorQemu;

    // 2. System-installed QEMU
    if (platform === 'win32') {
      const candidates = [
        path.join(process.env.ProgramFiles || '', 'qemu', exe),
        path.join(process.env['ProgramFiles(x86)'] || '', 'qemu', exe),
      ];
      for (const p of candidates) {
        if (p && fs.existsSync(p)) return p;
      }
    }

    // 3. Bare name - relies on system PATH
    return exe;
  }

  setQEMUPath(customPath) {
    this.qemuPath = this.getQEMUPath(customPath);
  }

  /**
   * Check if QEMU is available on the system
   */
  async checkQEMUAvailable() {
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec(`"${this.qemuPath}" --version`, (error, stdout) => {
        if (error) {
          resolve({ available: false, error: error.message });
        } else {
          const match = stdout.match(/version\s+([\d.]+)/);
          resolve({ available: true, version: match ? match[1] : 'unknown' });
        }
      });
    });
  }

  async start(config) {
    if (this.isRunning) {
      throw new Error('VM is already running');
    }

    const vmImage = path.join(this.vmPath, 'openclaw-headless.qcow2');
    if (!fs.existsSync(vmImage)) {
      throw new Error('VM image not found. Please download it first.');
    }

    // Allocate dynamic TCP ports for serial and QMP
    this.serialPort = await this.findFreePort(14000);
    this.qmpPort = await this.findFreePort(this.serialPort + 1);

    const logFile = path.join(this.logsPath, `vm-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logFile);
    this.currentLogFile = logFile;

    const args = this.buildQEMUArgs(config, vmImage);
    console.log('Starting QEMU with args:', args.join(' '));

    this.vmProcess = spawn(this.qemuPath, args, {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    this.vmProcess.stdout.pipe(logStream);
    this.vmProcess.stderr.pipe(logStream);

    this.vmProcess.on('exit', (code) => {
      console.log(`VM process exited with code ${code}`);
      this.isRunning = false;
      this.serialPort = null;
      this.qmpPort = null;
      logStream.end();
    });

    this.vmProcess.on('error', (error) => {
      console.error('VM process error:', error);
      this.isRunning = false;
      this.serialPort = null;
      this.qmpPort = null;
      logStream.end();
    });

    this.isRunning = true;

    // Give QEMU a moment to start, then check it hasn't crashed
    await new Promise(resolve => setTimeout(resolve, 2000));
    if (!this.isRunning || !this.vmProcess || this.vmProcess.exitCode !== null) {
      const logContents = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').slice(-500) : '';
      throw new Error('QEMU process exited immediately.\n' + logContents);
    }

    // Connect QMP and serial console
    console.log(`Connecting QMP on port ${this.qmpPort}...`);
    await this.qmp.connect(this.qmpPort);
    console.log('QMP connected.');

    console.log(`Connecting serial console on port ${this.serialPort}...`);
    await this.terminal.connect(this.serialPort);
    console.log('Serial console connected.');

    // Auto-login
    console.log('Starting auto-login...');
    await this.terminal.autoLogin('node', 'openclaw');
    console.log('Auto-login complete.');

    return true;
  }

  buildQEMUArgs(config, vmImage) {
    // Build user-net string with port forwarding (and SMB on Windows if shared folder set)
    let userNet = 'user,hostfwd=tcp::18789-:18789,hostfwd=tcp::18790-:18790';
    if (config.sharedFolder && process.platform === 'win32') {
      // virtfs/9p has no Windows host support.
      // QEMU user-mode SMB: VM accesses the folder at \\10.0.2.4\qemu
      userNet += `,smb=${config.sharedFolder}`;
    }

    const args = [
      '-m', config.memory || '1024',
      '-smp', config.cpus || '2',
      '-hda', vmImage,
      '-device', 'virtio-rng-pci',
      '-net', 'nic,model=virtio',
      '-net', userNet,
      '-display', 'none',
      // Serial console via TCP
      '-chardev', `socket,id=serial0,host=127.0.0.1,port=${this.serialPort},server=on,wait=off`,
      '-serial', 'chardev:serial0',
      // QMP via TCP
      '-chardev', `socket,id=mon0,host=127.0.0.1,port=${this.qmpPort},server=on,wait=off`,
      '-mon', 'chardev=mon0,mode=control'
    ];

    // Shared folder on non-Windows: use virtfs/9p
    if (config.sharedFolder && process.platform !== 'win32') {
      args.push(
        '-virtfs',
        `local,path=${config.sharedFolder},mount_tag=host_share,security_model=passthrough,id=host_share`
      );
    }

    // Hardware acceleration (with fallback chain)
    if (process.platform === 'win32') {
      // Try WHPX first, fall back to HAXM, then software (tcg)
      args.push('-accel', 'whpx,kernel-irqchip=off', '-accel', 'hax', '-accel', 'tcg');
    } else if (process.platform === 'darwin') {
      args.push('-accel', 'hvf', '-accel', 'tcg');
    } else {
      args.push('-accel', 'kvm', '-accel', 'tcg');
    }

    return args;
  }

  async runOnboarding() {
    if (!this.terminal.loggedIn) {
      throw new Error('Terminal not logged in');
    }
    await this.terminal.exec('cd /app && node dist/index.js onboard');
  }

  /**
   * Trigger OpenClaw update inside the VM via its built-in update command.
   * Output is visible in the terminal window.
   */
  async updateOpenClaw() {
    if (!this.terminal.loggedIn) {
      throw new Error('Terminal not logged in');
    }
    await this.terminal.exec('cd /app && node dist/index.js update');
  }

  async waitForOpenClaw(timeout = 120000) {
    const startTime = Date.now();
    const gatewayPort = 18789;

    console.log('Waiting for OpenClaw Gateway on port 18789...');

    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(async () => {
        if (Date.now() - startTime > timeout) {
          clearInterval(checkInterval);
          reject(new Error('OpenClaw Gateway startup timeout'));
          return;
        }

        try {
          const health = await this.getOpenClawHealth();
          if (health.healthy) {
            console.log('OpenClaw Gateway is ready!');
            clearInterval(checkInterval);
            resolve();
          }
        } catch (error) {
          // Keep waiting
        }
      }, 2000);
    });
  }

  async getOpenClawHealth() {
    return new Promise((resolve, reject) => {
      const req = http.get('http://localhost:18789/health', (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const health = JSON.parse(data);
            resolve({ healthy: res.statusCode === 200, ...health });
          } catch (error) {
            resolve({ healthy: res.statusCode === 200, status: 'running' });
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error('Health check timeout'));
      });
    });
  }

  async stop() {
    if (!this.isRunning || !this.vmProcess) {
      return;
    }

    return new Promise((resolve) => {
      // Try graceful QMP shutdown
      if (this.qmp.ready) {
        console.log('Sending QMP system_powerdown...');
        this.qmp.shutdown().catch(() => {});
      }

      // Wait 15s for graceful shutdown, then SIGTERM, then SIGKILL
      const gracefulTimeout = setTimeout(() => {
        if (this.vmProcess) {
          console.log('Graceful shutdown timeout, sending SIGTERM...');
          this.vmProcess.kill('SIGTERM');

          const forceTimeout = setTimeout(() => {
            if (this.vmProcess) {
              console.log('SIGTERM timeout, sending SIGKILL...');
              this.vmProcess.kill('SIGKILL');
            }
            cleanup();
          }, 5000);

          this.vmProcess.once('exit', () => {
            clearTimeout(forceTimeout);
            cleanup();
          });
        } else {
          cleanup();
        }
      }, 15000);

      this.vmProcess.once('exit', () => {
        clearTimeout(gracefulTimeout);
        cleanup();
      });

      const cleanup = () => {
        this.qmp.disconnect();
        this.terminal.disconnect();
        this.isRunning = false;
        this.serialPort = null;
        this.qmpPort = null;
        resolve();
      };
    });
  }

  async restart() {
    const Store = (await import('electron-store')).default;
    const store = new Store();

    await this.stop();
    await new Promise(resolve => setTimeout(resolve, 3000));
    await this.start(store.get('config'));
  }

  openBrowser() {
    shell.openExternal('http://localhost:18789');
  }

  openLogs() {
    shell.openPath(this.logsPath);
  }

  async openSharedFolder() {
    const Store = (await import('electron-store')).default;
    const store = new Store();
    const config = store.get('config');
    if (config && config.sharedFolder) {
      shell.openPath(config.sharedFolder);
    }
  }

  async checkPort(port) {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => {
        server.close();
        resolve(true);
      });
      server.listen(port);
    });
  }

  async findFreePort(startPort) {
    let port = startPort;
    while (port < startPort + 100) {
      if (await this.checkPort(port)) {
        return port;
      }
      port++;
    }
    throw new Error('No free port found');
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      pid: this.vmProcess ? this.vmProcess.pid : null,
      serialPort: this.serialPort,
      qmpPort: this.qmpPort,
      terminalReady: this.terminal.loggedIn
    };
  }
}

module.exports = { VMManager };
