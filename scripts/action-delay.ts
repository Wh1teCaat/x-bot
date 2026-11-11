/** 为脚本直接发起的浏览器操作提供随机等待。 */
// Additional jitter for actions initiated by our scripts, not the extension's own work.
/** 在一次浏览器操作前等待 0–1000 毫秒。 */
export async function actionDelay(page, random = Math.random) {
  await page.waitForTimeout(Math.floor(random() * 1001));
}

// Count actual profile navigations, including profiles that later fail validation.
/** 创建访问计数器，每访问十个主页附加一次随机等待。 */
export function createProfileVisitDelay(page, random = Math.random) {
  let visits = 0;
  return async () => {
    visits++;
    if (visits % 10 === 0) await page.waitForTimeout(Math.floor(random() * 5001));
  };
}
