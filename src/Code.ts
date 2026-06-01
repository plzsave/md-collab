import { CONFIG, SHEETS, THREAD_COLS, COMMENT_COLS, MEMBER_COLS, NOTIF_COLS, FOLDER_COLS, STATUS_COLS, DOC_META_COLS, DEFAULT_STATUSES } from "./config";
import type { Folder, MdDocument, CommentThread, Comment, Member, Notification, AppState, DocStatus } from "./types";

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
  const names = [SHEETS.THREADS, SHEETS.COMMENTS, SHEETS.MEMBERS, SHEETS.NOTIFICATIONS, SHEETS.FOLDERS, SHEETS.STATUSES, SHEETS.DOC_META];
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
  const files = driveFolder.getFilesByType("text/plain");

  const threadSheet = getSheet(SHEETS.THREADS);
  const threadRows = sheetData(threadSheet);

  const metaMap = getDocMetaMap();
  const statuses = getStatuses();
  const validStatusIds = new Set(statuses.map((s) => s.id));
  const defaultStatusId = statuses[0] ? statuses[0].id : "";

  const docs: MdDocument[] = [];
  while (files.hasNext()) {
    const file = files.next();
    const id = file.getId();
    const openCount = threadRows.filter(
      (r) => r[THREAD_COLS.DOCUMENT_ID] === id && r[THREAD_COLS.STATUS] === "open"
    ).length;
    const meta = metaMap[id];
    // Fall back to the first status when unset or when the saved status was deleted.
    const statusId = meta && validStatusIds.has(meta.statusId) ? meta.statusId : defaultStatusId;
    docs.push({
      id,
      name: file.getName().replace(/\.md$/, ""),
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
    };
  }
  const members = getMembers();
  const member = isAuthorized(user, members);
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
  };
}

export function doGet(_e: GoogleAppsScript.Events.DoGet): GoogleAppsScript.HTML.HtmlOutput {
  return HtmlService.createHtmlOutputFromFile("index")
    .setTitle("md-collab")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
