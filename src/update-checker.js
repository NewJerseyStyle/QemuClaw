// src/update-checker.js - GitHub release checker, split-file downloader, extractor
const https = require('https');
const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');
const { exec } = require('child_process');

class UpdateChecker {
  constructor(vendorPath) {
    this.vendorPath = vendorPath;
    this.repoOwner = 'NewJerseyStyle';
    this.repoName = 'QemuClaw';
    this.apiBase = 'https://api.github.com';
  }

  /**
   * Get path to bundled 7-Zip executable.
   * Supports both 7za.exe (standalone) and 7z.exe (full, needs 7z.dll).
   */
  get7zPath() {
    if (process.platform !== 'win32') return null;

    // 1. Bundled in vendor/7zip/ (release build)
    const vendorDir = path.join(this.vendorPath, '7zip');
    for (const name of ['7za.exe', '7z.exe']) {
      const p = path.join(vendorDir, name);
      if (fs.existsSync(p)) return p;
    }

    // 2. System-installed 7-Zip
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const systemPath = path.join(programFiles, '7-Zip', '7z.exe');
    if (fs.existsSync(systemPath)) return systemPath;

    return null;
  }

  /**
   * List recent releases from the repo.
   */
  async listReleases() {
    const url = `${this.apiBase}/repos/${this.repoOwner}/${this.repoName}/releases?per_page=30`;

    return new Promise((resolve, reject) => {
      https.get(url, {
        headers: { 'User-Agent': 'QemuClaw-VM-Manager' }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve(JSON.parse(data));
          } else {
            reject(new Error(`GitHub API returned ${res.statusCode}`));
          }
        });
      }).on('error', reject);
    });
  }

  /**
   * Get the latest VM image release (tag starts with "vm-").
   * Does NOT use releases/latest since app releases share the same repo.
   */
  async getLatestVMRelease() {
    const releases = await this.listReleases();
    const vmRelease = releases.find(r => r.tag_name && r.tag_name.startsWith('vm-'));
    if (!vmRelease) {
      throw new Error('No VM image release found');
    }
    return vmRelease;
  }

  /**
   * Get all split archive assets (*.tar.gz.*) from a release
   */
  getSplitAssets(release) {
    return release.assets
      .filter(a => a.name.match(/\.tar\.gz\.[a-z]+$/))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get direct qcow2 asset from a release (when file is small enough to not split)
   */
  getQcow2Asset(release) {
    return release.assets.find(a => a.name.endsWith('.qcow2'));
  }

  /**
   * Download VM image from the latest vm-* release, then extract the qcow2.
   * Handles both split tar.gz files and direct qcow2 downloads.
   * onProgress receives { percent, downloaded, total, speed, status }
   */
  async downloadAndExtractVM(destDir, onProgress) {
    const release = await this.getLatestVMRelease();
    const splitAssets = this.getSplitAssets(release);
    const directQcow2 = this.getQcow2Asset(release);

    if (splitAssets.length === 0 && !directQcow2) {
      throw new Error('No VM image files found in the latest VM release');
    }

    await fs.ensureDir(destDir);
    const finalPath = path.join(destDir, 'openclaw-headless.qcow2');

    if (directQcow2) {
      // Direct qcow2 download (file was small enough, no splitting)
      if (onProgress) {
        onProgress({
          status: `Downloading ${directQcow2.name}`,
          percent: 0,
          downloaded: 0,
          total: directQcow2.size,
          speed: 0
        });
      }

      await this.downloadFile(directQcow2.browser_download_url, finalPath, onProgress);
      return { version: release.tag_name, imagePath: finalPath };
    }

    // Split file download path
    const tempDir = path.join(destDir, '_download_temp');
    await fs.ensureDir(tempDir);

    const totalSize = splitAssets.reduce((sum, a) => sum + a.size, 0);
    let totalDownloaded = 0;
    const startTime = Date.now();

    try {
      for (let i = 0; i < splitAssets.length; i++) {
        const asset = splitAssets[i];
        const destPath = path.join(tempDir, asset.name);

        if (onProgress) {
          onProgress({
            status: `Downloading ${asset.name} (${i + 1}/${splitAssets.length})`,
            percent: Math.round((totalDownloaded / totalSize) * 100),
            downloaded: totalDownloaded,
            total: totalSize,
            speed: 0
          });
        }

        await this.downloadFile(asset.browser_download_url, destPath, (progress) => {
          const currentTotal = totalDownloaded + progress.downloaded;
          const elapsed = (Date.now() - startTime) / 1000;
          if (onProgress) {
            onProgress({
              status: `Downloading ${asset.name} (${i + 1}/${splitAssets.length})`,
              percent: Math.round((currentTotal / totalSize) * 100),
              downloaded: currentTotal,
              total: totalSize,
              speed: elapsed > 0 ? currentTotal / elapsed / 1024 / 1024 : 0
            });
          }
        });

        totalDownloaded += asset.size;
      }

      if (onProgress) {
        onProgress({
          status: 'Extracting VM image...',
          percent: 100,
          downloaded: totalSize,
          total: totalSize,
          speed: 0
        });
      }

      await this.extractSplitArchive(tempDir, destDir);

      // Verify qcow2 exists after extraction
      const qcow2Files = (await fs.readdir(destDir)).filter(f => f.endsWith('.qcow2'));
      if (qcow2Files.length === 0) {
        throw new Error('No .qcow2 file found after extraction');
      }

      // Rename to standard name if needed
      const extractedQcow2 = qcow2Files[0];
      if (extractedQcow2 !== 'openclaw-headless.qcow2') {
        const srcPath = path.join(destDir, extractedQcow2);
        if (srcPath !== finalPath) {
          await fs.move(srcPath, finalPath, { overwrite: true });
        }
      }

      const version = release.tag_name;
      await fs.remove(tempDir);
      return { version, imagePath: finalPath };

    } catch (error) {
      await fs.remove(tempDir).catch(() => {});
      throw error;
    }
  }

  /**
   * Extract split tar.gz archive parts into destDir.
   * Windows: uses bundled 7za.exe (no system tar dependency).
   * Unix: uses system tar (always available).
   */
  extractSplitArchive(tempDir, destDir) {
    return new Promise((resolve, reject) => {
      let cmd;

      if (process.platform === 'win32') {
        const sevenZ = this.get7zPath();
        if (!sevenZ) {
          reject(new Error('Bundled 7-Zip not found in: ' + path.join(this.vendorPath, '7zip')));
          return;
        }
        // Step 1: Concatenate split parts into one file
        const combined = path.join(tempDir, 'combined.tar.gz');
        const catCmd = `cd /d "${tempDir}" && copy /b *.tar.gz.* combined.tar.gz`;
        // Step 2: extract .tar.gz -> .tar
        const step1 = `"${sevenZ}" x "${combined}" -o"${tempDir}" -y`;
        // Step 3: extract .tar -> contents
        const tarFile = path.join(tempDir, 'combined.tar');
        const step2 = `"${sevenZ}" x "${tarFile}" -o"${destDir}" -y`;
        cmd = `${catCmd} && ${step1} && ${step2}`;
      } else {
        // Unix: cat + tar (always available)
        cmd = `cat "${tempDir}"/*.tar.gz.* | tar xzf - -C "${destDir}"`;
      }

      exec(cmd, { maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Extraction failed: ${stderr || error.message}`));
        } else {
          resolve();
        }
      });
    });
  }

  async downloadFile(url, destPath, onProgress) {
    await fs.ensureDir(path.dirname(destPath));

    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      let downloadedBytes = 0;
      let totalBytes = 0;
      const startTime = Date.now();
      let lastUpdateTime = Date.now();

      https.get(url, {
        headers: { 'User-Agent': 'QemuClaw-VM-Manager' }
      }, (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          file.close();
          return this.downloadFile(res.headers.location, destPath, onProgress)
            .then(resolve)
            .catch(reject);
        }

        if (res.statusCode !== 200) {
          file.close();
          fs.unlink(destPath).catch(() => {});
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        totalBytes = parseInt(res.headers['content-length'], 10) || 0;

        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          file.write(chunk);

          const now = Date.now();
          if (now - lastUpdateTime > 500) {
            lastUpdateTime = now;
            if (onProgress) {
              const elapsed = (now - startTime) / 1000;
              onProgress({
                downloaded: downloadedBytes,
                total: totalBytes,
                percent: totalBytes > 0 ? Math.round((downloadedBytes / totalBytes) * 100) : 0,
                speed: elapsed > 0 ? downloadedBytes / elapsed / 1024 / 1024 : 0
              });
            }
          }
        });

        res.on('end', () => {
          file.end();
          if (onProgress) {
            onProgress({
              downloaded: downloadedBytes,
              total: downloadedBytes,
              percent: 100,
              speed: 0
            });
          }
          resolve(destPath);
        });
      }).on('error', (error) => {
        file.close();
        fs.unlink(destPath).catch(() => {});
        reject(error);
      });
    });
  }

  async verifyChecksum(filePath, expectedChecksum) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', data => hash.update(data));
      stream.on('end', () => {
        const checksum = hash.digest('hex');
        resolve(checksum === expectedChecksum);
      });
      stream.on('error', reject);
    });
  }
}

module.exports = { UpdateChecker };
