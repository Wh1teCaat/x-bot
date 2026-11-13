/** 持久化账号相关状态：身份、克隆、浏览器登录与插件、OAuth 认证及令牌。 */
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 账号表记录；access/refresh 为解密后的令牌。 */
export type AccountRecord = {
  id: number;
  /** X 账号数字 ID（唯一标识）；尚未绑定的克隆账号可为空。 */
  uuid: string | null;
  name: string | null;
  username: string;
  /** 是否已完成资料复制（clone）。 */
  cloned: boolean;
  /** 是否已在账号对应资料的 Chrome 中登录并安装插件。 */
  chromeReady: boolean;
  /** 是否已完成 OAuth 认证。 */
  authenticated: boolean;
  accessToken: string | null;
  refreshToken: string | null;
  expiresAt: number | null;
  scope: string | null;
  /** clone 来源账号的数字 ID（若已解析）。 */
  copiedFromUuid: string | null;
  /** clone 来源账号的用户名。 */
  copiedFromUsername: string | null;
  /** clone 来源账号的显示名称。 */
  copiedFromName: string | null;
  /** clone 完成时间（ISO 字符串）。 */
  copiedAt: string | null;
  /** 历史关键词字段；保留兼容，不再参与当前筛选流程。 */
  keywords: string[];
};

/** upsert 输入；仅填写需要变更的字段，其余保持原值或使用默认值。 */
export type AccountInput = {
  uuid?: string | null;
  name?: string | null;
  username: string;
  cloned?: boolean;
  chromeReady?: boolean;
  authenticated?: boolean;
  accessToken?: string | null;
  refreshToken?: string | null;
  expiresAt?: number | null;
  scope?: string | null;
  copiedFromUuid?: string | null;
  copiedFromUsername?: string | null;
  copiedFromName?: string | null;
  copiedAt?: string | null;
  keywords?: string[];
};

type Row = {
  id: number;
  uuid: string | null;
  name: string | null;
  username: string;
  cloned: number;
  chrome_ready: number;
  authenticated: number;
  access: string | null;
  refresh: string | null;
  expires_at: number | null;
  scope: string | null;
  copied_from_uuid: string | null;
  copied_from_username: string | null;
  copied_from_name: string | null;
  copied_at: string | null;
  keywords: string | null;
};

const SCHEMA = `CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uuid TEXT UNIQUE,
  name TEXT,
  username TEXT NOT NULL,
  cloned INTEGER NOT NULL DEFAULT 0,
  chrome_ready INTEGER NOT NULL DEFAULT 0,
  authenticated INTEGER NOT NULL DEFAULT 0,
  access TEXT,
  refresh TEXT,
  expires_at INTEGER,
  scope TEXT,
  copied_from_uuid TEXT,
  copied_from_username TEXT,
  copied_from_name TEXT,
  copied_at TEXT,
  keywords TEXT,
  updated_at TEXT NOT NULL
);`;

export class AccountStore {
  private db: DatabaseSync;
  private dataDir: string;
  private _key: Buffer | null = null;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, "accounts.sqlite"));
    this.db.exec(SCHEMA);
    this.migrateColumns();
    this.migrateIndexes();
    this.migrateLegacy();
  }

  /** 移除 username 索引：username 可变、不作为查找键；uuid 是唯一索引。 */
  private migrateIndexes() {
    this.db.exec("DROP INDEX IF EXISTS accounts_username_idx");
  }

  /** 为旧版数据库补齐后加的列；幂等。 */
  private migrateColumns() {
    const existing = new Set((this.db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>).map((row) => row.name));
    const add = (name: string, ddl: string) => { if (!existing.has(name)) this.db.exec(`ALTER TABLE accounts ADD COLUMN ${ddl}`); };
    add("copied_from_uuid", "copied_from_uuid TEXT");
    add("copied_from_username", "copied_from_username TEXT");
    add("copied_from_name", "copied_from_name TEXT");
    add("copied_at", "copied_at TEXT");
    add("keywords", "keywords TEXT");
  }

  /** 惰性读取或创建加密密钥；仅在首次读写令牌时访问。 */
  private key(): Buffer {
    if (!this._key) {
      const keyPath = join(this.dataDir, "key");
      if (!existsSync(keyPath)) {
        try {
          writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: "wx" });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      const key = readFileSync(keyPath);
      if (key.length !== 32) throw new Error("Invalid encryption key");
      this._key = key;
    }
    return this._key;
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key(), iv);
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64url");
  }

  private decrypt(value: string): string {
    const blob = Buffer.from(value, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", this.key(), blob.subarray(0, 12));
    decipher.setAuthTag(blob.subarray(12, 28));
    return Buffer.concat([
      decipher.update(blob.subarray(28)),
      decipher.final(),
    ]).toString("utf8");
  }

  /** 解析 keywords 列（JSON 数组），异常或空值返回空数组。 */
  private parseKeywords(value: string | null): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((k: unknown): k is string => typeof k === "string" && k.length > 0) : [];
    } catch { return []; }
  }

  private toRecord(row: Row): AccountRecord {
    return {
      id: row.id,
      uuid: row.uuid,
      name: row.name,
      username: row.username,
      cloned: !!row.cloned,
      chromeReady: !!row.chrome_ready,
      authenticated: !!row.authenticated,
      accessToken: row.access ? this.decrypt(row.access) : null,
      refreshToken: row.refresh ? this.decrypt(row.refresh) : null,
      expiresAt: row.expires_at,
      scope: row.scope,
      copiedFromUuid: row.copied_from_uuid,
      copiedFromUsername: row.copied_from_username,
      copiedFromName: row.copied_from_name,
      copiedAt: row.copied_at,
      keywords: this.parseKeywords(row.keywords),
    };
  }

  getByUuid(uuid: string): AccountRecord | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE uuid=?").get(uuid) as Row | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  getByUsername(username: string): AccountRecord | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE username=? COLLATE NOCASE").get(username) as Row | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  list(): AccountRecord[] {
    return (this.db.prepare("SELECT * FROM accounts ORDER BY id").all() as Row[]).map((row) => this.toRecord(row));
  }

  private getById(id: number): AccountRecord | undefined {
    const row = this.db.prepare("SELECT * FROM accounts WHERE id=?").get(id) as Row | undefined;
    return row ? this.toRecord(row) : undefined;
  }

  /** 按 uuid（优先，找不到再按 username）定位账号；未填写的字段保留原值或使用默认值。 */
  upsert(input: AccountInput): AccountRecord {
    let existing: AccountRecord | undefined;
    if (input.uuid != null) existing = this.getByUuid(input.uuid);
    if (!existing) existing = this.getByUsername(input.username);
    const now = new Date().toISOString();

    if (existing) {
      const merged = {
        uuid: input.uuid !== undefined ? input.uuid : existing.uuid,
        name: input.name !== undefined ? input.name : existing.name,
        username: input.username !== undefined ? input.username : existing.username,
        cloned: input.cloned !== undefined ? input.cloned : existing.cloned,
        chromeReady: input.chromeReady !== undefined ? input.chromeReady : existing.chromeReady,
        authenticated: input.authenticated !== undefined ? input.authenticated : existing.authenticated,
        accessToken: input.accessToken !== undefined ? input.accessToken : existing.accessToken,
        refreshToken: input.refreshToken !== undefined ? input.refreshToken : existing.refreshToken,
        expiresAt: input.expiresAt !== undefined ? input.expiresAt : existing.expiresAt,
        scope: input.scope !== undefined ? input.scope : existing.scope,
        copiedFromUuid: input.copiedFromUuid !== undefined ? input.copiedFromUuid : existing.copiedFromUuid,
        copiedFromUsername: input.copiedFromUsername !== undefined ? input.copiedFromUsername : existing.copiedFromUsername,
        copiedFromName: input.copiedFromName !== undefined ? input.copiedFromName : existing.copiedFromName,
        copiedAt: input.copiedAt !== undefined ? input.copiedAt : existing.copiedAt,
        keywords: input.keywords !== undefined ? input.keywords : existing.keywords,
      };
      this.db.prepare(`UPDATE accounts SET uuid=?, name=?, username=?, cloned=?, chrome_ready=?, authenticated=?, access=?, refresh=?, expires_at=?, scope=?, copied_from_uuid=?, copied_from_username=?, copied_from_name=?, copied_at=?, keywords=?, updated_at=? WHERE id=?`)
        .run(
          merged.uuid, merged.name, merged.username,
          merged.cloned ? 1 : 0, merged.chromeReady ? 1 : 0, merged.authenticated ? 1 : 0,
          merged.accessToken != null ? this.encrypt(merged.accessToken) : null,
          merged.refreshToken != null ? this.encrypt(merged.refreshToken) : null,
          merged.expiresAt, merged.scope,
          merged.copiedFromUuid, merged.copiedFromUsername, merged.copiedFromName, merged.copiedAt,
          merged.keywords.length ? JSON.stringify(merged.keywords.filter((k: string) => typeof k === "string" && k)) : null,
          now, existing.id,
        );
      return this.getById(existing.id)!;
    }

    const result = this.db.prepare(`INSERT INTO accounts (uuid, name, username, cloned, chrome_ready, authenticated, access, refresh, expires_at, scope, copied_from_uuid, copied_from_username, copied_from_name, copied_at, keywords, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        input.uuid ?? null, input.name ?? null, input.username,
        input.cloned ? 1 : 0, input.chromeReady ? 1 : 0, input.authenticated ? 1 : 0,
        input.accessToken != null ? this.encrypt(input.accessToken) : null,
        input.refreshToken != null ? this.encrypt(input.refreshToken) : null,
        input.expiresAt ?? null, input.scope ?? null,
        input.copiedFromUuid ?? null, input.copiedFromUsername ?? null, input.copiedFromName ?? null, input.copiedAt ?? null,
        (input.keywords || []).length ? JSON.stringify((input.keywords || []).filter((k) => typeof k === "string" && k)) : null,
        now,
      );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  /** 将旧版 accounts.enc 一次性迁移到账号表；失败不阻断启动。 */
  private migrateLegacy() {
    const encPath = join(this.dataDir, "accounts.enc");
    if (!existsSync(encPath)) return;
    const count = (this.db.prepare("SELECT COUNT(*) AS c FROM accounts").get() as { c: number }).c;
    if (count > 0) return;

    try {
      const blob = readFileSync(encPath);
      const decipher = createDecipheriv("aes-256-gcm", this.key(), blob.subarray(0, 12));
      decipher.setAuthTag(blob.subarray(12, 28));
      const legacy = JSON.parse(
        Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString(),
      ) as Record<string, {
        user: { id: string; name?: string; username: string };
        accessToken: string; refreshToken?: string; expiresAt: number; scope?: string;
      }>;

      for (const account of Object.values(legacy)) {
        this.upsert({
          uuid: account.user.id,
          name: account.user.name ?? null,
          username: account.user.username,
          authenticated: true,
          accessToken: account.accessToken,
          refreshToken: account.refreshToken ?? null,
          expiresAt: account.expiresAt,
          scope: account.scope ?? null,
        });
      }
    } catch {
      // 迁移失败时保留旧文件，不阻断启动。
    }
  }

  close() { this.db.close(); }
}
