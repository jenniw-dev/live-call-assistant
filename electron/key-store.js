const fs = require('fs');
const path = require('path');

class KeyStore {
  constructor({ safeStorage, userDataPath }) {
    this.safeStorage = safeStorage;
    this.directory = path.join(userDataPath, 'credentials');
    this.file = path.join(this.directory, 'deepseek-key.bin');
  }

  has() {
    return fs.existsSync(this.file) && fs.statSync(this.file).size > 0;
  }

  save(value) {
    const key = String(value || '').trim();
    if (!key) throw new Error('The DeepSeek key can’t be empty');
    if (!this.safeStorage.isEncryptionAvailable()) {
      throw new Error('This Mac can’t store the key securely right now');
    }

    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    fs.writeFileSync(this.file, this.safeStorage.encryptString(key), { mode: 0o600 });
    fs.chmodSync(this.file, 0o600);
  }

  clear() {
    if (fs.existsSync(this.file)) fs.unlinkSync(this.file);
  }

  readForBackend() {
    try {
      if (!this.safeStorage.isEncryptionAvailable()) {
        throw new Error('encryption unavailable');
      }
      if (!this.has()) return '';
      return this.safeStorage.decryptString(fs.readFileSync(this.file));
    } catch {
      throw new Error('Couldn’t read the key securely');
    }
  }
}

module.exports = { KeyStore };
