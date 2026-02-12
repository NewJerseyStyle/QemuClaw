// src/terminal-manager.js - Serial console TCP client with auto-login
const net = require('net');
const EventEmitter = require('events');

class TerminalManager extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.connected = false;
    this.loggedIn = false;
    this.loginState = 'idle';
    this.cols = 80;
    this.rows = 24;
  }

  async connect(port, host = '127.0.0.1', retries = 30, retryDelay = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this._tryConnect(port, host);
        return;
      } catch (error) {
        if (attempt === retries) {
          throw new Error(`Serial: Failed to connect after ${retries} attempts: ${error.message}`);
        }
        console.log(`Serial: Connection attempt ${attempt}/${retries} failed, retrying...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      }
    }
  }

  _tryConnect(port, host) {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      let resolved = false;

      const onError = (err) => {
        if (!resolved) {
          resolved = true;
          this.socket.destroy();
          reject(err);
        }
      };

      this.socket.once('error', onError);

      this.socket.connect(port, host, () => {
        resolved = true;
        this.connected = true;
        this.socket.removeListener('error', onError);

        this.socket.on('data', (data) => {
          // Forward ALL data to xterm.js (user sees boot messages, login, etc.)
          this.emit('data', data.toString());
        });

        this.socket.on('error', (err) => {
          console.error('Serial: Socket error:', err.message);
          this.connected = false;
          this.emit('error', err);
        });

        this.socket.on('close', () => {
          this.connected = false;
          this.loggedIn = false;
          this.loginState = 'idle';
          this.emit('close');
        });

        this.emit('connected');
        resolve();
      });

      this.socket.setTimeout(5000, () => {
        if (!resolved) {
          resolved = true;
          this.socket.destroy();
          reject(new Error('Serial: Connection timeout'));
        }
      });
    });
  }

  /**
   * Auto-login via serial console.
   * Waits indefinitely for the login prompt — no hard timeout.
   * Emits 'login-status' events so callers can show progress to the user.
   * The onlyAbort path is disconnect() or the socket closing.
   */
  async autoLogin(username = 'node', password = 'openclaw') {
    if (!this.connected) {
      throw new Error('Serial: Not connected');
    }

    return new Promise((resolve, reject) => {
      let buffer = '';
      this.loginState = 'waiting_login';
      this.emit('login-status', 'waiting_boot', 'Waiting for VM to boot...');

      const onData = (data) => {
        buffer += data;

        // Keep only last 4KB to avoid memory buildup during long boot
        if (buffer.length > 4096) {
          buffer = buffer.slice(-2048);
        }

        switch (this.loginState) {
          case 'waiting_login':
            if (buffer.includes('login:')) {
              buffer = '';
              this.loginState = 'sending_username';
              this.emit('login-status', 'login_prompt', 'Login prompt detected, sending credentials...');
              this.socket.write(username + '\r\n');
              this.loginState = 'waiting_password';
            }
            break;

          case 'waiting_password':
            if (buffer.includes('assword:')) {
              buffer = '';
              this.loginState = 'sending_password';
              this.socket.write(password + '\r\n');
              this.loginState = 'waiting_shell';
              this.emit('login-status', 'authenticating', 'Authenticating...');
            }
            break;

          case 'waiting_shell':
            if (buffer.includes('$') || buffer.includes('#') || buffer.includes('~]')) {
              buffer = '';
              this.loginState = 'configuring';
              this.emit('login-status', 'configuring', 'Configuring terminal...');
              // Configure terminal environment
              this.socket.write(`export TERM=xterm-256color\r\n`);
              setTimeout(() => {
                this.socket.write(`stty cols ${this.cols} rows ${this.rows}\r\n`);
                setTimeout(() => {
                  this.loggedIn = true;
                  this.loginState = 'ready';
                  cleanup();
                  this.emit('login-status', 'ready', 'Logged in');
                  this.emit('ready');
                  resolve();
                }, 500);
              }, 500);
            }
            break;
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error('Serial: Connection closed during login'));
      };

      // Periodic nudge to trigger login prompt during VM boot
      const nudgeInterval = setInterval(() => {
        if (this.loginState === 'waiting_login' && this.connected) {
          this.socket.write('\r\n');
        }
      }, 10000);

      const cleanup = () => {
        clearInterval(nudgeInterval);
        this.removeListener('data', onData);
        this.removeListener('close', onClose);
      };

      this.on('data', onData);
      this.once('close', onClose);

      // Initial nudge after a short delay
      setTimeout(() => {
        if (this.connected && this.loginState === 'waiting_login') {
          this.socket.write('\r\n');
        }
      }, 2000);
    });
  }

  write(data) {
    if (this.socket && this.connected) {
      this.socket.write(data);
    }
  }

  async exec(command) {
    if (!this.loggedIn) {
      throw new Error('Serial: Not logged in');
    }
    this.socket.write(command + '\r\n');
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    if (this.loggedIn && this.connected) {
      this.socket.write(`stty cols ${cols} rows ${rows}\r\n`);
    }
  }

  disconnect() {
    this.connected = false;
    this.loggedIn = false;
    this.loginState = 'idle';
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

module.exports = { TerminalManager };
