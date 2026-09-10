const fs = require('fs');
const path = require('path');

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

// A file that is there but cannot be read is not a reason to refuse to start.
// It happens for a good reason: a deployment that bind-mounts the working tree
// into the container exposes the operator's .env to a process running as
// somebody else, and that file is deliberately kept at mode 600. Everything in
// it reached the process through the environment already, which is what the
// compose file is for, so skipping it costs nothing and crash-looping over it
// costs the server.
function applyEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.warn(`Skipping ${filePath}: ${err.code || err.message}`);
    return false;
  }
  const lines = contents.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = stripQuotes(rawValue.trim());
  }
  return true;
}

function loadLocalEnv(baseDir) {
  const root = baseDir || process.cwd();
  applyEnvFile(path.join(root, '.env'));
  applyEnvFile(path.join(root, '.env.local'));
}

module.exports = {
  loadLocalEnv,
};
