import '../../src/runtime-config.ts';
import { monitorProcess } from '../../src/runtime-monitor.ts';
/** 独立运行：复制用户资料到当前手动登录的 X 账号。 */
import { chromium, type Page, type Locator } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { originalAvatarUrl, originalBannerUrl, parseHandle } from './core.ts';
import { chooseFirstSuggestion } from './suggestions.ts';
import { actionDelay } from '../browser/action-delay.ts';
import { loadCookieJar } from '../browser/cookies.ts';
import { fingerprintFor } from '../browser/fingerprint.ts';
import { AccountStore } from '../../src/account-store.ts';

const telemetry = monitorProcess(process.env.X_RUNTIME_ACCOUNT_ID, 'clone');
telemetry.stage('复制目标账号资料');
const rawArgs = process.argv.slice(2);
let cookiePath: string | undefined;
let dryRun = false;
let updateOnly = false;
const positional: string[] = [];
for (let index = 0; index < rawArgs.length; index++) {
  const arg = rawArgs[index];
  if (arg === '--dry-run') { dryRun = true; continue; }
  if (arg === '--update') { updateOnly = true; continue; }
  if (arg === '--cookie') {
    cookiePath = rawArgs[++index];
    if (!cookiePath) { console.error('--cookie 缺少文件路径'); process.exit(1); }
    continue;
  }
  positional.push(arg);
}
const [targetArg, profileArg, ...extra] = positional;
if (!targetArg || !profileArg || extra.length) {
  console.error('用法：npm run clone_user -- <目标用户名> <子账号资料名> [--cookie <文件>] [--dry-run] [--update]');
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
let accountStore;
async function pause(prompt: string) { await input.question(prompt); }
async function currentHandle(page: Page): Promise<string> {
  const href = await page.getByTestId('AppTabBar_Profile_Link').getAttribute('href', { timeout: 15000 });
  if (!href || !/^\/[A-Za-z0-9_]{1,15}$/.test(href)) throw new Error('未检测到已登录的 X 账号');
  return href.slice(1);
}
/** 读取真实简介：取 UserDescription 的第一个 span，剔除职业账号的 Creator 链接与分类，并限制在 160 字内。 */
/** 读取完整简介；X 显示翻译时先切回原文，避免只复制到翻译后的第一段。 */
async function readBio(page: Page): Promise<string> {
  const showOriginal = page.getByText(/Show original/i).first();
  if (await showOriginal.isVisible().catch(() => false)) {
    await showOriginal.click().catch(() => {});
    await page.waitForTimeout(500);
  }
  return page.evaluate(() => {
    const container = document.querySelector('[data-testid="UserDescription"]');
    if (!container) return '';
    let bio = (container as HTMLElement).innerText || container.textContent || '';
    bio = bio.replace(/^\s*Translated from .*$/gim, '').replace(/Show original/gi, '');
    // 职业账号会把 “Creator @xxx” 链接追加在简介后，这里去掉末尾的 Creator 标签。
    if (container.querySelector('a[href^="/"]')) bio = bio.replace(/\s*Creator\s*$/i, '');
    return bio.replace(/\s+/g, ' ').trim().slice(0, 160);
  });
}
/** 空白归一化，用于保存后的核对（换行可能被 X 转成空格）。 */
const normalizeText = (s: string) => s.replace(/\s+/g, ' ').trim();
/** 拟人化输入：先聚焦清空，再按词语逐字输入，词间随机停顿。 */
async function typeHuman(page: Page, locator: Locator, text: string) {
  await locator.click();
  await locator.fill('');
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  for (let i = 0; i < words.length; i++) {
    await locator.pressSequentially(words[i], { delay: 40 + Math.floor(Math.random() * 120) });
    if (i < words.length - 1) {
      await locator.pressSequentially(' ', { delay: 60 });
      await page.waitForTimeout(150 + Math.floor(Math.random() * 650));
    }
  }
}
/** 点击图片裁剪确认按钮；横幅可能不弹裁剪框，因此允许非必需。 */
async function applyCrop(page: Page, label: string, required = true): Promise<boolean> {
  const buttons = page.getByRole('button', { name: /^(apply|应用|套用)$/i });
  for (let attempt = 0; attempt < 20; attempt++) {
    for (let index = await buttons.count() - 1; index >= 0; index--) {
      if (await buttons.nth(index).isVisible().catch(() => false)) {
        await buttons.nth(index).click();
        return true;
      }
    }
    await page.waitForTimeout(500);
  }
  if (required) throw new Error(`未找到${label}裁剪确认按钮`);
  return false;
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
  const fp = fingerprintFor(profileName);
  context = await chromium.launchPersistentContext(profile, { executablePath: executable, headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--use-mock-keychain', '--password-store=basic'],
    locale: fp.locale, timezoneId: fp.timezoneId, viewport: fp.viewport, screen: fp.screen, colorScheme: fp.colorScheme,
    extraHTTPHeaders: { 'Accept-Language': fp.acceptLanguage } });
  if (cookiePath) {
    const jar = await loadCookieJar(resolve(cookiePath));
    for (const warning of jar.warnings) console.warn(warning);
    await context.addCookies(jar.cookies);
    console.log(`已注入 ${jar.cookies.length} 个 cookie。`);
  }
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' });
  let owner = await currentHandle(page).catch(() => null);
  if (!owner) {
    await pause('请在浏览器登录要修改的子账号，完成后回到终端按 Enter：');
    owner = await currentHandle(page);
  }
  if (owner.toLowerCase() === target.toLowerCase()) throw new Error('当前登录账号就是目标账号，已停止');
  accountStore = new AccountStore(resolve('.data'));
  if (accountStore.getByUsername(owner)?.cloned && !dryRun && !updateOnly) {
    console.log(`账号 @${owner} 已克隆，跳过。`);
    input.close();
    await context?.close().catch(() => {});
    accountStore.close();
    process.exit(0);
  }
  await page.goto(`https://x.com/${target}`, { waitUntil: 'domcontentloaded' });
  const heading = page.getByTestId('UserName').first();
  await heading.waitFor({ state: 'visible', timeout: 20000 });
  const lines = (await heading.innerText()).split('\n').map(x => x.trim()).filter(Boolean);
  if (!lines.some(line => line.toLowerCase() === `@${target.toLowerCase()}`)) throw new Error('无法确认读取的是目标账号资料');
  const name = lines[0];
  if (!name || name.startsWith('@')) throw new Error('无法准确读取目标显示名称');
  const description = await readBio(page);
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
  const banner = page.locator('main img[src*="pbs.twimg.com/profile_banners/"]').first();
  const bannerSrc = await banner.getAttribute('src').catch(() => null);
  let bannerType = '';
  let bannerImage: Buffer | null = null;
  if (bannerSrc) {
    const bannerUrl = originalBannerUrl(bannerSrc);
    const bannerResponse = await context.request.get(bannerUrl, { maxRedirects: 0, timeout: 20000 });
    if (!bannerResponse.ok()) throw new Error(`读取横幅失败，HTTP ${bannerResponse.status()}`);
    bannerType = (bannerResponse.headers()['content-type'] || '').split(';')[0].toLowerCase();
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(bannerType)) throw new Error(`不支持的横幅格式 ${bannerType}`);
    bannerImage = await bannerResponse.body();
    if (!bannerImage.length || bannerImage.length > 10 * 1024 * 1024) throw new Error('横幅为空或超过 10 MB');
  }
  console.log(`\n目标：@${target}\n当前登录的子账号：@${owner}\n显示名称：${name}\n简介：${description || '（空）'}\n横幅：${bannerImage ? '有' : '无'}`);
  if (dryRun) {
    console.log('dry-run：已读取目标资料、头像和横幅，不修改账号。');
    input.close();
    accountStore.close();
    await context.close().catch(() => {});
    process.exit(0);
  }
  telemetry.stage('复制头像、显示名称和简介');
  console.log('正在自动复制头像、显示名称和简介。');
  // 资料页上的“Edit profile”按钮会把未完成引导的账号带进 /i/flow/setup_profile，
  // 该引导流程依赖 api.x.com 的跨域请求；设置页提供同一套字段并提交到站内接口。
  await page.goto('https://x.com/settings/profile', { waitUntil: 'domcontentloaded' });
  const nameField = page.locator('input[name="displayName"]');
  await nameField.waitFor({ state: 'visible', timeout: 20000 });
  await actionDelay(page);
  await typeHuman(page, nameField, name);
  await actionDelay(page);
  await typeHuman(page, page.locator('textarea[name="description"]'), description);
  const beforeAvatar = await page.locator('img[src*="pbs.twimg.com/profile_images/"]').first().getAttribute('src').catch(() => null);
  const beforeBanner = await page.locator('img[src*="pbs.twimg.com/profile_banners/"]').first().getAttribute('src').catch(() => null);
  // 头像上传挂在“Add avatar photo”按钮上；直接给隐藏 input 赋值不会触发 X 的裁剪和上传。
  await actionDelay(page);
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 15000 }),
    page.getByRole('button', { name: /avatar photo|头像照片/i }).first().click({ timeout: 15000 }),
  ]);
  await chooser.setFiles({ name: `avatar.${type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg'}`, mimeType: type, buffer: image });
  // 头像由 X 异步上传；保存后等 update_profile_image 返回，避免离开页面时中断上传。
  const avatarUpdate = page.waitForResponse(response => response.url().includes('/account/update_profile_image.json'), { timeout: 40000 }).catch(() => null);
  await applyCrop(page, '头像');
  await page.waitForTimeout(1000);
  let bannerUpdate = null;
  if (bannerImage) {
    await actionDelay(page);
    const [bannerChooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: 15000 }),
      page.getByRole('button', { name: /banner photo|banner|横幅/i }).first().click({ timeout: 15000 }),
    ]);
    await bannerChooser.setFiles({
      name: `banner.${bannerType === 'image/png' ? 'png' : bannerType === 'image/webp' ? 'webp' : 'jpg'}`,
      mimeType: bannerType,
      buffer: bannerImage,
    });
    bannerUpdate = page.waitForResponse(response => /update_profile_banner/.test(response.url()), { timeout: 40000 }).catch(() => null);
    await applyCrop(page, '横幅', false);
    await page.waitForTimeout(1000);
  }
  const save = page.getByTestId('Profile_Save_Button');
  for (let attempt = 0; attempt < 20 && !await save.isEnabled(); attempt++) await page.waitForTimeout(500);
  if (!await save.isEnabled()) throw new Error('资料保存按钮不可用，未提交修改');
  await actionDelay(page);
  await save.click({ timeout: 15000 });
  const avatarResult = await avatarUpdate;
  if (!avatarResult?.ok()) throw new Error('头像上传未完成，请在浏览器检查；名称和简介可能已保存');
  if (bannerUpdate) {
    const bannerResult = await bannerUpdate;
    if (bannerResult && !bannerResult.ok()) throw new Error('横幅上传未完成，请在浏览器检查；名称、简介和头像可能已保存');
  }
  await page.waitForTimeout(2000);
  telemetry.stage('核对资料保存结果');
  console.log('资料保存请求已提交，正在检查结果……');
  await page.goto(`https://x.com/${owner}`, { waitUntil: 'domcontentloaded' });
  const ownLines = (await page.getByTestId('UserName').first().innerText({ timeout: 15000 })).split('\n').map(x => x.trim()).filter(Boolean);
  const ownBio = await readBio(page);
  if (normalizeText(ownLines[0]) !== normalizeText(name) || normalizeText(ownBio) !== normalizeText(description)) throw new Error('名称或简介未通过保存后核对，请在浏览器检查；头像也需人工确认');
  const ownAvatar = await page.locator('main img[src*="pbs.twimg.com/profile_images/"]').first().getAttribute('src', { timeout: 15000 }).catch(() => null);
  if (!ownAvatar || ownAvatar === beforeAvatar) throw new Error('头像未通过保存后核对，请在浏览器检查');
  const ownBanner = await page.locator('main img[src*="pbs.twimg.com/profile_banners/"]').first().getAttribute('src', { timeout: 15000 }).catch(() => null);
  if (bannerImage && (!ownBanner || ownBanner === beforeBanner)) throw new Error('横幅未通过保存后核对，请在浏览器检查');
  console.log('名称、简介、头像和横幅已核对。');
  if (updateOnly) {
    console.log('资料已更新；--update 不修改用户名。');
  } else {
  await page.goto('https://x.com/settings/screen_name', { waitUntil: 'domcontentloaded' });
  const field = await firstVisible(page, ['input[name="typedScreenName"]', 'input[autocomplete="username"]', 'input[name="screen_name"]', 'input[name="username"]', 'input[data-testid="ocfEnterTextTextInput"]']);
  // 输入被占用的目标用户名，让 X 显示自己的用户名建议；改名是高风险步骤，多停一会再拟人化输入。
  await page.waitForTimeout(1000 + Math.floor(Math.random() * 2000));
  await typeHuman(page, field, target);
  const suggestion = await chooseFirstSuggestion(page, target, owner);
  const selected = (await field.inputValue()).replace(/^@/, '');
  if (selected.toLowerCase() !== suggestion.toLowerCase()) throw new Error(`无法确认已选中建议 @${suggestion}，未保存用户名`);
  const saveUsername = await firstVisible(page, ['[data-testid="settingsDetailSave"]', '[data-testid="save"]']);
  for (let attempt = 0; attempt < 20 && !await saveUsername.isEnabled(); attempt++) await page.waitForTimeout(500);
  if (!await saveUsername.isEnabled()) throw new Error('用户名保存按钮不可用，未提交修改');
  telemetry.stage('保存并核对用户名');
  console.log(`正在保存 X 推荐的第一个用户名：@${suggestion}`);
  await page.waitForTimeout(1000 + Math.floor(Math.random() * 2000));
  await saveUsername.click();
  // 保存成功后设置页会回到 /settings/account；用户名生效可能有延迟，轮询核对。
  await page.waitForURL(/\/settings\/account/, { timeout: 10000 }).catch(() => {});
  let actual = '';
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.waitForTimeout(1200);
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' }).catch(() => {});
    actual = await currentHandle(page).catch(() => '');
    if (actual.toLowerCase() === suggestion.toLowerCase()) break;
  }
  if (actual.toLowerCase() !== suggestion.toLowerCase()) throw new Error(`无法确认用户名是否修改成功，当前显示 ${actual ? `@${actual}` : '未知'}；请人工检查`);
  console.log(`用户名已修改并核对：@${actual}`);
  // 优先按授权行（旧用户名）找到已有 uuid，把 clone 结果合进同一行，避免令牌与 clone 信息分到两行。
  const authorized = accountStore.getByUsername(owner);
  accountStore.upsert({
    uuid: authorized?.uuid ?? null,
    username: actual,
    cloned: true,
    copiedFromUuid: null,
    copiedFromUsername: target,
    copiedFromName: name,
    copiedAt: new Date().toISOString(),
  });
  }

} catch (error) {
  console.error(`停止：${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
} finally {
  input.close();
  accountStore?.close();
  await context?.close().catch(() => {});
}
