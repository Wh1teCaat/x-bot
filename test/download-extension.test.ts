import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyCrx3, extractExtensionZip } from '../scripts/browser/download-extension.ts';
import { extensionIdFromKey } from '../scripts/browser/extension-packages.ts';

function varint(n: number): Buffer { const a: number[] = []; do { let b = n % 128; n = Math.floor(n / 128); if (n) b |= 128; a.push(b); } while (n); return Buffer.from(a); }
function field(n: number, data: Buffer) { return Buffer.concat([varint(n * 8 + 2), varint(data.length), data]); }
function zipFile(name: string, content: string) {
  const n = Buffer.from(name), data = Buffer.from(content), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(n.length, 26); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(local.length + n.length + data.length, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}
function crx(zip: Buffer) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = publicKey.export({ type: 'spki', format: 'der' });
  const signed = field(1, Buffer.from('header')), len = Buffer.alloc(4); len.writeUInt32LE(signed.length);
  const signature = sign('sha256', Buffer.concat([Buffer.from('CRX3 SignedData\0'), len, signed, zip]), privateKey);
  const header = Buffer.concat([field(2, Buffer.concat([field(1, key), field(2, signature)])), field(10000, signed)]);
  const prefix = Buffer.alloc(12); prefix.write('Cr24'); prefix.writeUInt32LE(3, 4); prefix.writeUInt32LE(header.length, 8);
  return { data: Buffer.concat([prefix, header, zip]), id: extensionIdFromKey(key.toString('base64'))! };
}

test('validates signed extension identity, rejects tampering and extracts safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xbot-crx-'));
  try {
    const archive = crx(zipFile('manifest.json', '{}'));
    const verified = verifyCrx3(archive.data, archive.id);
    await extractExtensionZip(verified.zip, root);
    assert.equal(await readFile(join(root, 'manifest.json'), 'utf8'), '{}');
    const altered = Buffer.from(archive.data); altered[altered.length - 1] ^= 1;
    assert.throws(() => verifyCrx3(altered, archive.id), /签名/);
    assert.throws(() => verifyCrx3(archive.data, 'a'.repeat(32)), /签名/);
    await assert.rejects(extractExtensionZip(zipFile('../escape', 'x'), root), /不安全/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
