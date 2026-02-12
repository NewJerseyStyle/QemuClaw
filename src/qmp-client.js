// src/qmp-client.js - QMP (QEMU Machine Protocol) TCP client
const net = require('net');
const EventEmitter = require('events');

class QMPClient extends EventEmitter {
  constructor() {
    super();
    this.socket = null;
    this.ready = false;
    this.buffer = '';
    this.commandId = 0;
    this.pendingCommands = new Map();
  }

  async connect(port, host = '127.0.0.1', retries = 30, retryDelay = 2000) {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        await this._tryConnect(port, host);
        return;
      } catch (error) {
        if (attempt === retries) {
          throw new Error(`QMP: Failed to connect after ${retries} attempts: ${error.message}`);
        }
        console.log(`QMP: Connection attempt ${attempt}/${retries} failed, retrying in ${retryDelay}ms...`);
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
        this.socket.removeListener('error', onError);
        this._setupHandlers(resolve, reject);
      });

      // Connection timeout
      this.socket.setTimeout(5000, () => {
        if (!resolved) {
          resolved = true;
          this.socket.destroy();
          reject(new Error('QMP: Connection timeout'));
        }
      });
    });
  }

  _setupHandlers(onReady, onError) {
    let negotiated = false;

    this.socket.on('data', (data) => {
      this.buffer += data.toString();

      // Split on newlines - QMP sends one JSON object per line
      const lines = this.buffer.split('\n');
      this.buffer = lines.pop(); // Keep incomplete line in buffer

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let msg;
        try {
          msg = JSON.parse(trimmed);
        } catch (e) {
          console.error('QMP: Failed to parse:', trimmed);
          continue;
        }

        if (msg.QMP) {
          // Greeting received, send qmp_capabilities to enter command mode
          this.socket.write(JSON.stringify({ execute: 'qmp_capabilities' }) + '\n');
          continue;
        }

        if (msg.return !== undefined && !negotiated) {
          // qmp_capabilities response - we're ready
          negotiated = true;
          this.ready = true;
          this.emit('ready');
          if (onReady) {
            onReady();
            onReady = null;
          }
          continue;
        }

        if (msg.event) {
          // Asynchronous event from QEMU
          this.emit('event', msg);
          this.emit(`event:${msg.event}`, msg.data, msg.timestamp);
          continue;
        }

        // Command response (return or error)
        if (msg.return !== undefined || msg.error) {
          const id = msg.id;
          if (id !== undefined && this.pendingCommands.has(id)) {
            const { resolve, reject } = this.pendingCommands.get(id);
            this.pendingCommands.delete(id);
            if (msg.error) {
              reject(new Error(`QMP error: ${msg.error.class} - ${msg.error.desc}`));
            } else {
              resolve(msg.return);
            }
          }
        }
      }
    });

    this.socket.on('error', (err) => {
      console.error('QMP: Socket error:', err.message);
      this.ready = false;
      this.emit('error', err);
      if (onError) {
        onError(err);
        onError = null;
      }
    });

    this.socket.on('close', () => {
      this.ready = false;
      // Reject all pending commands
      for (const [id, { reject }] of this.pendingCommands) {
        reject(new Error('QMP: Connection closed'));
      }
      this.pendingCommands.clear();
      this.emit('close');
    });
  }

  async execute(command, args = {}) {
    if (!this.ready) {
      throw new Error('QMP: Not connected');
    }

    const id = ++this.commandId;
    const msg = { execute: command, id };
    if (Object.keys(args).length > 0) {
      msg.arguments = args;
    }

    return new Promise((resolve, reject) => {
      this.pendingCommands.set(id, { resolve, reject });
      this.socket.write(JSON.stringify(msg) + '\n');

      // Command timeout
      setTimeout(() => {
        if (this.pendingCommands.has(id)) {
          this.pendingCommands.delete(id);
          reject(new Error(`QMP: Command '${command}' timed out`));
        }
      }, 10000);
    });
  }

  async shutdown() {
    return this.execute('system_powerdown');
  }

  async queryStatus() {
    return this.execute('query-status');
  }

  async quit() {
    return this.execute('quit');
  }

  disconnect() {
    this.ready = false;
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.pendingCommands.clear();
  }
}

module.exports = { QMPClient };
