import type { Page } from 'playwright';

/** 检查 X 站点权限；缺失时让用户在扩展页面主动授权，并等待 Chrome 的确认。 */
export async function ensureCommentCratePermission(page: Page, options: { headless?: boolean; timeoutMs?: number; label?: string } = {}): Promise<void> {
  const granted = await page.evaluate(async () => {
    const api = (globalThis as any).chrome, crate = (globalThis as any).CommentCrate;
    const platform = crate?.platformsMeta?.PLATFORMS?.find((p: any) => p.id === 'x');
    if (!platform || !crate?.permissions?.create) throw new Error('CommentCrate 扩展接口不可用');
    return await crate.permissions.create(api).has(platform);
  });
  if (granted) return;
  if (options.headless) throw new Error('CommentCrate 缺少 X 站点权限；请关闭 X_HEADLESS，在浏览器窗口中完成授权');
  await page.evaluate((label) => {
    const crate = (globalThis as any).CommentCrate;
    const platform = crate.platformsMeta.PLATFORMS.find((p: any) => p.id === 'x');
    const container = document.createElement('div');
    Object.assign(container.style, { position: 'fixed', inset: '0', zIndex: '2147483647', background: '#fff', padding: '24px', color: '#111', font: '16px/1.6 sans-serif' });
    const title = document.createElement('h2'); title.textContent = `${label ? `${label}：` : ''}授予 CommentCrate 访问 X 的权限`;
    const info = document.createElement('p'); info.textContent = '点击下方按钮，然后在 Chrome 的权限提示中选择允许。程序会等待授权，完成后自动继续。';
    const button = document.createElement('button'); button.id = 'xbot-request-permission'; button.textContent = '授权访问 X';
    Object.assign(button.style, { padding: '12px 20px', fontSize: '16px', cursor: 'pointer' });
    const message = document.createElement('p'); message.id = 'xbot-permission-result';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const permissions = crate.permissions.create((globalThis as any).chrome);
        if (!await permissions.request(platform)) { message.textContent = '未获得授权，请重新点击并在 Chrome 提示中选择允许。'; button.disabled = false; return; }
        await permissions.register(platform);
        message.textContent = '授权完成，程序将自动继续。';
        message.setAttribute('data-state', 'granted');
      } catch { message.textContent = '授权或注册失败，请重新点击。'; button.disabled = false; }
    });
    container.append(title, info, button, message); document.body.append(container);
  }, options.label || '');
  await page.bringToFront();
  console.log('请在浏览器的 CommentCrate 授权页点击“授权访问 X”，并在 Chrome 提示中选择允许；完成后自动继续。');
  try {
    await page.waitForFunction(() => document.getElementById('xbot-permission-result')?.getAttribute('data-state') === 'granted',
      undefined, { timeout: options.timeoutMs ?? 10 * 60_000, polling: 1000 });
    const confirmed = await page.evaluate(async () => {
      const crate = (globalThis as any).CommentCrate, api = (globalThis as any).chrome;
      const platform = crate?.platformsMeta?.PLATFORMS?.find((p: any) => p.id === 'x');
      return !!platform && await crate.permissions.create(api).has(platform);
    });
    if (!confirmed) throw new Error('Chrome 未确认站点权限');
  } catch (error) { throw new Error('等待 CommentCrate 的 X 站点授权未完成；请重启任务后在浏览器窗口确认允许', { cause: error }); }
}
