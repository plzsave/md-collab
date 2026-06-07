import { CONFIG, SHEETS, THREAD_COLS, COMMENT_COLS, MEMBER_COLS, NOTIF_COLS, FOLDER_COLS, STATUS_COLS, DOC_META_COLS, REVIEW_COLS, REVISION_COLS, DEFAULT_STATUSES } from "./config";
import type { Folder, MdDocument, CommentThread, Comment, Member, Notification, AppState, DocStatus, SavedReview, PendingRevision } from "./types";

// ─── Utilities ───────────────────────────────────────────────────────────────

function uuid(): string {
  return Utilities.getUuid();
}

function now(): string {
  return new Date().toISOString();
}

function currentUserEmail(): string {
  return Session.getActiveUser().getEmail();
}

/** The user the script executes as (the deployer). Always treated as owner/admin. */
function ownerEmail(): string {
  return Session.getEffectiveUser().getEmail();
}

function getMemberDisplayName(email: string, members: Member[]): string {
  return members.find((m) => m.email === email)?.displayName ?? email;
}

/** Parse @mentions out of comment text. Mirrors the client regex. */
function parseMentions(content: string): string[] {
  const matches = content.match(/@([\w.+\-@]+)/g) ?? [];
  return [...new Set(matches.map((m) => m.substring(1)))];
}

/**
 * Serialize every state-mutating operation. The spreadsheet "DB" has no
 * transactions, so concurrent read-modify-write / deleteRow calls from
 * multiple users would corrupt rows or shift indices. A single script lock
 * makes all writes mutually exclusive.
 */
function withLock<T>(fn: () => T): T {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) {
    throw new Error("混雑しています。しばらくしてからもう一度お試しください。");
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ─── Caching ───────────────────────────────────────────────────────────────────
//
// The dominant cost of each google.script.run call is opening the spreadsheet DB
// (Drive lookups + SpreadsheetApp.openById) and reading sheets. Small, rarely
// changing datasets (members, statuses, per-document metadata) are cached in the
// script-wide CacheService so most reads never touch the spreadsheet, and the DB
// / root-folder ids are cached in ScriptProperties so we skip the Drive search.
// Caches are invalidated explicitly on every write (inside withLock); the TTL is
// only a safety net in case an invalidation is ever missed.

const CACHE_TTL = 1800; // seconds (30 min)

const CACHE_KEYS = {
  MEMBERS: "cache:members",
  STATUSES: "cache:statuses",
  DOC_META: "cache:doc_meta",
} as const;

const PROP_KEYS = {
  // Optional folder (may live on a Shared Drive) holding the DB spreadsheet and
  // any folders created via createFolder. Unset means "use My Drive root".
  BASE_FOLDER_ID: "baseFolderId",
  DB_SPREADSHEET_ID: "dbSpreadsheetId",
} as const;

function cacheGet<T>(key: string): T | null {
  try {
    const raw = CacheService.getScriptCache().get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch (e) {
    return null;
  }
}

function cachePut(key: string, value: unknown): void {
  try {
    const raw = JSON.stringify(value);
    if (raw.length > 90000) return; // CacheService rejects values larger than 100KB
    CacheService.getScriptCache().put(key, raw, CACHE_TTL);
  } catch (e) {
    // Caching is best-effort; a failure here must never break the operation.
  }
}

function cacheRemove(key: string): void {
  try {
    CacheService.getScriptCache().remove(key);
  } catch (e) {
    // ignore
  }
}

// ─── Authorization ─────────────────────────────────────────────────────────────

/**
 * Returns whether `email` is allowed to use the workspace.
 * Bootstrap rule: while no members are registered yet, anyone is allowed so the
 * first user can register members. Once members exist, only members (and the
 * deployer/owner) are allowed.
 */
function isAuthorized(email: string, members: Member[]): boolean {
  if (members.length === 0) return true;
  if (email && email === ownerEmail()) return true;
  return members.some((m) => m.email === email);
}

/** Throws unless the active user may use the workspace. Returns the user's email. */
function requireMember(): string {
  const user = currentUserEmail();
  if (!isAuthorized(user, getMembers())) {
    throw new Error("このワークスペースへのアクセス権がありません。");
  }
  return user;
}

function isOwner(email: string): boolean {
  return !!email && email === ownerEmail();
}

// ─── Drive / Folder placement ────────────────────────────────────────────────
//
// The DB spreadsheet and folders created via createFolder live inside an optional
// "base folder" the deployer picks once at setup (setupDb). That base folder can
// be a folder on a Shared Drive (共有ドライブ), so the workspace keeps working even
// if the deployer leaves the organization. When no base folder is configured we
// fall back to My Drive root. Existing folders scattered elsewhere are attached
// with linkFolder instead of being created here.

/** The configured base folder, or null when none was chosen (use My Drive root). */
function getBaseFolder(): GoogleAppsScript.Drive.Folder | null {
  const id = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.BASE_FOLDER_ID);
  if (!id) return null;
  try {
    return DriveApp.getFolderById(id);
  } catch (e) {
    // Configured base folder no longer resolves; behave as if unset.
    return null;
  }
}

// ─── Spreadsheet (DB) ────────────────────────────────────────────────────────

// Cached for the lifetime of a single script execution (one google.script.run
// call). Opening the DB does several Drive round-trips, so we do it at most once.
let _db: GoogleAppsScript.Spreadsheet.Spreadsheet | null = null;

/** Whether the DB has been provisioned (setupDb has run). */
function isDbConfigured(): boolean {
  return !!PropertiesService.getScriptProperties().getProperty(PROP_KEYS.DB_SPREADSHEET_ID);
}

function getOrCreateDb(): GoogleAppsScript.Spreadsheet.Spreadsheet {
  if (_db) return _db;
  const savedId = PropertiesService.getScriptProperties().getProperty(PROP_KEYS.DB_SPREADSHEET_ID);
  if (!savedId) {
    // Provisioning (setupDb) must run first. getAppState short-circuits before
    // reaching here, so this only fires on a stray data call before setup.
    throw new Error("セットアップが完了していません。");
  }
  _db = SpreadsheetApp.openById(savedId);
  return _db;
}

/**
 * One-time provisioning: create the DB spreadsheet (optionally inside the chosen
 * base folder) and remember both ids. Restricted to the deployer/owner — while no
 * DB exists there are no members yet, so isAuthorized() would let anyone in.
 *
 * `baseFolderId` may be empty (DB goes to My Drive root) or a folder id copied
 * from a Drive URL, including a Shared Drive folder.
 */
export function setupDb(baseFolderId: string): { ok: true } {
  return withLock(() => {
    if (!isOwner(currentUserEmail())) {
      throw new Error("セットアップはアプリのデプロイ者のみ実行できます。");
    }
    if (isDbConfigured()) throw new Error("すでにセットアップ済みです。");

    const props = PropertiesService.getScriptProperties();
    const trimmed = String(baseFolderId || "").trim();
    let baseFolder: GoogleAppsScript.Drive.Folder | null = null;
    if (trimmed) {
      try {
        baseFolder = DriveApp.getFolderById(trimmed);
      } catch (e) {
        throw new Error("フォルダが見つかりません。フォルダIDを確認してください。");
      }
      props.setProperty(PROP_KEYS.BASE_FOLDER_ID, baseFolder.getId());
    }

    const ss = SpreadsheetApp.create(CONFIG.DB_SPREADSHEET_NAME);
    initSheets(ss);
    if (baseFolder) {
      // Move the freshly created spreadsheet out of My Drive into the base folder.
      // For a Shared Drive target this transfers ownership to the drive; it works
      // when the deployer has write (Contributor+) access there.
      DriveApp.getFileById(ss.getId()).moveTo(baseFolder);
    }
    props.setProperty(PROP_KEYS.DB_SPREADSHEET_ID, ss.getId());
    _db = ss;
    return { ok: true };
  });
}

function initSheets(ss: GoogleAppsScript.Spreadsheet.Spreadsheet): void {
  const names = [SHEETS.THREADS, SHEETS.COMMENTS, SHEETS.MEMBERS, SHEETS.NOTIFICATIONS, SHEETS.FOLDERS, SHEETS.STATUSES, SHEETS.DOC_META, SHEETS.REVIEWS, SHEETS.REVISIONS];
  const defaultSheet = ss.getSheets()[0];
  for (const name of names) {
    const existing = ss.getSheetByName(name);
    if (!existing) ss.insertSheet(name);
  }
  if (defaultSheet && !names.includes(defaultSheet.getName() as never)) {
    ss.deleteSheet(defaultSheet);
  }
}

function getSheet(name: string): GoogleAppsScript.Spreadsheet.Sheet {
  const ss = getOrCreateDb();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  return sheet;
}

function sheetData(sheet: GoogleAppsScript.Spreadsheet.Sheet): string[][] {
  const last = sheet.getLastRow();
  if (last < 1) return [];
  return sheet.getRange(1, 1, last, sheet.getLastColumn() || 1).getValues().map((r) => r.map(String));
}

// ─── Folder (Tab) management ─────────────────────────────────────────────────

export function getFolders(): Folder[] {
  const sheet = getSheet(SHEETS.FOLDERS);
  return sheetData(sheet).map((r) => ({
    id: r[FOLDER_COLS.FOLDER_ID] ?? "",
    name: r[FOLDER_COLS.NAME] ?? "",
  }));
}

/** All Drive folder IDs managed by this app — used to scope document access. */
function getManagedDriveFolderIds(): Set<string> {
  const sheet = getSheet(SHEETS.FOLDERS);
  return new Set(sheetData(sheet).map((r) => r[FOLDER_COLS.DRIVE_FOLDER_ID] ?? "").filter(Boolean));
}

export function createFolder(name: string): Folder {
  return withLock(() => {
    requireMember();
    const base = getBaseFolder();
    const driveFolder = base ? base.createFolder(name) : DriveApp.createFolder(name);
    const id = uuid();
    const sheet = getSheet(SHEETS.FOLDERS);
    sheet.appendRow([id, name, driveFolder.getId(), now(), currentUserEmail()]);
    return { id, name };
  });
}

/**
 * Attach an existing Drive folder (anywhere the deployer can access, including a
 * Shared Drive) as a workspace folder rather than creating a new one. `name`
 * defaults to the folder's own name. The same Drive folder cannot be linked twice.
 */
export function linkFolder(driveFolderId: string, name?: string): Folder {
  return withLock(() => {
    requireMember();
    const driveId = String(driveFolderId || "").trim();
    if (!driveId) throw new Error("フォルダIDを入力してください。");
    let driveFolder: GoogleAppsScript.Drive.Folder;
    try {
      driveFolder = DriveApp.getFolderById(driveId);
    } catch (e) {
      throw new Error("フォルダが見つかりません。フォルダIDを確認してください。");
    }
    const resolvedDriveId = driveFolder.getId();
    if (getManagedDriveFolderIds().has(resolvedDriveId)) {
      throw new Error("このフォルダはすでに追加されています。");
    }
    const displayName = String(name || "").trim() || driveFolder.getName();
    const id = uuid();
    const sheet = getSheet(SHEETS.FOLDERS);
    sheet.appendRow([id, displayName, resolvedDriveId, now(), currentUserEmail()]);
    return { id, name: displayName };
  });
}

export function renameFolder(folderId: string, newName: string): void {
  withLock(() => {
    requireMember();
    const sheet = getSheet(SHEETS.FOLDERS);
    const rows = sheetData(sheet);
    const idx = rows.findIndex((r) => r[FOLDER_COLS.FOLDER_ID] === folderId);
    if (idx === -1) throw new Error("Folder not found");
    const driveFolderId = rows[idx]![FOLDER_COLS.DRIVE_FOLDER_ID]!;
    sheet.getRange(idx + 1, FOLDER_COLS.NAME + 1).setValue(newName);
    DriveApp.getFolderById(driveFolderId).setName(newName);
  });
}

export function deleteFolder(folderId: string): void {
  withLock(() => {
    requireMember();
    const sheet = getSheet(SHEETS.FOLDERS);
    const rows = sheetData(sheet);
    const idx = rows.findIndex((r) => r[FOLDER_COLS.FOLDER_ID] === folderId);
    if (idx === -1) throw new Error("Folder not found");
    const driveFolderId = rows[idx]![FOLDER_COLS.DRIVE_FOLDER_ID];
    if (driveFolderId) {
      const driveFolder = DriveApp.getFolderById(driveFolderId);
      // Refuse to delete a folder that still holds documents, so we never orphan
      // files or their threads/comments. The user must empty it first.
      if (driveFolder.getFiles().hasNext()) {
        throw new Error("フォルダ内にドキュメントがあります。先に削除してください。");
      }
      driveFolder.setTrashed(true);
    }
    sheet.deleteRow(idx + 1);
  });
}

function getDriveFolderId(folderId: string): string {
  const sheet = getSheet(SHEETS.FOLDERS);
  const rows = sheetData(sheet);
  const row = rows.find((r) => r[FOLDER_COLS.FOLDER_ID] === folderId);
  if (!row) throw new Error("Folder not found");
  return row[FOLDER_COLS.DRIVE_FOLDER_ID]!;
}

// ─── Document statuses ─────────────────────────────────────────────────────────

/**
 * The customizable list of workflow statuses (作成中 / レビュー中 / 作成完了 …).
 * Stored in the STATUSES sheet. While the user has not customized anything the
 * sheet is empty and we return the in-memory defaults (no write-on-read).
 */
export function getStatuses(): DocStatus[] {
  const cached = cacheGet<DocStatus[]>(CACHE_KEYS.STATUSES);
  if (cached) return cached;
  const rows = sheetData(getSheet(SHEETS.STATUSES));
  const seen = new Set<string>();
  const statuses: DocStatus[] =
    rows.length === 0
      ? DEFAULT_STATUSES.map((s) => ({ ...s }))
      : rows
          .map((r) => ({
            id: (r[STATUS_COLS.ID] ?? "").trim(),
            label: (r[STATUS_COLS.LABEL] ?? "").trim(),
            order: Number(r[STATUS_COLS.ORDER] ?? "0"),
          }))
          .filter((s) => s.id && s.label && !seen.has(s.id) && (seen.add(s.id), true))
          .sort((a, b) => a.order - b.order)
          .map((s) => ({ id: s.id, label: s.label }));
  cachePut(CACHE_KEYS.STATUSES, statuses);
  return statuses;
}

/**
 * Replace the whole status list with `statuses` (the client sends the full,
 * reordered list for add/rename/delete in one shot). Documents that referenced a
 * now-deleted status fall back to the first status at read time, so no per-doc
 * migration is needed here.
 */
export function saveStatuses(statuses: DocStatus[]): DocStatus[] {
  return withLock(() => {
    requireMember();
    const seen = new Set<string>();
    const clean = (statuses || [])
      .map((s) => ({ id: String(s.id || "").trim(), label: String(s.label || "").trim() }))
      .filter((s) => s.id && s.label && !seen.has(s.id) && (seen.add(s.id), true));
    if (clean.length === 0) throw new Error("ステータスは1つ以上必要です。");
    const sheet = getSheet(SHEETS.STATUSES);
    sheet.clearContents();
    sheet.getRange(1, 1, clean.length, 3).setValues(clean.map((s, i) => [s.id, s.label, String(i)]));
    cacheRemove(CACHE_KEYS.STATUSES);
    return clean;
  });
}

// ─── Per-document metadata (status / archived) ─────────────────────────────────

interface DocMeta {
  statusId: string;
  archived: boolean;
  assignee: string;
}

/** Read every document's status/archived flag in one batch (keyed by file id). */
function getDocMetaMap(): { [docId: string]: DocMeta } {
  const cached = cacheGet<{ [docId: string]: DocMeta }>(CACHE_KEYS.DOC_META);
  if (cached) return cached;
  const map: { [docId: string]: DocMeta } = {};
  for (const r of sheetData(getSheet(SHEETS.DOC_META))) {
    const id = r[DOC_META_COLS.DOCUMENT_ID];
    if (!id) continue;
    map[id] = {
      statusId: r[DOC_META_COLS.STATUS_ID] ?? "",
      archived: r[DOC_META_COLS.ARCHIVED] === "true",
      assignee: r[DOC_META_COLS.ASSIGNEE] ?? "",
    };
  }
  cachePut(CACHE_KEYS.DOC_META, map);
  return map;
}

/** Insert or update one document's metadata row. Always called inside withLock. */
function upsertDocMeta(documentId: string, patch: Partial<DocMeta>): void {
  const sheet = getSheet(SHEETS.DOC_META);
  const rows = sheetData(sheet);
  const idx = rows.findIndex((r) => r[DOC_META_COLS.DOCUMENT_ID] === documentId);
  if (idx === -1) {
    sheet.appendRow([documentId, patch.statusId ?? "", patch.archived ? "true" : "false", patch.assignee ?? ""]);
  } else {
    if (patch.statusId !== undefined) sheet.getRange(idx + 1, DOC_META_COLS.STATUS_ID + 1).setValue(patch.statusId);
    if (patch.archived !== undefined) sheet.getRange(idx + 1, DOC_META_COLS.ARCHIVED + 1).setValue(patch.archived ? "true" : "false");
    if (patch.assignee !== undefined) sheet.getRange(idx + 1, DOC_META_COLS.ASSIGNEE + 1).setValue(patch.assignee);
  }
  cacheRemove(CACHE_KEYS.DOC_META);
}

export function setDocumentStatus(fileId: string, statusId: string): void {
  withLock(() => {
    requireMember();
    getManagedFile(fileId); // ensure the file belongs to this workspace
    upsertDocMeta(fileId, { statusId });
  });
}

export function setDocumentArchived(fileId: string, archived: boolean): void {
  withLock(() => {
    requireMember();
    getManagedFile(fileId);
    upsertDocMeta(fileId, { archived: !!archived });
  });
}

export function setDocumentAssignee(fileId: string, assignee: string): void {
  withLock(() => {
    requireMember();
    getManagedFile(fileId);
    const a = String(assignee || "").trim();
    // Empty clears the assignment; otherwise it must be a current member.
    if (a && !getMembers().some((m) => m.email === a)) {
      throw new Error("担当者はメンバーから選択してください。");
    }
    upsertDocMeta(fileId, { assignee: a });
  });
}

// ─── Documents ───────────────────────────────────────────────────────────────

/**
 * Resolve a document file, but only if it lives in one of the workspace's
 * managed folders. This prevents passing an arbitrary fileId to read/modify/
 * delete files the deployer happens to have access to (IDOR).
 */
function getManagedFile(fileId: string): GoogleAppsScript.Drive.File {
  const managed = getManagedDriveFolderIds();
  let file: GoogleAppsScript.Drive.File;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    throw new Error("ドキュメントが見つかりません");
  }
  const parents = file.getParents();
  while (parents.hasNext()) {
    if (managed.has(parents.next().getId())) return file;
  }
  throw new Error("ドキュメントが見つかりません");
}

export function getDocumentList(folderId: string): MdDocument[] {
  requireMember();
  const driveFolderId = getDriveFolderId(folderId);
  const driveFolder = DriveApp.getFolderById(driveFolderId);
  // Identify documents by the .md extension rather than by MIME type. Files we
  // create are text/plain, but .md files uploaded into the folder externally are
  // often registered by Drive as text/markdown, so a MIME filter would silently
  // hide them. The .md name is the one trait both share.
  const files = driveFolder.getFiles();

  const threadSheet = getSheet(SHEETS.THREADS);
  const threadRows = sheetData(threadSheet);

  const metaMap = getDocMetaMap();
  const statuses = getStatuses();
  const validStatusIds = new Set(statuses.map((s) => s.id));
  const defaultStatusId = statuses[0] ? statuses[0].id : "";

  const docs: MdDocument[] = [];
  while (files.hasNext()) {
    const file = files.next();
    if (!/\.md$/i.test(file.getName())) continue;
    const id = file.getId();
    const openCount = threadRows.filter(
      (r) => r[THREAD_COLS.DOCUMENT_ID] === id && r[THREAD_COLS.STATUS] === "open"
    ).length;
    const meta = metaMap[id];
    // Fall back to the first status when unset or when the saved status was deleted.
    const statusId = meta && validStatusIds.has(meta.statusId) ? meta.statusId : defaultStatusId;
    docs.push({
      id,
      name: file.getName().replace(/\.md$/i, ""),
      folderId,
      folderName: driveFolder.getName(),
      lastUpdated: file.getLastUpdated().getTime(),
      openThreadCount: openCount,
      statusId,
      archived: meta ? meta.archived : false,
      assignee: meta ? meta.assignee : "",
    });
  }
  return docs.sort((a, b) => b.lastUpdated - a.lastUpdated);
}

export function getDocument(fileId: string): { content: string; lastUpdated: number } {
  requireMember();
  const file = getManagedFile(fileId);
  return {
    content: file.getBlob().getDataAsString("UTF-8"),
    lastUpdated: file.getLastUpdated().getTime(),
  };
}

/**
 * Opening a document needs both its body and its comment threads. Bundling them
 * into one call halves the `google.script.run` round trips (each carries fixed
 * GAS dispatch overhead) and does the workspace authorization check (getManagedFile)
 * once instead of once per call.
 */
export function getDocumentBundle(
  fileId: string,
): { content: string; lastUpdated: number; threads: CommentThread[]; pendingRevision: PendingRevision | null } {
  const email = requireMember();
  const file = getManagedFile(fileId);
  return {
    content: file.getBlob().getDataAsString("UTF-8"),
    lastUpdated: file.getLastUpdated().getTime(),
    threads: collectThreadsForDocument(fileId),
    // Surface any unsaved AI-revision draft so reopening the doc resumes it.
    pendingRevision: readPendingRevision(fileId, email),
  };
}

export function createDocument(folderId: string, title: string): MdDocument {
  return withLock(() => {
    requireMember();
    const driveFolderId = getDriveFolderId(folderId);
    const driveFolder = DriveApp.getFolderById(driveFolderId);
    const content = `# ${title}\n\n`;
    const blob = Utilities.newBlob(content, "text/plain", `${title}.md`);
    const file = driveFolder.createFile(blob);
    // New documents start in the first status; no DOC_META row is needed since
    // getDocumentList falls back to the first status when none is recorded.
    const statuses = getStatuses();
    return {
      id: file.getId(),
      name: title,
      folderId,
      folderName: driveFolder.getName(),
      lastUpdated: file.getLastUpdated().getTime(),
      openThreadCount: 0,
      statusId: statuses[0] ? statuses[0].id : "",
      archived: false,
      assignee: "",
    };
  });
}

const MAX_IMPORT_FILES = 20;
// Generous cap for Markdown (which is text): bounds the single google.script.run
// payload and keeps each Drive write quick. .md is sent as a plain string (no Base64).
const MAX_IMPORT_FILE_CHARS = 2_000_000;
const IMPORT_EXT_RE = /\.(?:md|markdown)$/i;

/**
 * Imports uploaded Markdown files into a folder as documents. Each file is validated
 * (extension + size) and written to the folder's Drive directory; a duplicate title is
 * auto-renamed "name (2)", "name (3)", … so nothing is overwritten. No doc_meta row is
 * needed (getDocumentList falls back to the first status, same as createDocument).
 * Returns a per-file result so the client can report partial success.
 */
export function importDocuments(
  folderId: string,
  files: { name: string; content: string }[],
): { name: string; ok: boolean; docName?: string; id?: string; error?: string }[] {
  requireMember();
  if (!Array.isArray(files) || files.length === 0) throw new Error("ファイルがありません。");
  if (files.length > MAX_IMPORT_FILES) {
    throw new Error(`一度に取り込めるのは ${MAX_IMPORT_FILES} ファイルまでです。`);
  }
  const driveFolder = DriveApp.getFolderById(getDriveFolderId(folderId));

  return files.map((f) => {
    const name = String((f && f.name) || "").trim();
    const content = String((f && f.content) || "");
    try {
      if (!IMPORT_EXT_RE.test(name)) throw new Error("拡張子は .md / .markdown のみ対応しています。");
      if (content.length > MAX_IMPORT_FILE_CHARS) {
        throw new Error(`ファイルが大きすぎます（${MAX_IMPORT_FILE_CHARS.toLocaleString()}字まで）。`);
      }
      const base = name.replace(IMPORT_EXT_RE, "").trim() || "untitled";
      // Resolve the unique name and create the file under one lock so two concurrent
      // imports can't both claim the same "name (2)".
      const created = withLock(() => {
        const title = uniqueDocTitle(driveFolder, base);
        const blob = Utilities.newBlob(content, "text/plain", `${title}.md`);
        return { id: driveFolder.createFile(blob).getId(), title };
      });
      return { name, ok: true, docName: created.title, id: created.id };
    } catch (e) {
      return { name, ok: false, error: String((e && (e as Error).message) || e) };
    }
  });
}

// Returns `base`, or `base (2)`/`base (3)`/… if `<name>.md` already exists in the folder.
function uniqueDocTitle(folder: GoogleAppsScript.Drive.Folder, base: string): string {
  let candidate = base;
  let n = 2;
  while (folder.getFilesByName(`${candidate}.md`).hasNext()) {
    candidate = `${base} (${n})`;
    n++;
  }
  return candidate;
}

/**
 * Saves `content`. If `expectedLastUpdated` is provided (non-zero) and the file
 * has been modified since then by someone else, the save is rejected with a
 * CONFLICT error so the client can let the user reload or overwrite. Returns the
 * new last-updated timestamp so the client can keep tracking it.
 */
export function updateDocument(fileId: string, content: string, expectedLastUpdated?: number): number {
  return withLock(() => {
    requireMember();
    const file = getManagedFile(fileId);
    if (expectedLastUpdated && file.getLastUpdated().getTime() > Number(expectedLastUpdated)) {
      throw new Error("CONFLICT: 他のユーザーがこのドキュメントを更新しました");
    }
    file.setContent(content);
    return DriveApp.getFileById(fileId).getLastUpdated().getTime();
  });
}

export function deleteDocument(fileId: string): void {
  withLock(() => {
    requireMember();
    getManagedFile(fileId).setTrashed(true);
  });
}

export function getDocumentName(fileId: string): string {
  return DriveApp.getFileById(fileId).getName().replace(/\.md$/, "");
}

// ─── Comment Threads ─────────────────────────────────────────────────────────

export function getThreadsForDocument(documentId: string): CommentThread[] {
  requireMember();
  getManagedFile(documentId); // ensure the document belongs to this workspace
  return collectThreadsForDocument(documentId);
}

// Core thread assembly, factored out so getDocumentBundle can reuse it without
// repeating the requireMember/getManagedFile guards its callers already run.
function collectThreadsForDocument(documentId: string): CommentThread[] {
  const tSheet = getSheet(SHEETS.THREADS);
  const cSheet = getSheet(SHEETS.COMMENTS);
  const members = getMembers();

  const threadRows = sheetData(tSheet).filter((r) => r[THREAD_COLS.DOCUMENT_ID] === documentId);
  const allCommentRows = sheetData(cSheet);

  return threadRows.map((tr) => {
    const threadId = tr[THREAD_COLS.THREAD_ID]!;
    const comments: Comment[] = allCommentRows
      .filter((cr) => cr[COMMENT_COLS.THREAD_ID] === threadId && cr[COMMENT_COLS.DELETED] !== "true")
      .map((cr) => ({
        commentId: cr[COMMENT_COLS.COMMENT_ID]!,
        threadId,
        content: cr[COMMENT_COLS.CONTENT]!,
        author: cr[COMMENT_COLS.AUTHOR]!,
        authorName: getMemberDisplayName(cr[COMMENT_COLS.AUTHOR]!, members),
        mentions: cr[COMMENT_COLS.MENTIONS] ? cr[COMMENT_COLS.MENTIONS]!.split(",").filter(Boolean) : [],
        createdAt: cr[COMMENT_COLS.CREATED_AT]!,
        updatedAt: cr[COMMENT_COLS.UPDATED_AT]!,
      }));

    return {
      threadId,
      documentId,
      anchor: {
        selectedText: tr[THREAD_COLS.ANCHOR_TEXT]!,
        contextBefore: tr[THREAD_COLS.ANCHOR_BEFORE]!,
        contextAfter: tr[THREAD_COLS.ANCHOR_AFTER]!,
      },
      status: (tr[THREAD_COLS.STATUS] as "open" | "resolved") ?? "open",
      createdBy: tr[THREAD_COLS.CREATED_BY]!,
      createdAt: tr[THREAD_COLS.CREATED_AT]!,
      resolvedBy: tr[THREAD_COLS.RESOLVED_BY]!,
      resolvedAt: tr[THREAD_COLS.RESOLVED_AT]!,
      comments,
    };
  });
}

export function createThread(
  documentId: string,
  anchorText: string,
  anchorBefore: string,
  anchorAfter: string,
  firstComment: string,
  mentions: string[]
): CommentThread {
  return withLock(() => {
    const author = requireMember();
    // Ensure the thread targets a document inside the workspace.
    getManagedFile(documentId);
    const members = getMembers();
    const threadId = uuid();
    const commentId = uuid();
    const ts = now();
    const docName = getDocumentName(documentId);

    const tSheet = getSheet(SHEETS.THREADS);
    tSheet.appendRow([threadId, documentId, anchorText, anchorBefore, anchorAfter, "open", author, ts, "", ""]);

    const cSheet = getSheet(SHEETS.COMMENTS);
    cSheet.appendRow([commentId, threadId, firstComment, author, mentions.join(","), ts, ts, "false"]);

    createMentionNotifications(mentions, commentId, threadId, documentId, docName, firstComment, author, members);

    return {
      threadId,
      documentId,
      anchor: { selectedText: anchorText, contextBefore: anchorBefore, contextAfter: anchorAfter },
      status: "open",
      createdBy: author,
      createdAt: ts,
      resolvedBy: "",
      resolvedAt: "",
      comments: [
        {
          commentId,
          threadId,
          content: firstComment,
          author,
          authorName: getMemberDisplayName(author, members),
          mentions,
          createdAt: ts,
          updatedAt: ts,
        },
      ],
    };
  });
}

export function addReply(threadId: string, content: string, mentions: string[]): Comment {
  return withLock(() => {
    const author = requireMember();
    const members = getMembers();
    const commentId = uuid();
    const ts = now();

    const cSheet = getSheet(SHEETS.COMMENTS);
    cSheet.appendRow([commentId, threadId, content, author, mentions.join(","), ts, ts, "false"]);

    const tSheet = getSheet(SHEETS.THREADS);
    const threadRows = sheetData(tSheet);
    const tIdx = threadRows.findIndex((r) => r[THREAD_COLS.THREAD_ID] === threadId);
    const documentId = tIdx !== -1 ? (threadRows[tIdx]![THREAD_COLS.DOCUMENT_ID] ?? "") : "";
    const docName = documentId ? getDocumentName(documentId) : "";

    createMentionNotifications(mentions, commentId, threadId, documentId, docName, content, author, members);
    createReplyNotifications(threadId, commentId, documentId, docName, content, author, members);

    return {
      commentId,
      threadId,
      content,
      author,
      authorName: getMemberDisplayName(author, members),
      mentions,
      createdAt: ts,
      updatedAt: ts,
    };
  });
}

export function editComment(commentId: string, newContent: string): void {
  withLock(() => {
    const user = requireMember();
    const cSheet = getSheet(SHEETS.COMMENTS);
    const rows = sheetData(cSheet);
    const idx = rows.findIndex((r) => r[COMMENT_COLS.COMMENT_ID] === commentId);
    if (idx === -1) throw new Error("Comment not found");
    const row = rows[idx]!;
    if (row[COMMENT_COLS.AUTHOR] !== user && !isOwner(user)) {
      throw new Error("自分のコメントのみ編集できます。");
    }

    const oldMentions = row[COMMENT_COLS.MENTIONS] ? row[COMMENT_COLS.MENTIONS]!.split(",").filter(Boolean) : [];
    const newMentions = parseMentions(newContent);

    cSheet.getRange(idx + 1, COMMENT_COLS.CONTENT + 1).setValue(newContent);
    cSheet.getRange(idx + 1, COMMENT_COLS.UPDATED_AT + 1).setValue(now());
    cSheet.getRange(idx + 1, COMMENT_COLS.MENTIONS + 1).setValue(newMentions.join(","));

    // Notify only people newly mentioned by this edit.
    const added = newMentions.filter((m) => !oldMentions.includes(m));
    if (added.length > 0) {
      const threadId = row[COMMENT_COLS.THREAD_ID]!;
      const tSheet = getSheet(SHEETS.THREADS);
      const tRow = sheetData(tSheet).find((r) => r[THREAD_COLS.THREAD_ID] === threadId);
      const documentId = tRow ? (tRow[THREAD_COLS.DOCUMENT_ID] ?? "") : "";
      const docName = documentId ? getDocumentName(documentId) : "";
      createMentionNotifications(added, commentId, threadId, documentId, docName, newContent, user, getMembers());
    }
  });
}

export function deleteComment(commentId: string): void {
  withLock(() => {
    const user = requireMember();
    const cSheet = getSheet(SHEETS.COMMENTS);
    const rows = sheetData(cSheet);
    const idx = rows.findIndex((r) => r[COMMENT_COLS.COMMENT_ID] === commentId);
    if (idx === -1) throw new Error("Comment not found");
    if (rows[idx]![COMMENT_COLS.AUTHOR] !== user && !isOwner(user)) {
      throw new Error("自分のコメントのみ削除できます。");
    }
    cSheet.getRange(idx + 1, COMMENT_COLS.DELETED + 1).setValue("true");
  });
}

export function resolveThread(threadId: string): void {
  withLock(() => {
    const user = requireMember();
    const sheet = getSheet(SHEETS.THREADS);
    const rows = sheetData(sheet);
    const idx = rows.findIndex((r) => r[THREAD_COLS.THREAD_ID] === threadId);
    if (idx === -1) throw new Error("Thread not found");
    const ts = now();
    sheet.getRange(idx + 1, THREAD_COLS.STATUS + 1).setValue("resolved");
    sheet.getRange(idx + 1, THREAD_COLS.RESOLVED_BY + 1).setValue(user);
    sheet.getRange(idx + 1, THREAD_COLS.RESOLVED_AT + 1).setValue(ts);

    const documentId = rows[idx]![THREAD_COLS.DOCUMENT_ID] ?? "";
    const docName = documentId ? getDocumentName(documentId) : "";
    const members = getMembers();
    createResolveNotifications(threadId, documentId, docName, user, members);
  });
}

export function reopenThread(threadId: string): void {
  withLock(() => {
    requireMember();
    const sheet = getSheet(SHEETS.THREADS);
    const rows = sheetData(sheet);
    const idx = rows.findIndex((r) => r[THREAD_COLS.THREAD_ID] === threadId);
    if (idx === -1) throw new Error("Thread not found");
    sheet.getRange(idx + 1, THREAD_COLS.STATUS + 1).setValue("open");
    sheet.getRange(idx + 1, THREAD_COLS.RESOLVED_BY + 1).setValue("");
    sheet.getRange(idx + 1, THREAD_COLS.RESOLVED_AT + 1).setValue("");
  });
}

// ─── Members ─────────────────────────────────────────────────────────────────

export function getMembers(): Member[] {
  const cached = cacheGet<Member[]>(CACHE_KEYS.MEMBERS);
  if (cached) return cached;
  const sheet = getSheet(SHEETS.MEMBERS);
  const members = sheetData(sheet).map((r) => ({
    email: r[MEMBER_COLS.EMAIL]!,
    displayName: r[MEMBER_COLS.DISPLAY_NAME]!,
    addedAt: r[MEMBER_COLS.ADDED_AT]!,
    addedBy: r[MEMBER_COLS.ADDED_BY]!,
  }));
  cachePut(CACHE_KEYS.MEMBERS, members);
  return members;
}

export function addMember(email: string, displayName: string): Member {
  return withLock(() => {
    const by = requireMember();
    const existing = getMembers().find((m) => m.email === email);
    if (existing) throw new Error("Member already exists");
    const ts = now();
    const sheet = getSheet(SHEETS.MEMBERS);
    sheet.appendRow([email, displayName, ts, by]);
    cacheRemove(CACHE_KEYS.MEMBERS);
    return { email, displayName, addedAt: ts, addedBy: by };
  });
}

export function updateMember(email: string, displayName: string): void {
  withLock(() => {
    requireMember();
    const sheet = getSheet(SHEETS.MEMBERS);
    const rows = sheetData(sheet);
    const idx = rows.findIndex((r) => r[MEMBER_COLS.EMAIL] === email);
    if (idx === -1) throw new Error("Member not found");
    sheet.getRange(idx + 1, MEMBER_COLS.DISPLAY_NAME + 1).setValue(displayName);
    cacheRemove(CACHE_KEYS.MEMBERS);
  });
}

export function removeMember(email: string): void {
  withLock(() => {
    requireMember();
    const sheet = getSheet(SHEETS.MEMBERS);
    const rows = sheetData(sheet);
    const idx = rows.findIndex((r) => r[MEMBER_COLS.EMAIL] === email);
    if (idx === -1) throw new Error("Member not found");
    sheet.deleteRow(idx + 1);
    cacheRemove(CACHE_KEYS.MEMBERS);
  });
}

// ─── Notifications ────────────────────────────────────────────────────────────

export function getNotifications(): Notification[] {
  const user = requireMember();
  const sheet = getSheet(SHEETS.NOTIFICATIONS);
  return sheetData(sheet)
    .filter((r) => r[NOTIF_COLS.RECIPIENT] === user)
    .map((r) => ({
      notifId: r[NOTIF_COLS.NOTIF_ID]!,
      recipient: r[NOTIF_COLS.RECIPIENT]!,
      type: r[NOTIF_COLS.TYPE] as Notification["type"],
      threadId: r[NOTIF_COLS.THREAD_ID]!,
      commentId: r[NOTIF_COLS.COMMENT_ID]!,
      documentId: r[NOTIF_COLS.DOCUMENT_ID]!,
      documentName: r[NOTIF_COLS.DOCUMENT_NAME]!,
      isRead: r[NOTIF_COLS.IS_READ] === "true",
      createdAt: r[NOTIF_COLS.CREATED_AT]!,
      message: r[NOTIF_COLS.MESSAGE]!,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 100); // only surface the most recent notifications
}

export function markNotificationRead(notifId: string): void {
  withLock(() => {
    const user = requireMember();
    const sheet = getSheet(SHEETS.NOTIFICATIONS);
    const rows = sheetData(sheet);
    const idx = rows.findIndex((r) => r[NOTIF_COLS.NOTIF_ID] === notifId);
    if (idx === -1) return;
    // Only the recipient may mark their own notification read.
    if (rows[idx]![NOTIF_COLS.RECIPIENT] !== user) return;
    sheet.getRange(idx + 1, NOTIF_COLS.IS_READ + 1).setValue("true");
  });
}

export function markAllNotificationsRead(): void {
  withLock(() => {
    const user = requireMember();
    const sheet = getSheet(SHEETS.NOTIFICATIONS);
    const rows = sheetData(sheet);
    if (rows.length === 0) return;
    // Build the whole IS_READ column once and write it back in a single call.
    const col = rows.map((r) => [
      r[NOTIF_COLS.RECIPIENT] === user ? "true" : r[NOTIF_COLS.IS_READ] || "false",
    ]);
    sheet.getRange(1, NOTIF_COLS.IS_READ + 1, col.length, 1).setValues(col);
  });
}

// Keep the notifications sheet bounded. Rows are appended chronologically, so
// the oldest live at the top. When the sheet exceeds the hard cap we trim back
// down to the soft cap in one batch delete. Always called inside withLock.
const NOTIF_HARD_CAP = 2000;
const NOTIF_SOFT_CAP = 1000;

/** Append several notification rows in a single setValues call. */
function appendNotificationRows(rows: string[][]): void {
  if (rows.length === 0) return;
  const sheet = getSheet(SHEETS.NOTIFICATIONS);
  const start = sheet.getLastRow() + 1;
  sheet.getRange(start, 1, rows.length, rows[0]!.length).setValues(rows);
  trimNotifications(sheet);
}

function trimNotifications(sheet: GoogleAppsScript.Spreadsheet.Sheet): void {
  const total = sheet.getLastRow();
  if (total <= NOTIF_HARD_CAP) return;
  sheet.deleteRows(1, total - NOTIF_SOFT_CAP);
}

function notificationRow(
  recipient: string,
  type: Notification["type"],
  threadId: string,
  commentId: string,
  documentId: string,
  documentName: string,
  message: string
): string[] {
  return [uuid(), recipient, type, threadId, commentId, documentId, documentName, "false", now(), message];
}

function createMentionNotifications(
  mentions: string[],
  commentId: string,
  threadId: string,
  documentId: string,
  docName: string,
  content: string,
  author: string,
  members: Member[]
): void {
  const authorName = getMemberDisplayName(author, members);
  const preview = content.length > 50 ? content.substring(0, 50) + "…" : content;
  const rows = mentions
    .filter((email) => email !== author)
    .map((email) =>
      notificationRow(email, "mention", threadId, commentId, documentId, docName, `${authorName} がメンションしました: "${preview}"`)
    );
  appendNotificationRows(rows);
}

function createReplyNotifications(
  threadId: string,
  commentId: string,
  documentId: string,
  docName: string,
  content: string,
  author: string,
  members: Member[]
): void {
  const authorName = getMemberDisplayName(author, members);
  const preview = content.length > 50 ? content.substring(0, 50) + "…" : content;
  const cSheet = getSheet(SHEETS.COMMENTS);
  const rows = sheetData(cSheet).filter((r) => r[COMMENT_COLS.THREAD_ID] === threadId && r[COMMENT_COLS.DELETED] !== "true");
  const participants = [...new Set(rows.map((r) => r[COMMENT_COLS.AUTHOR]!))].filter((e) => e !== author);
  appendNotificationRows(
    participants.map((email) =>
      notificationRow(email, "reply", threadId, commentId, documentId, docName, `${authorName} が返信しました: "${preview}"`)
    )
  );
}

function createResolveNotifications(
  threadId: string,
  documentId: string,
  docName: string,
  resolver: string,
  members: Member[]
): void {
  const resolverName = getMemberDisplayName(resolver, members);
  const cSheet = getSheet(SHEETS.COMMENTS);
  const rows = sheetData(cSheet).filter((r) => r[COMMENT_COLS.THREAD_ID] === threadId && r[COMMENT_COLS.DELETED] !== "true");
  const participants = [...new Set(rows.map((r) => r[COMMENT_COLS.AUTHOR]!))].filter((e) => e !== resolver);
  appendNotificationRows(
    participants.map((email) =>
      notificationRow(email, "resolve", threadId, "", documentId, docName, `${resolverName} がスレッドを解決済みにしました`)
    )
  );
}

// ─── AI review (multi-provider) ──────────────────────────────────────────────────
//
// Reviews go through one of several LLM providers (Claude / OpenAI / Gemini), chosen
// per user. Each member registers their own API key per provider. Because the web app
// runs as the deployer (executeAs USER_DEPLOYING), PropertiesService.getUserProperties()
// would return the deployer's store for everyone — so per-user, per-provider keys are
// namespaced by the active user's email inside ScriptProperties instead. Keys are never
// returned to the client; only whether one is set. Document content is sent to the chosen
// provider's API, so review is strictly opt-in (the user must register a key first).

type AiProvider = "claude" | "openai" | "gemini";
const AI_PROVIDERS: AiProvider[] = ["claude", "openai", "gemini"];
const DEFAULT_AI_PROVIDER: AiProvider = "claude";

// Default model per provider when the user hasn't picked one. Model names change over
// time, so the settings UI lets the user override these with any current model id.
// (Claude default follows Anthropic's current flagship; OpenAI/Gemini defaults are
// starting points the user is expected to confirm against each provider's model list.)
const DEFAULT_MODELS: { [p in AiProvider]: string } = {
  claude: "claude-opus-4-8",
  openai: "gpt-4o",
  gemini: "gemini-2.5-flash",
};

// Guard against oversized payloads / runaway token use on very large documents.
const MAX_REVIEW_CHARS = 100000;

// Revision rewrites the *whole* document, so the output is as large as the input.
// Cap the input well below the review limit to keep the single (non-streaming) GAS
// request within output-token and execution-time bounds. Oversized docs are
// refused, not truncated — truncating a rewrite would silently delete content.
const MAX_REVISE_CHARS = 30000;

function toProvider(value: unknown): AiProvider {
  const v = String(value || "");
  return (AI_PROVIDERS as string[]).includes(v) ? (v as AiProvider) : DEFAULT_AI_PROVIDER;
}

function aiProviderProp(email: string): string {
  return `ai:provider:${email}`;
}
function aiKeyProp(provider: AiProvider, email: string): string {
  return `ai:key:${provider}:${email}`;
}
function aiModelProp(provider: AiProvider, email: string): string {
  return `ai:model:${provider}:${email}`;
}

// GitHub PAT for repo-grounded review (Claude MCP connector). Per-user by default
// (gh:pat:<email>); a single owner-set shared token (gh:pat:shared) is the fallback
// when a user has none — so admin-run and admin-less workspaces use the same mechanism.
// The target repo (owner/name) is a single workspace setting, overridable per review.
function githubPatUserProp(email: string): string {
  return `gh:pat:${email}`;
}
const GITHUB_PAT_SHARED_PROP = "gh:pat:shared";
const GITHUB_REPO_PROP = "gh:repo";
const GITHUB_REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/** Resolve the PAT to use for `email`: their own first, else the shared one, else "". */
function resolveGithubPat(email: string): string {
  const props = PropertiesService.getScriptProperties();
  return props.getProperty(githubPatUserProp(email)) || props.getProperty(GITHUB_PAT_SHARED_PROP) || "";
}

interface AiSettings {
  provider: AiProvider;
  // Per-provider key presence + model, so the settings UI can show every provider's
  // state and the user can keep keys registered for more than one at a time.
  providers: { [p in AiProvider]: { hasKey: boolean; model: string } };
  // GitHub repo-grounded review config. Tokens themselves are never returned.
  github: { hasUserPat: boolean; hasSharedPat: boolean; repo: string; isOwner: boolean };
}

/** Returns the active user's AI settings. Never includes any key itself. */
export function getAiSettings(): AiSettings {
  const email = requireMember();
  const props = PropertiesService.getScriptProperties();
  const providers = {} as AiSettings["providers"];
  for (const p of AI_PROVIDERS) {
    providers[p] = {
      hasKey: !!props.getProperty(aiKeyProp(p, email)),
      model: props.getProperty(aiModelProp(p, email)) || DEFAULT_MODELS[p],
    };
  }
  return {
    provider: toProvider(props.getProperty(aiProviderProp(email))),
    providers,
    github: {
      hasUserPat: !!props.getProperty(githubPatUserProp(email)),
      hasSharedPat: !!props.getProperty(GITHUB_PAT_SHARED_PROP),
      repo: props.getProperty(GITHUB_REPO_PROP) || "",
      isOwner: isOwner(email),
    },
  };
}

/**
 * Saves a GitHub PAT for repo-grounded review. `scope` is "user" (the caller's own,
 * namespaced by email) or "shared" (a single workspace token; owner only). An empty
 * `pat` is rejected — use clearGithubPat to remove. Tokens are never returned to clients.
 */
export function saveGithubPat(scope: string, pat: string): AiSettings {
  const email = requireMember();
  const token = String(pat || "").trim();
  if (!token) throw new Error("PAT を入力してください。");
  const props = PropertiesService.getScriptProperties();
  if (scope === "shared") {
    if (!isOwner(email)) throw new Error("共有 PAT を設定できるのはオーナーのみです。");
    props.setProperty(GITHUB_PAT_SHARED_PROP, token);
  } else {
    props.setProperty(githubPatUserProp(email), token);
  }
  return getAiSettings();
}

/** Removes a stored GitHub PAT. `scope` is "user" (own) or "shared" (owner only). */
export function clearGithubPat(scope: string): AiSettings {
  const email = requireMember();
  const props = PropertiesService.getScriptProperties();
  if (scope === "shared") {
    if (!isOwner(email)) throw new Error("共有 PAT を削除できるのはオーナーのみです。");
    props.deleteProperty(GITHUB_PAT_SHARED_PROP);
  } else {
    props.deleteProperty(githubPatUserProp(email));
  }
  return getAiSettings();
}

/** Sets the default target repo (owner/name) for repo-grounded review. Owner only; empty clears. */
export function saveGithubRepo(repo: string): AiSettings {
  const email = requireMember();
  if (!isOwner(email)) throw new Error("対象リポジトリを設定できるのはオーナーのみです。");
  const value = String(repo || "").trim();
  if (value && !GITHUB_REPO_RE.test(value)) {
    throw new Error("リポジトリは owner/name の形式で入力してください（例: plzsave/md-collab）。");
  }
  const props = PropertiesService.getScriptProperties();
  if (value) props.setProperty(GITHUB_REPO_PROP, value);
  else props.deleteProperty(GITHUB_REPO_PROP);
  return getAiSettings();
}

/**
 * Saves the active provider and that provider's key/model. An empty `apiKey` keeps the
 * existing key (so the user can change the model or switch providers without re-entering
 * a key). Keys for other providers are left untouched.
 */
export function saveAiSettings(provider: string, apiKey: string, model: string): AiSettings {
  const email = requireMember();
  const p = toProvider(provider);
  const props = PropertiesService.getScriptProperties();
  props.setProperty(aiProviderProp(email), p);
  const trimmedKey = String(apiKey || "").trim();
  if (trimmedKey) props.setProperty(aiKeyProp(p, email), trimmedKey);
  props.setProperty(aiModelProp(p, email), String(model || "").trim() || DEFAULT_MODELS[p]);
  return getAiSettings();
}

/** Removes the active user's stored key for one provider. */
export function clearAiKey(provider: string): AiSettings {
  const email = requireMember();
  PropertiesService.getScriptProperties().deleteProperty(aiKeyProp(toProvider(provider), email));
  return getAiSettings();
}

/** Whether the active user's currently-selected provider has a key (drives the UI gate). */
function hasActiveAiKey(email: string): boolean {
  const props = PropertiesService.getScriptProperties();
  const provider = toProvider(props.getProperty(aiProviderProp(email)));
  return !!props.getProperty(aiKeyProp(provider, email));
}

/** Map a provider's HTTP error to an actionable Japanese message. `detail` is the API's own message. */
function aiHttpError(label: string, code: number, model: string, detail: string): Error {
  if (code === 400 || code === 401 || code === 403) {
    return new Error(`${label} API エラー: ${detail || "APIキーまたはモデル名を確認してください。"}`);
  }
  if (code === 404) {
    return new Error(`モデル "${model}" が見つかりません。設定でモデル名を確認してください。`);
  }
  if (code === 413) {
    return new Error(`${label} API: ドキュメントが大きすぎます。内容を分割してお試しください。`);
  }
  if (code === 429) {
    return new Error(`${label} API のレート上限に達しました。しばらくしてからお試しください。`);
  }
  return new Error(`${label} API エラー (${code}): ${detail || "不明なエラー"}`);
}

/** Best-effort extraction of a provider's own error message from a JSON body. */
function extractApiError(body: string): string {
  try {
    return JSON.parse(body)?.error?.message || "";
  } catch (e) {
    return "";
  }
}

function fetchJson(label: string, url: string, options: GoogleAppsScript.URL_Fetch.URLFetchRequestOptions): { code: number; body: string } {
  let res: GoogleAppsScript.URL_Fetch.HTTPResponse;
  try {
    res = UrlFetchApp.fetch(url, options);
  } catch (e) {
    throw new Error(`${label} API への接続に失敗しました。`);
  }
  return { code: res.getResponseCode(), body: res.getContentText() };
}

// Anthropic Messages API. The stable reviewer instructions go in `system` (with a
// cache_control breakpoint so they can be cached across reviews); the per-review
// document + extra instructions go in the user turn, keeping the cacheable prefix
// byte-stable. Caching only actually engages once the cached prefix exceeds the
// model's minimum (~4096 tokens for Opus), so for a short system prompt this is a
// no-op today — it pays off only if the reviewer prompt grows large.
function reviewWithClaude(apiKey: string, model: string, systemText: string, userText: string, maxTokens = 8192): string {
  const { code, body } = fetchJson("Claude", "https://api.anthropic.com/v1/messages", {
    method: "post",
    contentType: "application/json",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    payload: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: [{ type: "text", text: systemText, cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: userText }],
    }),
    muteHttpExceptions: true,
  });
  if (code !== 200) throw aiHttpError("Claude", code, model, extractApiError(body));
  let json: { content?: { type?: string; text?: string }[] };
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error("Claude API のレスポンスを解析できませんでした。");
  }
  return (json.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text || "")
    .join("")
    .trim();
}

// OpenAI Chat Completions. Body is kept minimal (model + messages) so it stays
// compatible across model families that differ on optional parameters.
function reviewWithOpenAI(apiKey: string, model: string, systemText: string, userText: string): string {
  const { code, body } = fetchJson("OpenAI", "https://api.openai.com/v1/chat/completions", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: `Bearer ${apiKey}` },
    payload: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemText },
        { role: "user", content: userText },
      ],
    }),
    muteHttpExceptions: true,
  });
  if (code !== 200) throw aiHttpError("OpenAI", code, model, extractApiError(body));
  let json: { choices?: { message?: { content?: string } }[] };
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error("OpenAI API のレスポンスを解析できませんでした。");
  }
  return (json.choices?.[0]?.message?.content || "").trim();
}

// Google Gemini generateContent.
function reviewWithGemini(apiKey: string, model: string, systemText: string, userText: string): string {
  const endpoint = "https://generativelanguage.googleapis.com/v1beta/models";
  const { code, body } = fetchJson("Gemini", `${endpoint}/${encodeURIComponent(model)}:generateContent`, {
    method: "post",
    contentType: "application/json",
    headers: { "x-goog-api-key": apiKey },
    payload: JSON.stringify({
      systemInstruction: { parts: [{ text: systemText }] },
      contents: [{ role: "user", parts: [{ text: userText }] }],
    }),
    muteHttpExceptions: true,
  });
  if (code !== 200) throw aiHttpError("Gemini", code, model, extractApiError(body));
  let json: { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  try {
    json = JSON.parse(body);
  } catch (e) {
    throw new Error("Gemini API のレスポンスを解析できませんでした。");
  }
  return (json.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text || "")
    .join("")
    .trim();
}

// ─── Model discovery ─────────────────────────────────────────────────────────
//
// Each provider exposes a "list models" endpoint. We surface the result as
// suggestions in the settings UI so users can pick a currently-valid model id
// instead of guessing — model names change over time, so this is fetched live
// with the user's own key rather than hardcoded.

/** Lists chat-capable model ids the active user's stored key can use for `provider`. */
export function listAiModels(provider: string): string[] {
  const email = requireMember();
  const p = toProvider(provider);
  const apiKey = PropertiesService.getScriptProperties().getProperty(aiKeyProp(p, email));
  if (!apiKey) {
    throw new Error("先に該当プロバイダのAPIキーを保存してください。");
  }
  if (p === "claude") return listClaudeModels(apiKey);
  if (p === "openai") return listOpenAiModels(apiKey);
  return listGeminiModels(apiKey);
}

function listClaudeModels(apiKey: string): string[] {
  const { code, body } = fetchJson("Claude", "https://api.anthropic.com/v1/models?limit=1000", {
    method: "get",
    headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    muteHttpExceptions: true,
  });
  if (code !== 200) throw aiHttpError("Claude", code, "", extractApiError(body));
  const json = JSON.parse(body) as { data?: { id?: string }[] };
  return (json.data ?? []).map((m) => m.id || "").filter(Boolean);
}

function listOpenAiModels(apiKey: string): string[] {
  const { code, body } = fetchJson("OpenAI", "https://api.openai.com/v1/models", {
    method: "get",
    headers: { Authorization: `Bearer ${apiKey}` },
    muteHttpExceptions: true,
  });
  if (code !== 200) throw aiHttpError("OpenAI", code, "", extractApiError(body));
  const json = JSON.parse(body) as { data?: { id?: string }[] };
  // Best-effort filter to chat-capable models — the list also includes embedding,
  // tts, whisper, moderation, and image models that can't do chat completions.
  return (json.data ?? [])
    .map((m) => m.id || "")
    .filter((id) => /^(gpt|o\d|chatgpt)/i.test(id))
    .sort();
}

function listGeminiModels(apiKey: string): string[] {
  const { code, body } = fetchJson("Gemini", "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
    method: "get",
    headers: { "x-goog-api-key": apiKey },
    muteHttpExceptions: true,
  });
  if (code !== 200) throw aiHttpError("Gemini", code, "", extractApiError(body));
  const json = JSON.parse(body) as { models?: { name?: string; supportedGenerationMethods?: string[] }[] };
  // Keep only models that support generateContent (what reviewWithGemini calls),
  // and strip the "models/" prefix so the value matches what the UI expects.
  return (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods || []).indexOf("generateContent") !== -1)
    .map((m) => (m.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

/** Dispatch one chat completion to the active provider. `claudeMaxTokens` only applies to Claude. */
function callProvider(
  provider: AiProvider,
  apiKey: string,
  model: string,
  systemText: string,
  userText: string,
  claudeMaxTokens?: number,
): string {
  if (provider === "claude") return reviewWithClaude(apiKey, model, systemText, userText, claudeMaxTokens);
  if (provider === "openai") return reviewWithOpenAI(apiKey, model, systemText, userText);
  return reviewWithGemini(apiKey, model, systemText, userText);
}

/**
 * Sends a managed document's Markdown to the user's chosen provider and returns a
 * review. `instructions` is optional extra guidance from the user (e.g. "API仕様の整合性を
 * 重点的に"). The provider, key, and model are read from the active user's stored settings.
 */
export function reviewDocument(
  fileId: string,
  instructions: string,
): { review: string; provider: string; model: string; createdAt: string; createdByName: string } {
  const email = requireMember();
  const props = PropertiesService.getScriptProperties();
  const provider = toProvider(props.getProperty(aiProviderProp(email)));
  const apiKey = props.getProperty(aiKeyProp(provider, email));
  if (!apiKey) {
    throw new Error("APIキーが登録されていません。設定から登録してください。");
  }
  const model = props.getProperty(aiModelProp(provider, email)) || DEFAULT_MODELS[provider];

  const file = getManagedFile(fileId);
  const name = file.getName().replace(/\.md$/i, "");
  let content = file.getBlob().getDataAsString("UTF-8");
  let truncatedNote = "";
  if (content.length > MAX_REVIEW_CHARS) {
    content = content.substring(0, MAX_REVIEW_CHARS);
    truncatedNote = "\n\n（注: ドキュメントが長いため先頭部分のみをレビュー対象にしています）";
  }

  // Stable reviewer instructions — identical for every review so the prefix can cache.
  const systemText =
    "あなたは経験豊富な技術文書レビュアーです。与えられた Markdown ドキュメントをレビューし、" +
    "日本語で簡潔かつ具体的に指摘してください。観点: (1) 構成と読みやすさ, (2) 内容の正確さ・矛盾, " +
    "(3) 説明不足や曖昧な箇所, (4) 誤字脱字や表記ゆれ, " +
    "(5) 実装・運用上の実現可能性（該当する場合のみ: 実行環境やプラットフォームの制約、性能・スケール面の懸念。" +
    "技術設計でない文書では無理に触れない）。" +
    "出力は Markdown で、『要約』『良い点』『改善提案』の見出しに分け、改善提案は該当箇所が分かるよう引用してください。";

  // Per-review content lives in the user turn (the volatile part), so the system
  // prefix stays byte-stable across reviews.
  const extra = String(instructions || "").trim();
  const userText =
    (extra ? `レビュー依頼者からの追加指示: ${extra}\n\n` : "") +
    `# ドキュメント名: ${name}\n\n${content}${truncatedNote}`;

  const review = callProvider(provider, apiKey, model, systemText, userText);

  if (!review) {
    throw new Error("レビュー結果が空でした。モデルやドキュメント内容をご確認ください。");
  }

  // Persist so the review survives the modal being closed (full history, newest
  // first via getReviews). The slow provider call above ran outside any lock;
  // only this short append takes the script lock.
  const saved = appendReview(fileId, provider, model, review, email);
  return {
    review,
    provider,
    model,
    createdAt: saved.createdAt,
    createdByName: getMemberDisplayName(email, getMembers()),
  };
}

// ── Repo context for grounded review (GitHub REST, not MCP) ──────────────────
// GAS's 6-minute synchronous limit makes Anthropic's MCP connector (a server-side
// agentic browse loop in one blocking call) unworkable — it timed out at 360s. So we
// fetch a bounded slice of the repo ourselves via the GitHub REST API and inject it as
// prompt context, then do ONE ordinary (non-agentic) provider call. This finishes in
// seconds, works for any provider, and keeps the PAT between GAS and GitHub only.
const GITHUB_API = "https://api.github.com";
const REPO_CONTEXT_CHAR_BUDGET = 120000; // total injected file-body chars
const REPO_CONTEXT_MAX_FILES = 40; // cap fetched files (bounds round trips/time)
const REPO_FILE_MAX_BYTES = 100000; // skip individual files larger than this
const REPO_TEXT_EXT_RE = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|markdown|html?|css|scss|ya?ml|toml|py|go|rs|java|rb|sh|sql|txt|svg)$/i;
const REPO_SKIP_PATH_RE = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git)\//i;
const REPO_SKIP_FILE_RE = /(package-lock\.json|bun\.lockb|yarn\.lock|pnpm-lock\.yaml)$/i;

function githubGet(path: string, pat: string, raw = false): { code: number; body: string } {
  let res: GoogleAppsScript.URL_Fetch.HTTPResponse;
  try {
    res = UrlFetchApp.fetch(`${GITHUB_API}${path}`, {
      method: "get",
      headers: {
        Authorization: `Bearer ${pat}`,
        Accept: raw ? "application/vnd.github.raw" : "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "md-collab", // GitHub requires a User-Agent
      },
      muteHttpExceptions: true,
    });
  } catch (e) {
    throw new Error("GitHub への接続に失敗しました。時間をおいて再度お試しください。");
  }
  return { code: res.getResponseCode(), body: res.getContentText() };
}

interface RepoContext {
  context: string;
  branch: string;
  mode: "all" | "model" | "heuristic"; // how the files were chosen
  included: { path: string; truncated: boolean }[]; // files whose body was injected
  totalCandidates: number;
  budgetHit: boolean;
}

// Assemble a bounded "repo context": the full file tree (paths) plus the bodies of the
// chosen text files. Selection is adaptive: if every candidate fits the budget we take
// them all (small repos); otherwise the model picks the relevant paths from the tree
// (scales to large repos / monorepos far better than a shallow heuristic). Returns a
// manifest of exactly what was included so the reviewer can see (and trust) the input.
function fetchRepoContext(
  repo: string,
  pat: string,
  docContent: string,
  provider: AiProvider,
  apiKey: string,
  model: string,
): RepoContext {
  const info = githubGet(`/repos/${repo}`, pat);
  if (info.code === 401 || info.code === 403) {
    throw new Error("GitHub 認証に失敗しました。PAT の権限・有効期限・対象リポへのアクセスをご確認ください。");
  }
  if (info.code === 404) throw new Error(`リポジトリ ${repo} が見つかりません（PAT のアクセス範囲もご確認ください）。`);
  if (info.code !== 200) throw new Error(`GitHub API エラー (${info.code})。`);
  const branch = String(JSON.parse(info.body).default_branch || "main");

  const treeRes = githubGet(`/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`, pat);
  if (treeRes.code !== 200) throw new Error(`リポジトリのツリー取得に失敗しました (${treeRes.code})。`);
  const blobs: { path: string; size: number }[] = ((JSON.parse(treeRes.body).tree as { type: string; path: string; size?: number }[]) || [])
    .filter((e) => e.type === "blob")
    .map((e) => ({ path: e.path, size: Number(e.size) || 0 }));

  const candidates = blobs.filter(
    (b) => REPO_TEXT_EXT_RE.test(b.path) && !REPO_SKIP_PATH_RE.test(b.path) && !REPO_SKIP_FILE_RE.test(b.path) && b.size <= REPO_FILE_MAX_BYTES,
  );

  // Choose which files to read.
  const totalBytes = candidates.reduce((s, c) => s + c.size, 0);
  let selectedPaths: string[];
  let mode: RepoContext["mode"];
  if (candidates.length <= REPO_CONTEXT_MAX_FILES && totalBytes <= REPO_CONTEXT_CHAR_BUDGET) {
    selectedPaths = candidates.map((c) => c.path); // small repo: take everything
    mode = "all";
  } else {
    selectedPaths = pickFilesWithModel(provider, apiKey, model, docContent, candidates);
    mode = "model";
    if (!selectedPaths.length) {
      // Model selection failed → shallow heuristic (doc-mentioned first, then shortest).
      const lowerDoc = docContent.toLowerCase();
      selectedPaths = candidates
        .slice()
        .sort((a, b) => {
          const am = lowerDoc.indexOf(a.path.toLowerCase()) >= 0 ? 0 : 1;
          const bm = lowerDoc.indexOf(b.path.toLowerCase()) >= 0 ? 0 : 1;
          return am !== bm ? am - bm : a.path.length - b.path.length;
        })
        .map((c) => c.path);
      mode = "heuristic";
    }
  }

  // Fetch bodies for the selected paths, bounded by file count and total chars.
  const parts: string[] = [];
  const included: { path: string; truncated: boolean }[] = [];
  let used = 0;
  let budgetHit = false;
  for (const path of selectedPaths) {
    if (included.length >= REPO_CONTEXT_MAX_FILES || used >= REPO_CONTEXT_CHAR_BUDGET) {
      budgetHit = true;
      break;
    }
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    const fileRes = githubGet(`/repos/${repo}/contents/${encoded}?ref=${encodeURIComponent(branch)}`, pat, true);
    if (fileRes.code !== 200) continue;
    let text = fileRes.body;
    let truncated = false;
    const remaining = REPO_CONTEXT_CHAR_BUDGET - used;
    if (text.length > remaining) {
      text = text.substring(0, remaining) + "\n…（省略）";
      truncated = true;
      budgetHit = true;
    }
    parts.push(`### ${path}\n\`\`\`\n${text}\n\`\`\``);
    included.push({ path, truncated });
    used += text.length;
  }

  let treeListing = blobs.map((b) => b.path).join("\n");
  if (treeListing.length > 20000) treeListing = treeListing.substring(0, 20000) + "\n…（ファイル一覧省略）";
  const context =
    `## ファイル構成（${repo} @ ${branch}）\n\`\`\`\n${treeListing}\n\`\`\`\n\n` +
    `## 参照ファイルの内容（${included.length} 件）\n\n${parts.join("\n\n")}`;

  return { context, branch, mode, included, totalCandidates: candidates.length, budgetHit };
}

// Pass 1 of repo-grounded review: show the model the document and the repo's candidate
// file paths, and let it choose which files are worth reading. Returns only paths that
// actually exist among the candidates (hallucinated paths are dropped).
function pickFilesWithModel(
  provider: AiProvider,
  apiKey: string,
  model: string,
  docContent: string,
  candidates: { path: string; size: number }[],
): string[] {
  const validSet: { [p: string]: boolean } = {};
  candidates.forEach((c) => (validSet[c.path] = true));
  let listing = candidates.map((c) => c.path).join("\n");
  if (listing.length > 50000) listing = listing.substring(0, 50000); // bound the pass-1 prompt

  const systemText =
    "あなたはコードレビューの下準備をするアシスタントです。与えられた文書（計画・設計）の妥当性を検証するために、" +
    "リポジトリのどのファイルの中身を読むべきかを選びます。出力は、読むべきファイルのパスだけを JSON 文字列配列で、" +
    `最大 ${REPO_CONTEXT_MAX_FILES} 件返してください。一覧に存在するパスのみを使い、説明や前置きは一切付けないこと。`;
  const docForPick = docContent.length > 8000 ? docContent.substring(0, 8000) : docContent;
  const userText = `# 文書\n${docForPick}\n\n# 候補ファイル一覧\n${listing}`;

  let raw = "";
  try {
    raw = callProvider(provider, apiKey, model, systemText, userText, 2048);
  } catch (e) {
    return []; // selection failed → caller falls back to the heuristic
  }
  return parsePathList(raw, validSet).slice(0, REPO_CONTEXT_MAX_FILES);
}

// Extract file paths from a model reply (JSON array preferred, else lines/commas),
// keeping only those present in `validSet` so hallucinated paths are discarded.
function parsePathList(text: string, validSet: { [p: string]: boolean }): string[] {
  let tokens: string[] = [];
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try {
      const arr = JSON.parse(arrMatch[0]);
      if (Array.isArray(arr)) tokens = arr.map((x) => String(x));
    } catch (e) {
      /* fall through to line parsing */
    }
  }
  if (!tokens.length) {
    tokens = text.split(/[\n,]/).map((s) => s.trim().replace(/^[-*]\s*/, "").replace(/^["'`]|["'`]$/g, ""));
  }
  const out: string[] = [];
  const seen: { [p: string]: boolean } = {};
  for (const t of tokens) {
    const p = t.trim();
    if (validSet[p] && !seen[p]) {
      seen[p] = true;
      out.push(p);
    }
  }
  return out;
}

/**
 * Repo-grounded review: like reviewDocument, but the target GitHub repository's file
 * tree and key file bodies are fetched (via REST) and injected as context so the model
 * can judge whether the document's plan/design is feasible and consistent with the
 * actual code. Works for any provider. The repo defaults to the workspace setting
 * (gh:repo) and can be overridden per call. Saved to history like a normal review.
 */
export function reviewDocumentRepo(
  fileId: string,
  instructions: string,
  repoOverride: string,
): { review: string; provider: string; model: string; createdAt: string; createdByName: string; repo: string } {
  const email = requireMember();
  const props = PropertiesService.getScriptProperties();
  const provider = toProvider(props.getProperty(aiProviderProp(email)));
  const apiKey = props.getProperty(aiKeyProp(provider, email));
  if (!apiKey) throw new Error("APIキーが登録されていません。設定から登録してください。");
  const pat = resolveGithubPat(email);
  if (!pat) throw new Error("GitHub PAT が登録されていません。AI設定で個人 PAT か共有 PAT を登録してください。");
  const repo = String(repoOverride || "").trim() || (props.getProperty(GITHUB_REPO_PROP) || "").trim();
  if (!repo) throw new Error("対象リポジトリが未設定です。AI設定で owner/name を設定するか、レビュー時に指定してください。");
  if (!GITHUB_REPO_RE.test(repo)) throw new Error("リポジトリは owner/name の形式で指定してください。");
  const model = props.getProperty(aiModelProp(provider, email)) || DEFAULT_MODELS[provider];

  const file = getManagedFile(fileId);
  const name = file.getName().replace(/\.md$/i, "");
  let content = file.getBlob().getDataAsString("UTF-8");
  let truncatedNote = "";
  if (content.length > MAX_REVIEW_CHARS) {
    content = content.substring(0, MAX_REVIEW_CHARS);
    truncatedNote = "\n\n（注: ドキュメントが長いため先頭部分のみをレビュー対象にしています）";
  }

  // Fetched before the (slow) provider call; both run outside any lock. For large repos
  // this also makes a pass-1 model call to pick files (see fetchRepoContext).
  const ctx = fetchRepoContext(repo, pat, content, provider, apiKey, model);

  const systemText =
    "あなたは経験豊富な技術文書レビュアー兼ソフトウェアエンジニアです。与えられた Markdown 文書（多くは計画・設計）を、" +
    "添付された対象リポジトリのファイル構成と参照ファイルの内容に照らしてレビューしてください。" +
    "文書の主張・前提・設計が実コードと整合するか、実現可能か、見落とし・齟齬・破綻がないかを検証します。" +
    "観点: (1) 構成と読みやすさ, (2) 内容の正確さ・実コードとの整合, (3) 説明不足や曖昧な箇所, " +
    "(4) 誤字脱字や表記ゆれ, (5) 実装・運用上の実現可能性（実コードの構造・依存・制約に照らして）。" +
    "指摘は該当箇所を引用し、参照した実ファイルのパスを添えてください。" +
    "添付に本文が含まれないファイルは、ツリーから存在は推測してよいが内容は断定しないこと。" +
    "出力は Markdown で『要約』『良い点』『改善提案』『リポジトリとの整合』の見出しに分けてください。";

  const extra = String(instructions || "").trim();
  const userText =
    (extra ? `レビュー依頼者からの追加指示: ${extra}\n\n` : "") +
    `# 対象リポジトリ\n${repo}\n\n# レビュー対象ドキュメント名: ${name}\n\n${content}${truncatedNote}\n\n` +
    `---\n\n# リポジトリ文脈（参考資料）\n\n${ctx.context}`;

  const review = callProvider(provider, apiKey, model, systemText, userText, 8192);
  if (!review) throw new Error("レビュー結果が空でした。モデルやリポジトリ設定をご確認ください。");

  // Append a transparency footer so it's always visible (and saved) which files the AI
  // actually saw, how they were chosen, and whether the budget cut anything off.
  const modeLabel = ctx.mode === "all" ? "全ソース投入" : ctx.mode === "model" ? "モデル選定" : "簡易選定";
  const fileList = ctx.included.length
    ? ctx.included.map((f) => `- \`${f.path}\`${f.truncated ? "（一部のみ）" : ""}`).join("\n")
    : "- （本文取得なし。ファイル一覧のみ参照）";
  const footer =
    `\n\n---\n\n#### 参照したリポジトリファイル（${repo} @ ${ctx.branch} ／ ${modeLabel} ／ ${ctx.included.length} 件` +
    `${ctx.budgetHit ? " ／ 予算到達で打ち切り" : ""}・候補 ${ctx.totalCandidates} 件）\n\n${fileList}`;
  const fullReview = review + footer;

  const saved = appendReview(fileId, provider, model, fullReview, email);
  return {
    review: fullReview,
    provider,
    model,
    createdAt: saved.createdAt,
    createdByName: getMemberDisplayName(email, getMembers()),
    repo,
  };
}

// LLMs sometimes wrap the whole answer in a ```markdown fence or ``` fence despite
// being told not to. Strip a single fence that encloses the entire output.
function stripCodeFence(text: string): string {
  const m = text.match(/^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1]! : text;
}

/**
 * Generates a revised version of the document with the given review findings applied,
 * using the active user's provider/model, and persists it as a *pending draft* (one per
 * document+user). The draft is loaded into the editor for the human to read/edit at full
 * size and save through updateDocument; persisting means a closed browser doesn't lose it.
 * Refuses oversized documents rather than truncating (a truncated rewrite would delete
 * content).
 */
export function proposeRevision(
  fileId: string,
  reviewContent: string,
  instructions: string,
): { revised: string; provider: string; model: string; baseLastUpdated: number; createdAt: string } {
  const email = requireMember();
  const props = PropertiesService.getScriptProperties();
  const provider = toProvider(props.getProperty(aiProviderProp(email)));
  const apiKey = props.getProperty(aiKeyProp(provider, email));
  if (!apiKey) {
    throw new Error("APIキーが登録されていません。設定から登録してください。");
  }
  const model = props.getProperty(aiModelProp(provider, email)) || DEFAULT_MODELS[provider];

  const review = String(reviewContent || "").trim();
  if (!review) throw new Error("反映するレビュー内容がありません。");

  const file = getManagedFile(fileId);
  const content = file.getBlob().getDataAsString("UTF-8");
  const baseLastUpdated = file.getLastUpdated().getTime();
  if (content.length > MAX_REVISE_CHARS) {
    throw new Error(
      `ドキュメントが長いため自動反映に未対応です（${MAX_REVISE_CHARS.toLocaleString()}字まで）。分割してお試しください。`,
    );
  }

  const systemText =
    "あなたは技術文書の編集者です。与えられた元の Markdown ドキュメントに、レビュー指摘を反映した改訂版を作成してください。" +
    "元の構造・意図・トーンは保ち、指摘された箇所のみを的確に修正します。" +
    "出力は改訂後の本文 Markdown のみ。前置き・あとがき・変更点の説明・全体をコードフェンスで囲むことは禁止です。";
  const extra = String(instructions || "").trim();
  const userText =
    (extra ? `追加指示: ${extra}\n\n` : "") +
    `# レビュー指摘\n\n${review}\n\n# 元のドキュメント\n\n${content}`;

  // The slow provider call runs outside any lock; only the short upsert below locks.
  const revised = stripCodeFence(callProvider(provider, apiKey, model, systemText, userText, 16384)).trim();
  if (!revised) {
    throw new Error("修正案が空でした。モデルやレビュー内容をご確認ください。");
  }
  const createdAt = upsertPendingRevision(fileId, email, revised, baseLastUpdated, provider, model);
  return { revised, provider, model, baseLastUpdated, createdAt };
}

// Store (or replace) the active user's pending revision draft for a document. At most
// one row per (document, user); a new proposal overwrites the previous one in place.
function upsertPendingRevision(
  documentId: string,
  email: string,
  content: string,
  baseLastUpdated: number,
  provider: AiProvider,
  model: string,
): string {
  return withLock(() => {
    const sheet = getSheet(SHEETS.REVISIONS);
    const createdAt = now();
    const row = [documentId, email, content, String(baseLastUpdated), provider, model, createdAt];
    const data = sheetData(sheet);
    for (let i = 0; i < data.length; i++) {
      const r = data[i]!;
      if (r[REVISION_COLS.DOCUMENT_ID] === documentId && r[REVISION_COLS.CREATED_BY] === email) {
        sheet.getRange(i + 1, 1, 1, row.length).setValues([row]);
        return createdAt;
      }
    }
    sheet.appendRow(row);
    return createdAt;
  });
}

// The active user's pending revision draft for a document, or null. No lock: a plain read.
function readPendingRevision(documentId: string, email: string): PendingRevision | null {
  const data = sheetData(getSheet(SHEETS.REVISIONS));
  for (let i = data.length - 1; i >= 0; i--) {
    const r = data[i]!;
    if (r[REVISION_COLS.DOCUMENT_ID] === documentId && r[REVISION_COLS.CREATED_BY] === email) {
      return {
        content: r[REVISION_COLS.CONTENT]!,
        baseLastUpdated: Number(r[REVISION_COLS.BASE_LAST_UPDATED]) || 0,
        provider: r[REVISION_COLS.PROVIDER]!,
        model: r[REVISION_COLS.MODEL]!,
        createdAt: r[REVISION_COLS.CREATED_AT]!,
      };
    }
  }
  return null;
}

/** Discards the active user's pending revision draft for a document (after save or on reject). */
export function discardPendingRevision(documentId: string): void {
  withLock(() => {
    const email = requireMember();
    const sheet = getSheet(SHEETS.REVISIONS);
    const data = sheetData(sheet);
    // Delete bottom-up so row indices stay valid as rows are removed.
    for (let i = data.length - 1; i >= 0; i--) {
      const r = data[i]!;
      if (r[REVISION_COLS.DOCUMENT_ID] === documentId && r[REVISION_COLS.CREATED_BY] === email) {
        sheet.deleteRow(i + 1);
      }
    }
  });
}

// Append one review row. Kept tiny and lock-guarded so it doesn't hold the script
// lock during the (slow) provider request that produced `content`.
function appendReview(
  documentId: string,
  provider: AiProvider,
  model: string,
  content: string,
  email: string,
): { id: string; createdAt: string } {
  return withLock(() => {
    const sheet = getSheet(SHEETS.REVIEWS);
    const id = uuid();
    const createdAt = now();
    sheet.appendRow([id, documentId, provider, model, content, email, createdAt]);
    return { id, createdAt };
  });
}

/** Saved AI reviews for a document, newest first. */
export function getReviews(documentId: string): SavedReview[] {
  requireMember();
  getManagedFile(documentId); // ensure the document belongs to this workspace
  const members = getMembers();
  return sheetData(getSheet(SHEETS.REVIEWS))
    .filter((r) => r[REVIEW_COLS.DOCUMENT_ID] === documentId)
    .map((r) => ({
      id: r[REVIEW_COLS.REVIEW_ID]!,
      documentId,
      provider: r[REVIEW_COLS.PROVIDER]!,
      model: r[REVIEW_COLS.MODEL]!,
      content: r[REVIEW_COLS.CONTENT]!,
      createdBy: r[REVIEW_COLS.CREATED_BY]!,
      createdByName: getMemberDisplayName(r[REVIEW_COLS.CREATED_BY]!, members),
      createdAt: r[REVIEW_COLS.CREATED_AT]!,
    }))
    .reverse(); // rows are appended chronologically → reverse for newest-first
}

// ─── App entry ───────────────────────────────────────────────────────────────

export function getAppState(): AppState {
  const user = currentUserEmail();
  // Before provisioning there is no DB to read; tell the client to show setup.
  // Only the deployer can act on it, so surface isOwner for the UI to branch on.
  if (!isDbConfigured()) {
    return {
      currentUser: user,
      currentUserName: user,
      isMember: false,
      isSetupRequired: true,
      isOwner: isOwner(user),
      folders: [],
      statuses: [],
      unreadCount: 0,
      hasAiKey: false,
      aiProvider: DEFAULT_AI_PROVIDER,
      githubRepoReady: false,
      githubRepo: "",
    };
  }
  const members = getMembers();
  const member = isAuthorized(user, members);
  const props = PropertiesService.getScriptProperties();
  // Non-members get an empty workspace view; the UI shows an access notice.
  const folders = member ? getFolders() : [];
  const statuses = member ? getStatuses() : [];
  const notifSheet = getSheet(SHEETS.NOTIFICATIONS);
  const unreadCount = member
    ? sheetData(notifSheet).filter(
        (r) => r[NOTIF_COLS.RECIPIENT] === user && r[NOTIF_COLS.IS_READ] !== "true"
      ).length
    : 0;
  return {
    currentUser: user,
    currentUserName: getMemberDisplayName(user, members),
    isMember: member,
    isSetupRequired: false,
    isOwner: isOwner(user),
    folders,
    statuses,
    unreadCount,
    hasAiKey: member ? hasActiveAiKey(user) : false,
    aiProvider: member ? toProvider(props.getProperty(aiProviderProp(user))) : DEFAULT_AI_PROVIDER,
    githubRepoReady: member ? resolveGithubPat(user) !== "" : false,
    githubRepo: member ? props.getProperty(GITHUB_REPO_PROP) || "" : "",
  };
}

export function doGet(_e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("md-collab")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
