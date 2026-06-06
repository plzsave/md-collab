export interface Folder {
  id: string;
  name: string;
}

export interface MdDocument {
  id: string;
  name: string;
  folderId: string;
  folderName: string;
  lastUpdated: number;
  openThreadCount: number;
  statusId: string;
  archived: boolean;
  assignee: string; // member email, or "" when unassigned
}

export interface DocStatus {
  id: string;
  label: string;
}

export interface CommentAnchor {
  selectedText: string;
  contextBefore: string;
  contextAfter: string;
}

export interface CommentThread {
  threadId: string;
  documentId: string;
  anchor: CommentAnchor;
  status: "open" | "resolved";
  createdBy: string;
  createdAt: string;
  resolvedBy: string;
  resolvedAt: string;
  comments: Comment[];
}

export interface Comment {
  commentId: string;
  threadId: string;
  content: string;
  author: string;
  authorName: string;
  mentions: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  email: string;
  displayName: string;
  addedAt: string;
  addedBy: string;
}

export interface Notification {
  notifId: string;
  recipient: string;
  type: "mention" | "reply" | "resolve";
  threadId: string;
  commentId: string;
  documentId: string;
  documentName: string;
  isRead: boolean;
  createdAt: string;
  message: string;
}

/** A persisted AI review of a document, kept as full history (newest first). */
export interface SavedReview {
  id: string;
  documentId: string;
  provider: string;
  model: string;
  content: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
}

export interface AppState {
  currentUser: string;
  currentUserName: string;
  isMember: boolean;
  /** True until the DB spreadsheet has been provisioned via setupDb. */
  isSetupRequired: boolean;
  /** Whether the current user is the deployer (only they may run setup). */
  isOwner: boolean;
  folders: Folder[];
  statuses: DocStatus[];
  unreadCount: number;
  /** Whether the current user has registered an API key for their selected AI review provider. */
  hasAiKey: boolean;
}
