import { createHash } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** 授权证明与 Chrome 配置绑定；配置变化或缺失时必须重新检查。 */
async function fingerprint(slot: number, root: string): Promise<string> {
  const base = join(root, 'browser-permission-slots', String(slot));
  const hash = createHash('sha256');
  for (const name of ['Local State', 'Default/Preferences', 'Default/Secure Preferences']) {
    hash.update(name); hash.update(await readFile(join(base, name)));
  }
  return hash.digest('hex');
}
export async function slotAuthorizationReady(slot: number, root = resolve('.data')): Promise<boolean> {
  if (!Number.isInteger(slot) || slot < 1 || slot > 5) return false;
  try {
    const saved = await readFile(join(root, 'browser-permission-slots', String(slot), '.xbot-authorized'), 'utf8');
    return saved === await fingerprint(slot, root);
  } catch { return false; }
}
export async function allSlotsAuthorized(root = resolve('.data')): Promise<boolean> {
  return (await Promise.all([1, 2, 3, 4, 5].map(slot => slotAuthorizationReady(slot, root)))).every(Boolean);
}
/** 只能在 Chrome 已确认授权并成功关闭后调用。 */
export async function markSlotAuthorized(slot: number, root = resolve('.data')): Promise<void> {
  const base = join(root, 'browser-permission-slots', String(slot));
  const marker = join(base, '.xbot-authorized'), temp = `${marker}.${process.pid}.tmp`;
  await writeFile(temp, await fingerprint(slot, root), { mode: 0o600 });
  await rename(temp, marker);
}
