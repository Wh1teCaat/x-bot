import { DatabaseSync } from 'node:sqlite';
import { ExporterRetry } from './exporter-retry.ts';

const account = process.argv[2];
if (account !== 'shared' && !/^\d{1,19}$/.test(account || '')) throw new Error('用法：npm run exporter:retry-reset -- <账号数字ID|shared>');
const db = new DatabaseSync('.data/loop.sqlite');
try {
  new ExporterRetry(db, `exporter:${account}`).success();
  new ExporterRetry(db, `exporter-open:${account}`).success();
  console.log('exporter24 退避状态已清除；请先确认扩展任务已停止，随后重启任务。');
} finally { db.close(); }
