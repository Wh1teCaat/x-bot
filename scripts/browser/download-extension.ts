/** 从 Chrome 官方更新服务下载并校验 CRX3 后，解压到独立目录。 */
import { request } from 'playwright';
import { createPublicKey, verify } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { extensionIdFromKey } from './extension-packages.ts';

type Field = { number: number; data: Buffer };
function fields(input: Buffer): Field[] {
  let i = 0;
  const readVarint = () => {
    let result = 0, shift = 0;
    for (let n = 0; n < 7; n++) {
      if (i >= input.length) throw new Error('CRX 头部不完整');
      const b = input[i++]; result += (b & 127) * 2 ** shift;
      if (!(b & 128)) return result;
      shift += 7;
    }
    throw new Error('CRX 头部无效');
  };
  const result: Field[] = [];
  while (i < input.length) {
    const tag = readVarint();
    if ((tag & 7) !== 2) throw new Error('CRX 头部字段不支持');
    const length = readVarint();
    if (length > input.length - i) throw new Error('CRX 头部长度无效');
    result.push({ number: Math.floor(tag / 8), data: input.subarray(i, i + length) }); i += length;
  }
  return result;
}

export function verifyCrx3(buffer: Buffer, id: string): { zip: Buffer; key: string } {
  if (buffer.length < 12 || buffer.toString('ascii', 0, 4) !== 'Cr24' || buffer.readUInt32LE(4) !== 3) throw new Error('插件包不是 CRX3 格式');
  const length = buffer.readUInt32LE(8);
  if (length > buffer.length - 12) throw new Error('插件包头部不完整');
  const header = fields(buffer.subarray(12, 12 + length));
  const signed = header.find(field => field.number === 10000)?.data;
  if (!signed) throw new Error('插件包缺少签名数据');
  const zip = buffer.subarray(12 + length), size = Buffer.alloc(4); size.writeUInt32LE(signed.length);
  const signedData = Buffer.concat([Buffer.from('CRX3 SignedData\0'), size, signed, zip]);
  for (const entry of header.filter(field => field.number === 2 || field.number === 3)) {
    const proof = fields(entry.data), publicKey = proof.find(f => f.number === 1)?.data, signature = proof.find(f => f.number === 2)?.data;
    if (!publicKey || !signature || extensionIdFromKey(publicKey.toString('base64')) !== id) continue;
    if (verify('sha256', signedData, createPublicKey({ key: publicKey, format: 'der', type: 'spki' }), signature)) return { zip, key: publicKey.toString('base64') };
  }
  throw new Error(`插件 ${id} 的签名或身份校验失败`);
}

/** 只接受普通文件和目录，拒绝路径穿越、符号链接、加密与压缩炸弹。 */
export async function extractExtensionZip(zip: Buffer, destination: string): Promise<void> {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65557); i--) if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0 || zip.readUInt16LE(end + 4) || zip.readUInt16LE(end + 6)) throw new Error('插件压缩包目录无效');
  const count = zip.readUInt16LE(end + 10), dirSize = zip.readUInt32LE(end + 12), offset = zip.readUInt32LE(end + 16);
  if (count > 20000 || offset + dirSize > end) throw new Error('插件压缩包过大或目录无效');
  let pos = offset, total = 0;
  const root = resolve(destination);
  for (let i = 0; i < count; i++) {
    if (pos + 46 > zip.length || zip.readUInt32LE(pos) !== 0x02014b50) throw new Error('插件压缩目录无效');
    const flags = zip.readUInt16LE(pos + 8), method = zip.readUInt16LE(pos + 10), compressed = zip.readUInt32LE(pos + 20), uncompressed = zip.readUInt32LE(pos + 24);
    const n = zip.readUInt16LE(pos + 28), extra = zip.readUInt16LE(pos + 30), comment = zip.readUInt16LE(pos + 32), attrs = zip.readUInt32LE(pos + 38), local = zip.readUInt32LE(pos + 42);
    if (pos + 46 + n + extra + comment > offset + dirSize || flags & 1 || ![0, 8].includes(method)) throw new Error('插件压缩文件不支持');
    const name = zip.subarray(pos + 46, pos + 46 + n).toString('utf8');
    pos += 46 + n + extra + comment;
    const mode = attrs >>> 16;
    if ((mode & 0xf000) === 0xa000 || name.includes('\\') || name.includes('\0') || name.startsWith('/') || name.split('/').some(part => part === '..')) throw new Error('插件包含不安全路径');
    const target = resolve(root, name);
    if (!target.startsWith(root + sep)) throw new Error('插件包含不安全路径');
    if (name.endsWith('/')) { await mkdir(target, { recursive: true }); continue; }
    total += uncompressed;
    if (total > 256 * 1024 * 1024 || uncompressed > 64 * 1024 * 1024 || local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) throw new Error('插件压缩文件过大或无效');
    const dataStart = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    if (dataStart + compressed > offset) throw new Error('插件压缩数据无效');
    const bytes = zip.subarray(dataStart, dataStart + compressed);
    const data = method === 8 ? inflateRawSync(bytes, { maxOutputLength: uncompressed + 1 }) : bytes;
    if (data.length !== uncompressed) throw new Error('插件文件长度无效');
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, data);
  }
}

export async function downloadExtension(id: string, root = resolve('.data', 'extension-packages')): Promise<string> {
  if (!/^[a-p]{32}$/.test(id)) throw new Error('扩展 ID 无效');
  const destination = join(root, id);
  if (existsSync(join(destination, 'manifest.json'))) {
    const manifest = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
    if (extensionIdFromKey(manifest.key) === id) return destination;
    throw new Error(`本地扩展 ${id} 身份校验失败`);
  }
  const client = await request.newContext({ timeout: 120000 });
  const temporary = join(root, `.install-${id}-${randomUUID()}`);
  try {
    const url = new URL('https://clients2.google.com/service/update2/crx');
    url.searchParams.set('response', 'redirect'); url.searchParams.set('prodversion', '131.0.6778.0'); url.searchParams.set('acceptformat', 'crx3');
    url.searchParams.set('x', `id=${id}&installsource=ondemand&uc`);
    const response = await client.get(url.toString());
    if (response.status() !== 200) throw new Error(`扩展 ${id} 下载失败（HTTP ${response.status()}，应用商店未提供安装包）`);
    const body = await response.body();
    if (body.length > 100 * 1024 * 1024) throw new Error('扩展下载包过大');
    const { zip, key } = verifyCrx3(body, id);
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    await extractExtensionZip(zip, temporary);
    const manifestPath = join(temporary, 'manifest.json');
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (manifest.key && extensionIdFromKey(manifest.key) !== id) throw new Error('扩展 manifest 身份与签名不一致');
    manifest.key = key;
    await writeFile(manifestPath, JSON.stringify(manifest));
    try { await rename(temporary, destination); }
    catch (error) { if (!existsSync(destination)) throw error; }
    const installed = JSON.parse(await readFile(join(destination, 'manifest.json'), 'utf8'));
    if (extensionIdFromKey(installed.key) !== id) throw new Error(`本地扩展 ${id} 身份校验失败`);
    return destination;
  } finally { await client.dispose(); await rm(temporary, { recursive: true, force: true }); }
}
