/** 验证账号表的持久化、加密、合并与旧文件迁移。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AccountStore } from "../src/account-store.ts";

test("persists account identity, flags and encrypted tokens", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-account-store-"));
  try {
    const store = new AccountStore(dir);
    store.upsert({
      uuid: "123",
      name: "Alice",
      username: "alice",
      authenticated: true,
      accessToken: "secret-access",
      refreshToken: "secret-refresh",
      expiresAt: 1234567890,
      scope: "users.read follows.write",
    });

    const byUuid = store.getByUuid("123");
    assert.ok(byUuid);
    assert.equal(byUuid!.username, "alice");
    assert.equal(byUuid!.cloned, false);
    assert.equal(byUuid!.chromeReady, false);
    assert.equal(byUuid!.authenticated, true);
    assert.equal(byUuid!.accessToken, "secret-access");
    assert.equal(byUuid!.refreshToken, "secret-refresh");

    // 明文令牌不得出现在数据库文件中。
    const raw = readFileSync(join(dir, "accounts.sqlite"), "utf8");
    assert.equal(raw.includes("secret-access"), false);
    assert.equal(raw.includes("secret-refresh"), false);

    store.upsert({ uuid: "123", username: "alice", chromeReady: true, cloned: true });
    const updated = store.getByUuid("123");
    assert.equal(updated!.chromeReady, true);
    assert.equal(updated!.cloned, true);
    assert.equal(updated!.authenticated, true);
    assert.equal(updated!.accessToken, "secret-access");

    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("looks up accounts case-insensitively by username", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-account-store-"));
  try {
    const store = new AccountStore(dir);
    store.upsert({ username: "CloneTarget", cloned: true });
    assert.equal(store.getByUsername("clonetarget")!.cloned, true);
    assert.equal(store.getByUsername("CLONETARGET")!.username, "CloneTarget");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("merges case-insensitive usernames into one record", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-account-store-"));
  try {
    const store = new AccountStore(dir);
    store.upsert({ username: "Alice", cloned: true });
    store.upsert({ username: "alice", chromeReady: true });
    assert.equal(store.list().length, 1);
    const rec = store.getByUsername("ALICE")!;
    assert.equal(rec.cloned, true);
    assert.equal(rec.chromeReady, true);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("does not index username; uses uuid as the unique key", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-account-store-"));
  try {
    const store = new AccountStore(dir);
    store.close();
    const db = new DatabaseSync(join(dir, "accounts.sqlite"));
    const names = (db.prepare("PRAGMA index_list(accounts)").all() as Array<{ name: string }>).map((r) => r.name);
    assert.equal(names.includes("accounts_username_idx"), false);
    assert.ok(names.some((n) => n.startsWith("sqlite_autoindex"))); // uuid UNIQUE 的自动索引
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("migrates legacy accounts.enc records into the table", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-account-store-"));
  try {
    const key = randomBytes(32);
    writeFileSync(join(dir, "key"), key, { mode: 0o600 });
    const legacy = {
      "123": {
        user: { id: "123", name: "Alice", username: "alice" },
        accessToken: "legacy-access",
        refreshToken: "legacy-refresh",
        expiresAt: 9999999999,
        scope: "users.read",
      },
    };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(legacy)), cipher.final()]);
    writeFileSync(join(dir, "accounts.enc"), Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });

    const store = new AccountStore(dir);
    const migrated = store.getByUuid("123");
    assert.ok(migrated);
    assert.equal(migrated!.username, "alice");
    assert.equal(migrated!.authenticated, true);
    assert.equal(migrated!.accessToken, "legacy-access");
    assert.equal(migrated!.refreshToken, "legacy-refresh");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists clone source account info", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-account-store-"));
  try {
    const store = new AccountStore(dir);
    store.upsert({
      username: "clone1",
      cloned: true,
      copiedFromUuid: null,
      copiedFromUsername: "TargetUser",
      copiedFromName: "Target Display",
      copiedAt: "2026-11-13T00:00:00.000Z",
    });
    const rec = store.getByUsername("clone1");
    assert.ok(rec);
    assert.equal(rec!.cloned, true);
    assert.equal(rec!.copiedFromUsername, "TargetUser");
    assert.equal(rec!.copiedFromName, "Target Display");
    assert.equal(rec!.copiedFromUuid, null);
    assert.equal(rec!.copiedAt, "2026-11-13T00:00:00.000Z");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adds missing copy columns to an existing table", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-account-store-"));
  try {
    // 构造旧版表（无 copied_* 列），并写入一行。
    const db = new DatabaseSync(join(dir, "accounts.sqlite"));
    db.exec(`CREATE TABLE accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uuid TEXT UNIQUE,
      name TEXT,
      username TEXT NOT NULL,
      cloned INTEGER NOT NULL DEFAULT 0,
      chrome_ready INTEGER NOT NULL DEFAULT 0,
      authenticated INTEGER NOT NULL DEFAULT 0,
      access TEXT, refresh TEXT, expires_at INTEGER, scope TEXT,
      updated_at TEXT NOT NULL
    );`);
    db.prepare("INSERT INTO accounts (username, updated_at) VALUES (?, ?)").run("old", new Date().toISOString());
    db.close();

    const store = new AccountStore(dir);
    const rec = store.getByUsername("old");
    assert.ok(rec);
    assert.equal(rec!.cloned, false);
    assert.equal(rec!.copiedFromUsername, null);
    store.upsert({ username: "old", cloned: true, copiedFromUsername: "Target" });
    assert.equal(store.getByUsername("old")!.copiedFromUsername, "Target");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persists blogger keywords for later retrieval", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-account-store-"));
  try {
    const store = new AccountStore(dir);
    store.upsert({ username: "blogger1", keywords: ["python developer", "Saudi Arabia", "AI"] });
    assert.deepEqual(store.getByUsername("blogger1")!.keywords, ["python developer", "Saudi Arabia", "AI"]);
    store.upsert({ username: "blogger1", cloned: true, keywords: ["updated"] });
    const rec = store.getByUsername("blogger1")!;
    assert.equal(rec.cloned, true);
    assert.deepEqual(rec.keywords, ["updated"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("authorization merges tokens into the existing clone record by username", () => {
  const dir = mkdtempSync(join(tmpdir(), "x-account-store-"));
  try {
    const store = new AccountStore(dir);
    // clone 阶段：只有 username，无 uuid。
    store.upsert({ username: "subaccount", cloned: true, copiedFromUsername: "target", copiedFromName: "Target", copiedAt: "2026-11-13T00:00:00.000Z", keywords: ["AI"] });
    // OAuth 授权：按 uuid 写入令牌，应合并进同一行而不是新建。
    store.upsert({ uuid: "777", name: "Sub Account", username: "subaccount", authenticated: true, accessToken: "acc", refreshToken: "ref", expiresAt: 123, scope: "tweet.write media.write" });

    const rec = store.getByUsername("subaccount")!;
    assert.equal(rec.uuid, "777");
    assert.equal(rec.cloned, true);
    assert.equal(rec.copiedFromUsername, "target");
    assert.equal(rec.copiedFromName, "Target");
    assert.equal(rec.authenticated, true);
    assert.equal(rec.accessToken, "acc");
    assert.equal(rec.refreshToken, "ref");
    assert.deepEqual(rec.keywords, ["AI"]);
    assert.equal(store.list().length, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
