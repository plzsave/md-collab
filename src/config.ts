export const CONFIG = {
  DB_SPREADSHEET_NAME: "md-collab-db",
} as const;

export const SHEETS = {
  THREADS: "threads",
  COMMENTS: "comments",
  MEMBERS: "members",
  NOTIFICATIONS: "notifications",
  FOLDERS: "folders",
  STATUSES: "statuses",
  DOC_META: "doc_meta",
} as const;

/** Default workflow statuses, seeded in-memory until the user customizes them. */
export const DEFAULT_STATUSES: { id: string; label: string }[] = [
  { id: "draft", label: "作成中" },
  { id: "review", label: "レビュー中" },
  { id: "done", label: "作成完了" },
];

export const THREAD_COLS = {
  THREAD_ID: 0,
  DOCUMENT_ID: 1,
  ANCHOR_TEXT: 2,
  ANCHOR_BEFORE: 3,
  ANCHOR_AFTER: 4,
  STATUS: 5,
  CREATED_BY: 6,
  CREATED_AT: 7,
  RESOLVED_BY: 8,
  RESOLVED_AT: 9,
} as const;

export const COMMENT_COLS = {
  COMMENT_ID: 0,
  THREAD_ID: 1,
  CONTENT: 2,
  AUTHOR: 3,
  MENTIONS: 4,
  CREATED_AT: 5,
  UPDATED_AT: 6,
  DELETED: 7,
} as const;

export const MEMBER_COLS = {
  EMAIL: 0,
  DISPLAY_NAME: 1,
  ADDED_AT: 2,
  ADDED_BY: 3,
} as const;

export const NOTIF_COLS = {
  NOTIF_ID: 0,
  RECIPIENT: 1,
  TYPE: 2,
  THREAD_ID: 3,
  COMMENT_ID: 4,
  DOCUMENT_ID: 5,
  DOCUMENT_NAME: 6,
  IS_READ: 7,
  CREATED_AT: 8,
  MESSAGE: 9,
} as const;

export const FOLDER_COLS = {
  FOLDER_ID: 0,
  NAME: 1,
  DRIVE_FOLDER_ID: 2,
  CREATED_AT: 3,
  CREATED_BY: 4,
} as const;

export const STATUS_COLS = {
  ID: 0,
  LABEL: 1,
  ORDER: 2,
} as const;

export const DOC_META_COLS = {
  DOCUMENT_ID: 0,
  STATUS_ID: 1,
  ARCHIVED: 2,
  ASSIGNEE: 3,
} as const;
