/** 独立运行：复制用户资料到当前手动登录的 X 账号。 */
import { chromium, type Page } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { originalAvatarUrl, parseHandle } from './core.ts';
import { chooseFirstSuggestion } from './suggestions.ts';

const [targetArg, profileArg, ...extra] = process.argv.slice(2);
if (!targetArg || !profileArg || extra.length) {
  console.error('用法：npm run clone_user -- <目标用户名> <子账号资料名>');
  process.exit(1);
}
let target: string, profileName: string;
try { target = parseHandle(targetArg); profileName = parseHandle(profileArg); }
catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }
if (process.platform !== 'darwin') { console.error('此脚本目前支持 macOS Google Chrome'); process.exit(1); }
const profile = resolve('.profile-copy', profileName.toLowerCase());
const executable = process.env.PROFILE_COPY_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const input = createInterface({ input: stdin, output: stdout });
let context;
async function pause(prompt: string) { await input.question(prompt); }
async function currentHandle(page: Page): Promise<string> {
  const href = await page.getByTestId('AppTabBar_Profile_Link').getAttribute('href', { timeout: 15000 });
  if (!href || !/^\/[A-Za-z0-9_]{1,15}$/.test(href)) throw new Error('未检测到已登录的 X 账号');
  return href.slice(1);
}
async function firstVisible(page: Page, selectors: string[]) {
  await page.locator(selectors.map(selector => `${selector}:visible`).join(', ')).first().waitFor({ state: 'visible', timeout: 15000 });
  for (const selector of selectors) {
    const candidate = page.locator(selector).first();
    if (await candidate.isVisible().catch(() => false)) return candidate;
  }
  throw new Error(`找不到页面控件：${selectors.join(' / ')}；X 页面可能已改版`);
}
try {
  await mkdir(profile, { recursive: true, mode: 0o700 });
  context = await chromium.launchPersistentContext(profile, { executablePath: executable, headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--use-mock-keychain', '--password-store=basic'] });
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  let owner = await currentHandle(page).catch(() => null);
  if (!owner) {
    await pause('请在浏览器登录要修改的子账号，完成后回到终端按 Enter：');
    owner = await currentHandle(page);
  }
  if (owner.toLowerCase() === target.toLowerCase()) throw new Error('当前登录账号就是目标账号，已停止');
  await page.goto(`https://x.com/${target}`, { waitUntil: 'domcontentloaded' });
  const heading = page.getByTestId('UserName').first();
  await heading.waitFor({ state: 'visible', timeout: 20000 });
  const lines = (await heading.innerText()).split('\n').map(x => x.trim()).filter(Boolean);
  if (!lines.some(line => line.toLowerCase() === `@${target.toLowerCase()}`)) throw new Error('无法确认读取的是目标账号资料');
  const name = lines[0];
  if (!name || name.startsWith('@')) throw new Error('无法准确读取目标显示名称');
  const descriptions = page.getByTestId('UserDescription');
  const description = await descriptions.count() ? await descriptions.first().innerText() : '';
  const avatar = page.locator('main img[src*="pbs.twimg.com/profile_images/"]').first();
  await avatar.waitFor({ state: 'visible', timeout: 15000 });
  const avatarSrc = await avatar.getAttribute('src');
  if (!avatarSrc) throw new Error('无法读取目标头像');
  const avatarUrl = originalAvatarUrl(avatarSrc);
  const response = await context.request.get(avatarUrl, { maxRedirects: 0, timeout: 20000 });
  if (!response.ok()) throw new Error(`读取头像失败，HTTP ${response.status()}`);
  const type = (response.headers()['content-type'] || '').split(';')[0].toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error(`不支持的头像格式 ${type}`);
  const image = await response.body();
  if (!image.length || image.length > 10 * 1024 * 1024) throw new Error('头像为空或超过 10 MB');
  console.log(`\n目标：@${target}\n当前登录的子账号：@${owner}\n显示名称：${name}\n简介：${description || '（空）'}`);
  console.log('正在自动复制头像、显示名称和简介。');
  await page.goto(`https://x.com/${owner}`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('editProfileButton').click({ timeout: 15000 });
  const dialog = page.getByRole('dialog').last();
  await dialog.locator('input[name="displayName"]').fill(name);
  await dialog.locator('textarea[name="description"]').fill(description);
  const upload = dialog.locator('input[type="file"]').first();
  await upload.setInputFiles({ name: `avatar.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`, mimeType: type, buffer: image });
  const crop = page.getByRole('dialog').last();
  const applyCrop = crop.getByRole('button', { name: /^(apply|应用|套用)$/i });
  if (await applyCrop.isVisible({ timeout: 5000 }).catch(() => false)) {
    await applyCrop.click();
    await applyCrop.waitFor({ state: 'hidden', timeout: 15000 });
  }
  const save = page.getByTestId('Profile_Save_Button');
  await save.click({ timeout: 15000 });
  await dialog.waitFor({ state: 'hidden', timeout: 20000 });
  console.log('资料保存请求已提交，正在检查结果……');
  await page.goto(`https://x.com/${owner}`, { waitUntil: 'domcontentloaded' });
  const ownLines = (await page.getByTestId('UserName').first().innerText({ timeout: 15000 })).split('\n').map(x => x.trim()).filter(Boolean);
  const ownBio = await page.getByTestId('UserDescription').count() ? await page.getByTestId('UserDescription').first().innerText() : '';
  if (ownLines[0] !== name || ownBio !== description) throw new Error('名称或简介未通过保存后核对，请在浏览器检查；头像也需人工确认');
  console.log('名称和简介已核对；头像已提交，请在浏览器确认显示。');
  await page.goto('https://x.com/settings/screen_name', { waitUntil: 'domcontentloaded' });
  const field = await firstVisible(page, ['input[autocomplete="username"]', 'input[name="screen_name"]', 'input[name="username"]', 'input[data-testid="ocfEnterTextTextInput"]']);
  // 输入被占用的目标用户名，让 X 显示自己的用户名建议。
  await field.fill(target);
  const suggestion = await chooseFirstSuggestion(page, target, owner);
  const selected = (await field.inputValue()).replace(/^@/, '');
  if (selected.toLowerCase() !== suggestion.toLowerCase()) throw new Error(`无法确认已选中建议 @${suggestion}，未保存用户名`);
  const saveUsername = await firstVisible(page, ['[data-testid="settingsDetailSave"]', '[data-testid="save"]']);
  for (let attempt = 0; attempt < 20 && !await saveUsername.isEnabled(); attempt++) await page.waitForTimeout(500);
  if (!await saveUsername.isEnabled()) throw new Error('用户名保存按钮不可用，未提交修改');
  console.log(`正在保存 X 推荐的第一个用户名：@${suggestion}`);
  await saveUsername.click();
  await page.waitForTimeout(2500);
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  const actual = await currentHandle(page);
  if (actual.toLowerCase() !== suggestion.toLowerCase()) throw new Error(`无法确认用户名是否修改成功，当前显示 @${actual}；请人工检查`);
  console.log(`用户名已修改并核对：@${actual}`);

} catch (error) {
  console.error(`停止：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
} finally {
  input.close();
  await context?.close().catch(() => {});
}
