const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { EventEmitter } = require('node:events');
const { mediaHelperEnvironment } = require('../../src/helpers/mediaHelperEnvironment');

test('the actual URL helper retains Node mode, filters Host material and cancels its process tree', async () => {
  const source = fs.readFileSync(require.resolve('../../src/helpers/urlAudioDownloader'), 'utf8');
  const parsed = ts.createSourceFile('urlAudioDownloader.js', source, ts.ScriptTarget.Latest, true);
  const names = new Set(['jsRuntimeSpawnConfig', 'killYtDlpTree', 'runYtDlp']);
  const functions = parsed.statements.filter(node => ts.isFunctionDeclaration(node) && names.has(node.name.text)).map(node => node.getText(parsed)).join('\n');
  const calls = [];
  let child;
  const context = vm.createContext({ mediaHelperEnvironment, setTimeout, clearTimeout,
    process: { platform: 'win32', execPath: 'unit-electron.exe', kill() {} },
    childProcess: { spawn(command, args, options) {
      calls.push({ command, args, options });
      const instance = new EventEmitter(); instance.stdout = new EventEmitter(); instance.stderr = new EventEmitter(); instance.pid = 100;
      instance.kill = () => true;
      if (command !== 'taskkill') child = instance;
      return instance;
    } },
  });
  vm.runInContext(functions, context);
  const controller = new AbortController();
  process.env.NIMI_TEST_HOST_MARKER = 'non-sensitive-marker';
  try {
    const pending = context.runYtDlp('unit-yt-dlp', ['input'], controller.signal, 0);
    assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(Object.hasOwn(calls[0].options.env, 'NIMI_TEST_HOST_MARKER'), false);
    controller.abort();
    assert.equal(calls[1].command, 'taskkill');
    assert.ok(calls[1].args.includes('/T'));
    assert.ok(calls[1].args.includes('/F'));
    assert.ok(Object.keys(calls[1].options.env).every(key => !key.startsWith('NIMI_')));
    child.emit('close', null);
    await assert.rejects(pending, error => error.code === 'DOWNLOAD_CANCELLED');
  } finally { delete process.env.NIMI_TEST_HOST_MARKER; }
});

test('the actual yt-dlp self-update branch filters Host launch material', async () => {
  const source = fs.readFileSync(require.resolve('../../src/helpers/urlAudioDownloader'), 'utf8');
  const parsed = ts.createSourceFile('urlAudioDownloader.js', source, ts.ScriptTarget.Latest, true);
  const owner = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name.text === 'maybeUpdateYtDlp');
  let child;
  let options;
  const context = vm.createContext({
    mediaHelperEnvironment, setTimeout, clearTimeout, Date,
    path: require('node:path'), YT_DLP_CACHE_DIR: 'unit-cache', UPDATE_TIMEOUT_MS: 1000,
    YT_DLP_UPDATE_THROTTLE_MS: 1000, ytDlpUpdateInFlight: false, ytDlpBusyCount: 0,
    seedYtDlpFromBundle() {}, getCacheYtDlpPath: () => 'unit-cache/yt-dlp.exe',
    cacheChecksumValid: () => true, recordCacheChecksum() {},
    fs: { existsSync: () => true, mkdirSync() {}, writeFileSync() {} },
    debugLogger: { warn() {} },
    childProcess: { spawn(command, args, inputOptions) {
      assert.equal(command, 'unit-cache/yt-dlp.exe');
      assert.deepEqual(Array.from(args), ['--update-to', 'nightly']);
      options = inputOptions;
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
      return child;
    } },
  });
  vm.runInContext(owner.getText(parsed), context);
  process.env.NIMI_TEST_HOST_MARKER = 'non-sensitive-marker';
  process.env.NODE_OPTIONS = '--unit-marker';
  try {
    const pending = context.maybeUpdateYtDlp({ force: true });
    assert.ok(Object.keys(options.env).every(key => !key.startsWith('NIMI_')));
    assert.equal(Object.hasOwn(options.env, 'NODE_OPTIONS'), false);
    assert.equal(Object.hasOwn(options.env, 'ELECTRON_RUN_AS_NODE'), false);
    child.emit('close', 0);
    await pending;
  } finally { delete process.env.NIMI_TEST_HOST_MARKER; delete process.env.NODE_OPTIONS; }
});
