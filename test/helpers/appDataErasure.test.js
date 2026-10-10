const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('explicit import erasure stays in this fork and preserves original and upstream data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nimi-erase-owned-'));
  const original = Module._load;
  const ownerPath = require.resolve('../../src/helpers/appData'); delete require.cache[ownerPath];
  Module._load = function(request, parent, isMain) {
    if (request === 'electron') return { app: { getPath: () => root } };
    return original.call(this, request, parent, isMain);
  };
  let owner;
  try { owner = require(ownerPath); } finally { Module._load = original; }
  const input = path.join(root, 'user-source.wav');
  const upstream = path.join(root, 'OpenWhispr', 'recording.wav');
  fs.writeFileSync(input, 'user source'); fs.mkdirSync(path.dirname(upstream)); fs.writeFileSync(upstream, 'upstream');
  const imports = path.join(owner.getAppDataDirectory(), 'imports', 'fixture'); fs.mkdirSync(imports, { recursive: true });
  fs.writeFileSync(path.join(imports, 'source.wav'), 'owned copy');
  const index = path.join(owner.getAppDataDirectory(), 'qdrant-data-dev');
  fs.mkdirSync(index); fs.writeFileSync(path.join(index, 'derived-index'), 'owned vectors');
  try {
    owner.eraseAppOwnedImports();
    owner.eraseAppOwnedSearchIndexes();
    assert.equal(fs.existsSync(imports), false);
    assert.equal(fs.existsSync(index), false);
    assert.equal(fs.readFileSync(input, 'utf8'), 'user source');
    assert.equal(fs.readFileSync(upstream, 'utf8'), 'upstream');
    const handler = fs.readFileSync(require.resolve('../../src/helpers/ipcHandlers'), 'utf8');
    const erasure = handler.slice(handler.indexOf('ipcMain.handle("cleanup-app"'), handler.indexOf('ipcMain.handle("cleanup-app"') + 16000);
    assert.match(erasure, /eraseAppOwnedImports/);
    assert.doesNotMatch(erasure, /homeCacheRoot|deleteAllParakeetModels|\.cache.*openwhispr/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
