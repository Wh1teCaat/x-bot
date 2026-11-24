import '../../src/runtime-config.ts';
import { chromium } from 'playwright';
import { cp, mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { serialize } from 'node:v8';
import { EXPORTER24_EXTENSION_ID } from './exporter24.ts';
import { prepareInstrumentedExporter } from './exporter-instrumentation.ts';
import { readExporterHistory } from './bitbrowser-history-transfer.ts';

const account = process.argv[2];
if (!/^\d{1,19}$/.test(account || '')) throw new Error('账号 ID 无效');
const source = resolve('.data/account-data', account, 'exporter-follow');
const target = resolve('.data/account-data', account, 'bit-exporter-history.bin');
const temp = await mkdtemp(join(tmpdir(), 'xbot-bit-import-'));
let browser;
try {
  // 不覆盖已有账号快照；重试时保持最近一次安全保存的结果。
  try { await readFile(target); console.log('账号已有 exporter 历史快照，跳过旧版导入。'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const profile = join(temp, 'profile'), dest = join(profile, 'Default/IndexedDB');
    await mkdir(dest, { recursive: true, mode: 0o700 });
    for (const ext of ['leveldb', 'blob']) {
      const name = `chrome-extension_${EXPORTER24_EXTENSION_ID}_0.indexeddb.${ext}`;
      try { await cp(join(source, name), join(dest, name), { recursive: true }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || ext === 'leveldb') throw e; }
    }
    const extension = await prepareInstrumentedExporter(resolve('.data/extension-packages', EXPORTER24_EXTENSION_ID));
    const executable = chromium.executablePath().replace(join(homedir(), 'Library/Caches/ms-playwright'), resolve('.data/playwright-browsers'));
    browser = await chromium.launchPersistentContext(profile, { executablePath: executable, headless: true, chromiumSandbox: true, ignoreDefaultArgs: ['--disable-extensions'], args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
    const page = await browser.newPage(); await page.goto(`chrome-extension://${EXPORTER24_EXTENSION_ID}/manifest.json`);
    const history = await readExporterHistory(page);
    const tmp = `${target}.${process.pid}.tmp`;
    await writeFile(tmp, serialize(history), { mode: 0o600 }); await rename(tmp, target);
    console.log('旧版 exporter 历史已保存为账号独立快照。');
  }
} finally { await browser?.close().catch(() => {}); await rm(temp, { recursive: true, force: true }); }
