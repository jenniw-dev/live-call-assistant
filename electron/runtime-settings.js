const fs = require('fs');
const path = require('path');

class RuntimeSettings {
  constructor({ userDataPath }) {
    if (typeof userDataPath !== 'string' || !path.isAbsolute(userDataPath)) {
      throw new TypeError('userDataPath must be an absolute path');
    }
    this.directory = userDataPath;
    this.file = path.join(userDataPath, 'runtime-settings.json');
  }

  getThinking() {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')).thinkingEnabled === true;
    } catch {
      return false;
    }
  }

  setThinking(enabled) {
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.directory, 0o700);
    fs.writeFileSync(
      this.file,
      JSON.stringify({ thinkingEnabled: Boolean(enabled) }),
      { mode: 0o600 },
    );
    fs.chmodSync(this.file, 0o600);
  }
}

module.exports = { RuntimeSettings };
