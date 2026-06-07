// ─────────────────────────────────────────────────────────────────────────────
// md-collab client (browser) script.
//
// Front-end code that runs inside the GAS HtmlService iframe. GAS serves a
// single HTML file, so this module is bundled by scripts/inline-js.ts and
// inlined into dist/index.html at build time — exactly how Tailwind CSS is
// inlined (see scripts/inline-css.ts). Authoring it here (instead of a 2.4k-line
// inline <script>) gives editor support, type checking, and room to split into
// modules later without changing the shipped output.
//
// The libraries below are provided as globals by CDN <script> tags in
// static/index.html (marked, DOMPurify, hljs) and a head ES-module (mermaid),
// plus the GAS client API (google.script.run). They are declared here so this
// file type-checks in isolation.
// ─────────────────────────────────────────────────────────────────────────────

declare const marked: any;
declare const DOMPurify: any;
declare const hljs: any;
declare const mermaid: any;
declare const google: any;

interface Window {
  mermaid: any;
}

// This client was migrated from an untyped inline <script>. It reads form-control
// and dataset properties straight off the broad element / event-target types the
// DOM API returns, instead of narrowing to HTMLInputElement &co. first. Widening
// those types in one place (compile-time only — no runtime effect) keeps the move
// faithful and avoids casting at ~85 individual call sites.
interface HTMLElement {
  value: string;
  checked: boolean;
  disabled: boolean;
  placeholder: string;
}
interface Element {
  dataset: DOMStringMap;
  title: string;
}
interface EventTarget {
  value: string;
  checked: boolean;
  files: FileList | null;
  closest(selectors: string): HTMLElement | null;
}

// ─── State ────────────────────────────────────────────────────────────────────
const state = {
  currentUser: '',
  currentUserName: '',
  folders: [],
  statuses: [],
  docs: [],              // cached document list for the current folder
  docFilter: 'all',      // 'all' | <statusId> | '__archived__'
  currentFolderId: null,
  currentDocId: null,
  currentDocName: '',
  currentDocContent: '',
  currentDocLastUpdated: 0,
  pendingRevision: null, // unsaved AI-revision draft for the current doc, or null
  draftActive: false,    // true while the editor is holding that draft (vs. normal edit)
  threads: [],
  members: [],
  unreadCount: 0,
  hasAiKey: false,      // whether the active provider has a key (drives the review-button gate)
  aiProvider: 'claude', // the user's selected provider
  aiProviders: {},      // per-provider { hasKey, model }, loaded from getAiSettings
  github: { hasUserPat: false, hasSharedPat: false, repo: '', isOwner: false }, // repo-review config
  githubReady: false,   // a PAT (own or shared) is usable for repo-grounded review
  filterMode: 'open',   // 'open' | 'all'
  pendingAnchor: null,  // { selectedText, contextBefore, contextAfter }
  pendingReplyThreadId: null,
  activeMentionInput: null,
};

// ─── Init ─────────────────────────────────────────────────────────────────────
// mermaid is loaded and initialized by the module script in <head>; it may not
// be present yet when an early render runs, so renderMermaidBlocks awaits it.
function ensureMermaid() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  return new Promise(resolve => {
    window.addEventListener('mermaid-ready', () => resolve(window.mermaid), { once: true });
  });
}

(function init() {
  loadDarkMode();
  showLoading('初期化中…');
  google.script.run
    .withSuccessHandler(onAppState)
    .withFailureHandler(onError)
    .getAppState();
})();

function onAppState(data) {
  state.currentUser = data.currentUser;
  state.currentUserName = data.currentUserName;
  state.folders = data.folders || [];
  state.statuses = data.statuses || [];
  state.unreadCount = data.unreadCount || 0;
  state.hasAiKey = !!data.hasAiKey;
  state.aiProvider = data.aiProvider || 'claude';
  state.githubReady = !!data.githubRepoReady;
  state.github.repo = data.githubRepo || '';
  hideLoading();
  if (data.isSetupRequired) {
    showSetupScreen(data.isOwner);
    return;
  }
  if (!data.isMember) {
    document.getElementById('access-denied-email').textContent = data.currentUser || '';
    const ad = document.getElementById('access-denied');
    ad.classList.remove('hidden');
    ad.classList.add('flex');
    return;
  }
  document.getElementById('user-badge').textContent = data.currentUserName || data.currentUser;
  document.getElementById('user-badge').classList.remove('hidden');
  renderFolderTabs();
  updateNotifBadge();
  loadMembers();
  if (state.folders.length > 0) selectFolder(state.folders[0].id);
}

// ─── Dark mode ────────────────────────────────────────────────────────────────
function loadDarkMode() {
  const isDark = localStorage.getItem('md-collab-dark') === 'true';
  document.documentElement.classList.toggle('dark', isDark);
  document.getElementById('sun-icon').classList.toggle('hidden', !isDark);
  document.getElementById('moon-icon').classList.toggle('hidden', isDark);
}

document.getElementById('darkmode-btn').addEventListener('click', () => {
  const isDark = document.documentElement.classList.toggle('dark');
  localStorage.setItem('md-collab-dark', String(isDark));
  document.getElementById('sun-icon').classList.toggle('hidden', !isDark);
  document.getElementById('moon-icon').classList.toggle('hidden', isDark);
  if (document.getElementById('view-panel').classList.contains('hidden') === false) {
    renderMermaidBlocks();
  }
  renderDocList(); // recompute status badge colors for the new theme
});

// ─── Folder tabs ─────────────────────────────────────────────────────────────
function renderFolderTabs() {
  const container = document.getElementById('folder-tabs');
  container.innerHTML = '';
  for (const folder of state.folders) {
    const btn = document.createElement('button');
    btn.dataset.id = folder.id;
    btn.className = 'text-sm px-3 py-1.5 rounded-md whitespace-nowrap transition-colors ' +
      (folder.id === state.currentFolderId
        ? 'bg-indigo-600 text-white font-medium'
        : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700');
    btn.textContent = folder.name;
    btn.addEventListener('click', () => selectFolder(folder.id));
    container.appendChild(btn);
    // Rename/delete menu, shown only for the active folder.
    if (folder.id === state.currentFolderId) {
      const menuBtn = document.createElement('button');
      menuBtn.className = 'px-1 rounded text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400';
      menuBtn.title = 'フォルダ設定';
      menuBtn.textContent = '⋯';
      menuBtn.addEventListener('click', (e) => { e.stopPropagation(); openFolderMenu(folder, menuBtn); });
      container.appendChild(menuBtn);
    }
  }
  // Add folder button
  const addBtn = document.createElement('button');
  addBtn.className = 'text-sm px-2 py-1.5 rounded-md text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400 hover:bg-gray-100 dark:hover:bg-gray-700';
  addBtn.title = '新規フォルダ';
  addBtn.innerHTML = '<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/></svg>';
  addBtn.addEventListener('click', () => { resetFolderModal(); showModal('new-folder-modal'); });
  container.appendChild(addBtn);
}

function selectFolder(folderId) {
  state.currentFolderId = folderId;
  const folder = state.folders.find(f => f.id === folderId);
  document.getElementById('sidebar-folder-name').textContent = folder ? folder.name : 'ドキュメント';
  renderFolderTabs();
  loadDocList(folderId);
}

// ─── Folder rename / delete menu ───────────────────────────────────────────────
function closeFolderMenu() {
  const m = document.getElementById('folder-menu');
  if (m) m.remove();
  document.removeEventListener('click', closeFolderMenuOnOutside);
}
function closeFolderMenuOnOutside(e) {
  if (!e.target.closest('#folder-menu')) closeFolderMenu();
}
function openFolderMenu(folder, anchorEl) {
  closeFolderMenu();
  const menu = document.createElement('div');
  menu.id = 'folder-menu';
  menu.className = 'fixed z-50 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg text-sm overflow-hidden min-w-[120px]';
  const r = anchorEl.getBoundingClientRect();
  menu.style.top = (r.bottom + 4) + 'px';
  menu.style.left = r.left + 'px';
  const rename = document.createElement('button');
  rename.className = 'block w-full text-left px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200';
  rename.textContent = 'リネーム';
  rename.addEventListener('click', () => { closeFolderMenu(); onRenameFolder(folder); });
  const del = document.createElement('button');
  del.className = 'block w-full text-left px-4 py-2 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400';
  del.textContent = '削除';
  del.addEventListener('click', () => { closeFolderMenu(); onDeleteFolder(folder); });
  menu.appendChild(rename);
  menu.appendChild(del);
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', closeFolderMenuOnOutside), 0);
}

function onRenameFolder(folder) {
  const newName = prompt('フォルダ名を変更', folder.name);
  if (!newName || !newName.trim() || newName === folder.name) return;
  showLoading('変更中…');
  google.script.run
    .withSuccessHandler(() => {
      hideLoading();
      folder.name = newName.trim();
      if (state.currentFolderId === folder.id) {
        document.getElementById('sidebar-folder-name').textContent = folder.name;
      }
      renderFolderTabs();
      showToast('フォルダ名を変更しました');
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .renameFolder(folder.id, newName.trim());
}

function onDeleteFolder(folder) {
  if (!confirm(`フォルダ "${folder.name}" を削除しますか？\n（フォルダ内にドキュメントがある場合は削除できません）`)) return;
  showLoading('削除中…');
  google.script.run
    .withSuccessHandler(() => {
      hideLoading();
      state.folders = state.folders.filter(f => f.id !== folder.id);
      if (state.currentFolderId === folder.id) {
        state.currentFolderId = null;
        state.currentDocId = null;
        document.getElementById('view-panel').classList.add('hidden');
        document.getElementById('edit-panel').classList.add('hidden');
        document.getElementById('empty-state').classList.remove('hidden');
        document.getElementById('doc-list').innerHTML = '';
      }
      renderFolderTabs();
      if (state.folders.length > 0 && !state.currentFolderId) selectFolder(state.folders[0].id);
      showToast('フォルダを削除しました');
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .deleteFolder(folder.id);
}

// ─── Document list ────────────────────────────────────────────────────────────
function loadDocList(folderId) {
  const list = document.getElementById('doc-list');
  list.innerHTML = '<div class="p-3 text-xs text-gray-400">読み込み中…</div>';
  google.script.run
    .withSuccessHandler(docs => renderDocList(docs))
    .withFailureHandler(onError)
    .getDocumentList(folderId);
}

// Renders the doc list. When called with `docs` (from a fetch) it refreshes the
// cache and the status tabs; when called with no argument it re-renders from the
// cache (used after a local status/archive change or a tab switch).
function renderDocList(docs?) {
  const list = document.getElementById('doc-list');
  if (docs) {
    state.docs = docs;
    renderStatusTabs();
  }
  const all = state.docs || [];
  const filter = state.docFilter || 'all';
  let visible;
  if (filter === '__archived__') visible = all.filter(d => d.archived);
  else if (filter === '__mine__') visible = all.filter(d => !d.archived && d.assignee === state.currentUser);
  else if (filter === 'all') visible = all.filter(d => !d.archived);
  else visible = all.filter(d => !d.archived && d.statusId === filter);

  if (visible.length === 0) {
    let msg;
    if (filter === '__archived__') msg = 'アーカイブされたドキュメントはありません';
    else if (filter === '__mine__') msg = '自分が担当のドキュメントはありません';
    else msg = 'ドキュメントがありません<br>右上の＋から作成できます';
    list.innerHTML = `<div class="p-4 text-xs text-gray-400 dark:text-gray-500 text-center">${msg}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const doc of visible) list.appendChild(buildDocItem(doc));
}

// Stable hue per status id so each status gets a distinct, consistent color
// without the user having to pick one.
function statusHue(id) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

function statusBadgeHtml(status) {
  if (!status) return '';
  const h = statusHue(status.id);
  const isDark = document.documentElement.classList.contains('dark');
  const bg = isDark ? `hsl(${h} 40% 22%)` : `hsl(${h} 85% 92%)`;
  const fg = isDark ? `hsl(${h} 70% 80%)` : `hsl(${h} 50% 32%)`;
  return `<span class="inline-block text-xs px-1.5 py-0.5 rounded-full font-medium" style="background:${bg};color:${fg}">${escapeHtml(status.label)}</span>`;
}

function assigneeChipHtml(email) {
  if (!email) return '';
  const member = state.members.find(m => m.email === email);
  const name = member ? member.displayName : email;
  return `<span class="inline-flex items-center gap-1 min-w-0 text-xs text-gray-500 dark:text-gray-400" title="担当: ${escapeHtml(name)}">
    <span class="w-4 h-4 rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-400 text-[10px] flex items-center justify-center font-bold flex-shrink-0">${escapeHtml(getInitial(name))}</span>
    <span class="truncate">${escapeHtml(name)}</span>
  </span>`;
}

function buildDocItem(doc) {
  const item = document.createElement('div');
  item.dataset.id = doc.id;
  item.className = 'px-3 py-2.5 cursor-pointer border-b border-gray-100 dark:border-gray-700 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 transition-colors ' +
    (doc.id === state.currentDocId ? 'bg-indigo-50 dark:bg-indigo-900/30 border-l-2 border-l-indigo-500' : '');
  const status = state.statuses.find(s => s.id === doc.statusId);
  item.innerHTML = `
    <div class="flex items-start justify-between gap-1">
      <span class="text-sm font-medium text-gray-800 dark:text-gray-200 truncate ${doc.archived ? 'opacity-60' : ''}">${escapeHtml(doc.name)}</span>
      ${doc.openThreadCount > 0 ? `<span class="flex-shrink-0 text-xs bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 px-1.5 py-0.5 rounded-full font-medium">${doc.openThreadCount}</span>` : ''}
    </div>
    <div class="flex items-center gap-1 mt-1">
      <span class="flex items-center gap-1 min-w-0">${statusBadgeHtml(status)}${assigneeChipHtml(doc.assignee)}</span>
      <span class="text-xs text-gray-400 dark:text-gray-500 flex-shrink-0 ml-auto">${formatDate(doc.lastUpdated)}</span>
    </div>`;
  item.addEventListener('click', () => openDocument(doc.id, doc.name));

  // Inline controls — their clicks must not bubble up and open the document.
  const controls = document.createElement('div');
  controls.className = 'flex items-center gap-1 mt-1.5';
  controls.addEventListener('click', e => e.stopPropagation());

  const sel = document.createElement('select');
  sel.className = 'flex-1 min-w-0 text-xs rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-500';
  for (const s of state.statuses) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.label;
    if (s.id === doc.statusId) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => onChangeDocStatus(doc, sel.value));

  const arch = document.createElement('button');
  arch.className = 'flex-shrink-0 text-xs px-1.5 py-0.5 rounded border border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700';
  arch.textContent = doc.archived ? '戻す' : 'アーカイブ';
  arch.title = doc.archived ? 'アーカイブを解除' : 'アーカイブする';
  arch.addEventListener('click', () => onToggleArchive(doc));

  controls.appendChild(sel);
  controls.appendChild(arch);
  item.appendChild(controls);

  // Assignee selector on its own row (👤 + select).
  const assignRow = document.createElement('div');
  assignRow.className = 'flex items-center gap-1 mt-1';
  assignRow.addEventListener('click', e => e.stopPropagation());
  const icon = document.createElement('span');
  icon.className = 'text-xs flex-shrink-0';
  icon.textContent = '👤';
  const asel = document.createElement('select');
  asel.className = 'flex-1 min-w-0 text-xs rounded border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-200 px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-indigo-500';
  const none = document.createElement('option');
  none.value = '';
  none.textContent = '未割り当て';
  if (!doc.assignee) none.selected = true;
  asel.appendChild(none);
  for (const m of state.members) {
    const opt = document.createElement('option');
    opt.value = m.email;
    opt.textContent = m.displayName;
    if (m.email === doc.assignee) opt.selected = true;
    asel.appendChild(opt);
  }
  // Keep showing an assignee that is no longer a member.
  if (doc.assignee && !state.members.some(m => m.email === doc.assignee)) {
    const opt = document.createElement('option');
    opt.value = doc.assignee;
    opt.textContent = doc.assignee + '（元メンバー）';
    opt.selected = true;
    asel.appendChild(opt);
  }
  asel.addEventListener('change', () => onChangeDocAssignee(doc, asel.value));
  assignRow.appendChild(icon);
  assignRow.appendChild(asel);
  item.appendChild(assignRow);

  return item;
}

// ─── Status tabs (sidebar filter) ───────────────────────────────────────────────
function renderStatusTabs() {
  const container = document.getElementById('status-tabs');
  if (!container) return;
  container.innerHTML = '';
  const all = state.docs || [];
  const activeCount = all.filter(d => !d.archived).length;
  const archivedCount = all.filter(d => d.archived).length;

  container.appendChild(buildTabButton('all', 'すべて', activeCount));
  const mineCount = all.filter(d => !d.archived && d.assignee === state.currentUser).length;
  container.appendChild(buildTabButton('__mine__', '👤 自分の担当', mineCount));
  for (const s of state.statuses) {
    const count = all.filter(d => !d.archived && d.statusId === s.id).length;
    container.appendChild(buildTabButton(s.id, s.label, count));
  }
  const archTab = buildTabButton('__archived__', '🗄 アーカイブ', archivedCount);
  archTab.classList.add('ml-auto');
  container.appendChild(archTab);
}

function buildTabButton(key, label, count) {
  const btn = document.createElement('button');
  const active = (state.docFilter || 'all') === key;
  btn.className = 'text-xs px-2 py-0.5 rounded-full whitespace-nowrap border transition-colors ' +
    (active
      ? 'bg-indigo-600 border-indigo-600 text-white font-medium'
      : 'border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700');
  btn.textContent = count > 0 ? `${label} ${count}` : label;
  btn.addEventListener('click', () => {
    state.docFilter = key;
    renderStatusTabs();
    renderDocList();
  });
  return btn;
}

function onChangeDocStatus(doc, statusId) {
  const prev = doc.statusId;
  if (prev === statusId) return;
  doc.statusId = statusId;
  google.script.run
    .withSuccessHandler(() => { renderStatusTabs(); renderDocList(); showToast('ステータスを変更しました'); })
    .withFailureHandler(e => { doc.statusId = prev; renderStatusTabs(); renderDocList(); onError(e); })
    .setDocumentStatus(doc.id, statusId);
}

function onToggleArchive(doc) {
  const next = !doc.archived;
  google.script.run
    .withSuccessHandler(() => {
      doc.archived = next;
      renderStatusTabs();
      renderDocList();
      showToast(next ? 'アーカイブしました' : 'アーカイブを解除しました');
    })
    .withFailureHandler(onError)
    .setDocumentArchived(doc.id, next);
}

function onChangeDocAssignee(doc, email) {
  const prev = doc.assignee;
  if (prev === email) return;
  doc.assignee = email;
  google.script.run
    .withSuccessHandler(() => { renderStatusTabs(); renderDocList(); showToast('担当者を変更しました'); })
    .withFailureHandler(e => { doc.assignee = prev; renderStatusTabs(); renderDocList(); onError(e); })
    .setDocumentAssignee(doc.id, email);
}

// ─── Status settings (customize the list) ───────────────────────────────────────
let statusDraft = [];

function openStatusSettings() {
  statusDraft = state.statuses.map(s => ({ id: s.id, label: s.label }));
  renderStatusDraft();
  showModal('status-settings-modal');
}

function renderStatusDraft() {
  const list = document.getElementById('status-edit-list');
  list.innerHTML = '';
  statusDraft.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'flex items-center gap-2';
    const sw = document.createElement('span');
    sw.className = 'w-3 h-3 rounded-full flex-shrink-0';
    sw.style.background = `hsl(${statusHue(s.id)} 60% 55%)`;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = s.label;
    input.className = 'flex-1 border border-gray-300 dark:border-gray-600 rounded-lg px-2 py-1.5 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-indigo-500';
    input.addEventListener('input', () => { statusDraft[i].label = input.value; });
    const del = document.createElement('button');
    del.className = 'text-gray-400 hover:text-red-500 px-1 flex-shrink-0';
    del.textContent = '✕';
    del.title = '削除';
    del.addEventListener('click', () => {
      if (statusDraft.length <= 1) { showToast('ステータスは1つ以上必要です'); return; }
      statusDraft.splice(i, 1);
      renderStatusDraft();
    });
    row.appendChild(sw);
    row.appendChild(input);
    row.appendChild(del);
    list.appendChild(row);
  });
}

function addStatusDraft() {
  statusDraft.push({ id: 'st-' + Math.random().toString(36).slice(2, 9), label: '新しいステータス' });
  renderStatusDraft();
}

function saveStatusSettings() {
  const clean = statusDraft
    .map(s => ({ id: s.id, label: (s.label || '').trim() }))
    .filter(s => s.label);
  if (clean.length === 0) { showToast('ステータスは1つ以上必要です'); return; }
  showLoading('保存中…');
  google.script.run
    .withSuccessHandler(saved => {
      hideLoading();
      state.statuses = saved || clean;
      // If the current filter pointed at a status that was removed, reset it.
      if (state.docFilter !== 'all' && state.docFilter !== '__archived__' &&
          !state.statuses.some(s => s.id === state.docFilter)) {
        state.docFilter = 'all';
      }
      hideModal('status-settings-modal');
      if (state.currentFolderId) loadDocList(state.currentFolderId);
      showToast('ステータスを更新しました');
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .saveStatuses(clean);
}

document.getElementById('status-settings-btn').addEventListener('click', openStatusSettings);
document.getElementById('status-settings-close').addEventListener('click', () => hideModal('status-settings-modal'));
document.getElementById('status-settings-cancel').addEventListener('click', () => hideModal('status-settings-modal'));
document.getElementById('status-add-btn').addEventListener('click', addStatusDraft);
document.getElementById('status-save-btn').addEventListener('click', saveStatusSettings);

// ─── Document view ────────────────────────────────────────────────────────────
function openDocument(docId, docName) {
  state.currentDocId = docId;
  state.currentDocName = docName;
  // Clear the previous doc's draft state up-front so the early switchToViewMode()
  // below doesn't flash that doc's resume banner before this doc's bundle loads.
  state.pendingRevision = null;
  state.draftActive = false;
  showLoading('読み込み中…');
  switchToViewMode();
  // Update sidebar selection
  document.querySelectorAll('#doc-list [data-id]').forEach(el => {
    const active = el.dataset.id === docId;
    el.classList.toggle('bg-indigo-50', active);
    el.classList.toggle('dark:bg-indigo-900/30', active);
    el.classList.toggle('border-l-2', active);
    el.classList.toggle('border-l-indigo-500', active);
  });

  // Load content + threads in a single round trip (see getDocumentBundle): GAS
  // serializes google.script.run calls, so two calls meant two server dispatches.
  google.script.run
    .withSuccessHandler(b => {
      hideLoading();
      state.currentDocContent = b.content;
      state.currentDocLastUpdated = b.lastUpdated || 0;
      state.threads = b.threads;
      state.pendingRevision = b.pendingRevision || null;
      state.draftActive = false;
      renderDocument(b.content, b.threads);
    })
    .withFailureHandler(onError)
    .getDocumentBundle(docId);
}

function renderDocument(content, threads) {
  document.getElementById('doc-title').textContent = state.currentDocName;
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('view-panel').classList.remove('hidden');
  document.getElementById('edit-panel').classList.add('hidden');

  const container = document.getElementById('doc-content');
  container.innerHTML = renderMarkdown(content);
  enhanceContent(container);
  hljs.highlightAll();

  applyCommentAnchors(container, threads);
  renderMermaidBlocks();
  renderThreadList(threads);
  updateViewDraftBanner();
}

// A draft is "stale" when the doc was saved (by anyone) after the draft was generated:
// its baseLastUpdated predates the currently-loaded doc version. Saving it would
// overwrite those intervening edits without tripping the CONFLICT check, so we warn.
function draftStale(draft) {
  return !!(draft && draft.baseLastUpdated && state.currentDocLastUpdated &&
    draft.baseLastUpdated < state.currentDocLastUpdated);
}

// Reflect state.pendingRevision in the view-mode resume banner.
function updateViewDraftBanner() {
  const banner = document.getElementById('view-draft-banner');
  const pr = state.pendingRevision;
  banner.classList.toggle('hidden', !pr);
  banner.classList.toggle('flex', !!pr);
  if (pr) {
    const when = pr.createdAt ? ' · ' + new Date(pr.createdAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
    document.getElementById('view-draft-label').textContent =
      `未保存のAI修正案があります（${pr.model || pr.provider || 'AI'}${when}）。` +
      (draftStale(pr) ? ' ⚠ 作成後に本文が更新されています。' : '');
  }
}

// ─── Markdown rendering ───────────────────────────────────────────────────────
// marked does NOT sanitize HTML, so its output is always run through DOMPurify
// before it reaches innerHTML. Mermaid blocks and link attributes are applied as
// a DOM post-process (enhanceContent) so we don't depend on marked's renderer
// method signatures, which change between major versions.
function renderMarkdown(content) {
  marked.setOptions({ breaks: true, gfm: true });
  let src = content || '';
  // A `<!-- summary -->` (or `<!-- 集計 -->`) marker on its own line right before a
  // pipe table opts that table into the row-count summary (see buildTableSummary).
  // Guarantee a blank line after the marker so the following table still parses as
  // a table instead of being swallowed into the HTML-comment block.
  src = src.replace(/^([ \t]*<!--\s*(?:summary|集計)\s*-->[ \t]*)\r?\n(?=[ \t]*\|)/gim, '$1\n\n');
  let raw = marked.parse(src);
  // DOMPurify strips HTML comments, so carry the opt-in onto the table element as a
  // data attribute (data-* survives sanitization) before the comment is dropped.
  raw = raw.replace(/<!--\s*(?:summary|集計)\s*-->\s*<table/gi, '<table data-summary="1"');
  return DOMPurify.sanitize(raw, { ADD_ATTR: ['target'] });
}

// Run after sanitized HTML is inserted into the DOM.
function enhanceContent(container) {
  // Open links in a new tab safely.
  container.querySelectorAll('a[href]').forEach(a => {
    a.setAttribute('target', '_blank');
    a.setAttribute('rel', 'noopener noreferrer');
  });
  // Convert ```mermaid fenced blocks into mermaid containers.
  container.querySelectorAll('pre > code.language-mermaid').forEach(code => {
    const div = document.createElement('div');
    div.className = 'mermaid';
    div.textContent = code.textContent;
    code.parentElement.replaceWith(div);
  });
  // Tables opted in via the `<!-- summary -->` marker get interactive checkboxes
  // (in the read-only view) plus a pass-rate summary block beneath them.
  const interactive = container.id === 'doc-content';
  container.querySelectorAll('table[data-summary]').forEach((table, idx) => {
    table.dataset.summaryIndex = String(idx); // ordinal among summary tables = source order
    renderSummaryCheckboxes(table, interactive);
    if (table.dataset.summaryDone) return;
    table.dataset.summaryDone = '1';
    const summary = buildTableSummary(table);
    if (summary) table.insertAdjacentElement('afterend', summary);
  });
}

// ─── Table pass-rate summary ──────────────────────────────────────────────────
// Header keywords that identify the status (pass/fail) column and an optional
// grouping (assignee) column. Matching is case-insensitive and substring-based.
const SUMMARY_STATUS_RE = /(結果|判定|ステータス|状態|合否|チェック|status|result|pass|\bok\b)/i;
const SUMMARY_ASSIGNEE_RE = /(担当|責任|アサイン|assignee|owner)/i;

// A cell counts as a pass when its text is one of the recognized "OK" tokens.
function isPassCell(text) {
  const t = (text || '').trim().toLowerCase().replace(/\s+/g, '');
  return /^(ok|済|済み|合格|✓|✔|☑|\[x\])$/.test(t);
}

// Resolve the status column (and optional assignee column) from the header row.
function getSummaryColumns(table) {
  const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
  let statusIdx = headers.findIndex(h => SUMMARY_STATUS_RE.test(h));
  const statusByKeyword = statusIdx !== -1;
  if (statusIdx === -1) statusIdx = headers.length - 1; // fall back to the last column
  const assigneeIdx = headers.findIndex(h => SUMMARY_ASSIGNEE_RE.test(h));
  return { headers, statusIdx, statusByKeyword, assigneeIdx };
}

// True/false pass state for one status cell: a rendered checkbox wins over text.
function cellIsPass(cell) {
  if (!cell) return false;
  const box = cell.querySelector('input[type="checkbox"]');
  return box ? box.checked : isPassCell(cell.textContent);
}

// Replace `[x]` / `[ ]` status cells (and, when the column is keyword-identified,
// empty ones) with checkboxes. Only the read-only view wires up toggling; the live
// preview and AI-review panes render them disabled so they read as plain status.
function renderSummaryCheckboxes(table, interactive) {
  const { statusIdx, statusByKeyword } = getSummaryColumns(table);
  if (statusIdx < 0) return;
  table.querySelectorAll('tbody tr').forEach(tr => {
    const cell = tr.querySelectorAll('td')[statusIdx];
    if (!cell || cell.querySelector('input')) return;
    const raw = cell.textContent.trim();
    const m = /^\[([ xX])\]$/.exec(raw);
    let checked;
    if (m) checked = m[1].toLowerCase() === 'x';
    else if (raw === '' && statusByKeyword) checked = false;
    else return; // leave text values (OK / ✓ / 済 …) as-is
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'table-check';
    input.checked = checked;
    input.dataset.col = String(statusIdx);
    if (interactive) input.addEventListener('change', () => toggleTableCheckbox(input));
    else input.disabled = true;
    cell.textContent = '';
    cell.classList.add('table-check-cell');
    cell.appendChild(input);
  });
}

function buildTableSummary(table) {
  const { statusIdx, assigneeIdx } = getSummaryColumns(table);
  if (!table.querySelector('thead th')) return null;

  let total = 0, pass = 0;
  const groups = new Map(); // assignee label -> { total, pass } (insertion order preserved)
  table.querySelectorAll('tbody tr').forEach(tr => {
    const cells = tr.querySelectorAll('td');
    if (!cells.length) return;
    total++;
    const ok = cellIsPass(cells[statusIdx]) ? 1 : 0;
    pass += ok;
    if (assigneeIdx >= 0) {
      const who = (cells[assigneeIdx] ? cells[assigneeIdx].textContent.trim() : '') || '(未割当)';
      const g = groups.get(who) || { total: 0, pass: 0 };
      g.total++; g.pass += ok;
      groups.set(who, g);
    }
  });
  if (total === 0) return null;

  const pct = (p, t) => {
    const v = t ? (p / t) * 100 : 0;
    return Number.isInteger(v) ? String(v) : v.toFixed(1);
  };
  const fmt = (p, t) => `${p}/${t} 件 (${pct(p, t)}%)`;

  const div = document.createElement('div');
  div.className = 'table-summary';
  const lines = [`<span class="table-summary-label">全体:</span> ${fmt(pass, total)}`];
  if (groups.size) {
    const parts = [...groups.entries()].map(([who, g]) => `${escapeHtml(who)}: ${fmt(g.pass, g.total)}`);
    lines.push(`<span class="table-summary-by">担当者別 — ${parts.join(' ／ ')}</span>`);
  }
  div.innerHTML = lines.join('<br>');
  return div;
}

// Rebuild the summary block directly under a table (used after a live toggle).
function refreshTableSummary(table) {
  const next = table.nextElementSibling;
  if (next && next.classList.contains('table-summary')) next.remove();
  const summary = buildTableSummary(table);
  if (summary) table.insertAdjacentElement('afterend', summary);
}

// Locate the body-row line ranges of each `<!-- summary -->` table in the source,
// in document order (so the Nth entry lines up with the Nth table[data-summary]).
function locateSummaryTables(lines) {
  const markerRe = /^[ \t]*<!--\s*(?:summary|集計)\s*-->[ \t]*$/i;
  const rowRe = /^[ \t]*\|.*\|[ \t]*$/;
  const isDelim = l => rowRe.test(l) && /^[\s|:\-]+$/.test(l) && l.includes('-');
  const tables = [];
  for (let i = 0; i < lines.length; i++) {
    if (!markerRe.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() === '') j++;          // skip blank lines
    if (j >= lines.length || !rowRe.test(lines[j])) continue;         // header row
    if (j + 1 >= lines.length || !isDelim(lines[j + 1])) continue;    // delimiter row
    let k = j + 2;
    const bodyStart = k;
    while (k < lines.length && rowRe.test(lines[k]) && !isDelim(lines[k])) k++;
    tables.push({ bodyStart, bodyEnd: k });
  }
  return tables;
}

// Toggle the bracket token of inner cell `colIndex` (0-based) on a table-row line,
// rewriting only that cell so the rest of the row's formatting is preserved.
function toggleCellInLine(line, colIndex, makeChecked) {
  const pieces = line.split('|'); // rows have leading+trailing pipes → inner cell k is pieces[k+1]
  const target = colIndex + 1;
  if (target < 1 || target >= pieces.length - 1) return null;
  const cell = pieces[target];
  const token = makeChecked ? '[x]' : '[ ]';
  if (/\[[ xX]\]/.test(cell)) pieces[target] = cell.replace(/\[[ xX]\]/, token);
  else if (cell.trim() === '') pieces[target] = ' ' + token + ' ';
  else return null;
  return pieces.join('|');
}

// Persist a checkbox toggle from the read-only view by editing just the one source
// cell. The new content is applied to state optimistically so that rapid successive
// toggles compose on top of each other instead of each racing from stale content;
// the actual save is serialized + coalesced (see saveCheckboxEdits).
let cbSaving = false;  // an updateDocument round-trip is in flight
let cbPending = false; // more toggles landed during the in-flight save
function toggleTableCheckbox(input) {
  const checked = input.checked;
  const table = input.closest('table[data-summary]');
  const tr = input.closest('tr');
  const tableOrdinal = Number(table.dataset.summaryIndex);
  const rowIndex = [...table.querySelectorAll('tbody tr')].indexOf(tr);
  const colIndex = Number(input.dataset.col);
  refreshTableSummary(table); // optimistic: reflect the new count immediately

  const lines = (state.currentDocContent || '').split('\n');
  const t = locateSummaryTables(lines)[tableOrdinal];
  const lineNo = t ? t.bodyStart + rowIndex : -1;
  const updated = (t && rowIndex >= 0 && lineNo < t.bodyEnd)
    ? toggleCellInLine(lines[lineNo], colIndex, checked)
    : null;
  if (updated == null) {
    // DOM/source desync — practically unreachable. Undo the box and warn.
    input.checked = !checked;
    refreshTableSummary(table);
    console.warn('table-summary: could not map checkbox to a source cell');
    showToast('チェック位置を特定できませんでした');
    return;
  }
  lines[lineNo] = updated;
  state.currentDocContent = lines.join('\n'); // next toggle builds on this
  saveCheckboxEdits();
}

// Serialize + coalesce checkbox saves: keep at most one request in flight, and
// since every save ships the whole document, collapse any toggles that pile up
// during the round-trip into a single follow-up save of the latest content.
function saveCheckboxEdits() {
  if (cbSaving) { cbPending = true; return; }
  cbSaving = true;
  cbPending = false;
  const content = state.currentDocContent;
  const docId = state.currentDocId;
  const docName = state.currentDocName;
  google.script.run
    .withSuccessHandler(newLastUpdated => {
      state.currentDocLastUpdated = newLastUpdated || Date.now();
      cbSaving = false;
      if (cbPending) saveCheckboxEdits(); // flush toggles that arrived mid-flight
    })
    .withFailureHandler(e => {
      cbSaving = false;
      cbPending = false;
      // The optimistic DOM/state may now diverge from the server, so re-sync by
      // reloading the authoritative document. This also covers a real CONFLICT
      // from another user editing the same doc concurrently.
      const msg = String((e && e.message) || e);
      showToast(msg.indexOf('CONFLICT') !== -1
        ? '他のユーザーが更新しました。再読み込みします'
        : 'エラー: ' + msg);
      console.error(e);
      openDocument(docId, docName);
    })
    .updateDocument(docId, content, state.currentDocLastUpdated || 0);
}

async function renderMermaidBlocks() {
  const els = document.querySelectorAll('#doc-content .mermaid, #preview-pane .mermaid');
  if (els.length === 0) return;
  const mermaid = await ensureMermaid();
  for (const el of els) {
    if (el.dataset.processed) continue;
    el.dataset.processed = '1';
    try {
      const id = 'mermaid-' + Math.random().toString(36).slice(2);
      const { svg } = await mermaid.render(id, el.textContent);
      el.innerHTML = svg;
    } catch (e) {
      el.innerHTML = `<pre class="text-red-500 text-xs">${escapeHtml(String(e))}</pre>`;
    }
  }
}

// ─── Inline comment anchoring ─────────────────────────────────────────────────
function applyCommentAnchors(container, threads) {
  for (const thread of threads) {
    const anchor = thread.anchor;
    if (!anchor.selectedText) continue;
    wrapAnchorInDOM(container, thread);
  }
  // Click handler for anchors
  container.querySelectorAll('.comment-anchor').forEach(span => {
    span.addEventListener('click', (e) => {
      e.stopPropagation();
      const tid = span.dataset.threadId;
      highlightThread(tid);
    });
  });
}

function wrapAnchorInDOM(container, thread) {
  const target = thread.anchor.selectedText;
  if (!target) return;
  const before = thread.anchor.contextBefore || '';
  const after = thread.anchor.contextAfter || '';

  // Collect every occurrence of the target inside a single text node, scoring
  // each by how well its surrounding text matches the saved context. This lets
  // us pick the right occurrence when the same text appears multiple times.
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  const candidates = [];
  let node;
  while ((node = walker.nextNode())) {
    // Don't wrap inside an existing anchor (avoids nesting / double-counting).
    if (node.parentElement && node.parentElement.closest('.comment-anchor')) continue;
    const txt = node.textContent;
    let from = 0, idx;
    while ((idx = txt.indexOf(target, from)) !== -1) {
      const pre = txt.substring(Math.max(0, idx - before.length), idx);
      const post = txt.substring(idx + target.length, idx + target.length + after.length);
      let score = 0;
      if (before && pre && before.endsWith(pre.slice(-Math.min(before.length, pre.length)))) score++;
      if (after && post && after.startsWith(post.slice(0, Math.min(after.length, post.length)))) score++;
      candidates.push({ node, idx, score });
      from = idx + target.length;
    }
  }
  if (candidates.length === 0) return; // target spans multiple nodes or is gone
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  try {
    const range = document.createRange();
    range.setStart(best.node, best.idx);
    range.setEnd(best.node, best.idx + target.length);
    const span = document.createElement('span');
    span.className = 'comment-anchor' + (thread.status === 'resolved' ? ' resolved' : '');
    span.dataset.threadId = thread.threadId;
    span.title = thread.status === 'resolved' ? '解決済み' : 'コメントあり';
    range.surroundContents(span);
  } catch (e) {
    // surroundContents fails when the range crosses element boundaries — skip.
  }
}

// ─── Thread list rendering ────────────────────────────────────────────────────
function renderThreadList(threads) {
  const container = document.getElementById('thread-list');
  container.innerHTML = '';
  const filtered = state.filterMode === 'open'
    ? threads.filter(t => t.status === 'open')
    : threads;

  if (filtered.length === 0) {
    container.innerHTML = `<div class="text-xs text-gray-400 dark:text-gray-500 text-center py-6">${state.filterMode === 'open' ? '未解決のコメントはありません' : 'コメントはありません'}</div>`;
    return;
  }

  for (const thread of filtered) {
    container.appendChild(buildThreadCard(thread));
  }
}

function buildThreadCard(thread) {
  const card = document.createElement('div');
  card.dataset.threadId = thread.threadId;
  card.className = 'thread-card rounded-lg border p-3 text-sm ' +
    (thread.status === 'resolved'
      ? 'border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 opacity-70'
      : 'border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20');

  const firstComment = thread.comments[0];
  const replyCount = thread.comments.length - 1;
  const isMine = firstComment && firstComment.author === state.currentUser;

  card.innerHTML = `
    <div class="flex items-start justify-between gap-2 mb-2">
      <div class="flex items-center gap-1.5">
        <span class="w-6 h-6 rounded-full bg-indigo-100 dark:bg-indigo-900 text-indigo-600 dark:text-indigo-400 text-xs flex items-center justify-center font-bold flex-shrink-0">${getInitial(firstComment?.authorName || firstComment?.author || '?')}</span>
        <span class="font-medium text-gray-700 dark:text-gray-300 text-xs">${escapeHtml(firstComment?.authorName || firstComment?.author || '?')}</span>
        <span class="text-gray-400 dark:text-gray-500 text-xs">${formatTimeAgo(firstComment?.createdAt)}</span>
      </div>
      ${thread.status === 'resolved'
        ? `<span class="text-xs text-green-600 dark:text-green-400 font-medium flex-shrink-0">✓ 解決済み</span>`
        : `<button class="resolve-btn text-xs text-gray-400 hover:text-green-600 dark:hover:text-green-400 flex-shrink-0" data-id="${thread.threadId}" title="解決済みにする">✓</button>`}
    </div>
    <div class="text-xs text-amber-700 dark:text-amber-300 bg-amber-100 dark:bg-amber-900/30 rounded px-2 py-1 mb-2 italic truncate">"${escapeHtml(thread.anchor.selectedText)}"</div>
    ${firstComment ? `<p class="text-gray-700 dark:text-gray-300 text-xs leading-relaxed">${formatCommentContent(firstComment.content)}</p>` : ''}
    ${isMine && thread.comments.length > 0
      ? `<div class="flex gap-2 mt-1.5">
           <button class="edit-comment-btn text-xs text-gray-400 hover:text-indigo-600 dark:hover:text-indigo-400" data-comment-id="${firstComment.commentId}" data-thread-id="${thread.threadId}">編集</button>
           <button class="delete-comment-btn text-xs text-gray-400 hover:text-red-500" data-comment-id="${firstComment.commentId}" data-thread-id="${thread.threadId}">削除</button>
         </div>`
      : ''}
    ${replyCount > 0 ? `<details class="mt-2"><summary class="text-xs text-indigo-600 dark:text-indigo-400 cursor-pointer">${replyCount}件の返信</summary><div class="reply-list mt-2 space-y-2 pl-2 border-l-2 border-gray-200 dark:border-gray-700">${thread.comments.slice(1).map(c => buildReplyHtml(c, thread.threadId)).join('')}</div></details>` : ''}
    ${thread.status !== 'resolved'
      ? `<button class="reply-btn mt-2 text-xs text-indigo-600 dark:text-indigo-400 hover:underline" data-thread-id="${thread.threadId}">返信する</button>`
      : `<button class="reopen-btn mt-2 text-xs text-gray-400 hover:text-amber-600 dark:hover:text-amber-400 hover:underline" data-thread-id="${thread.threadId}">再開する</button>`}
  `;

  card.querySelector('.resolve-btn')?.addEventListener('click', () => onResolveThread(thread.threadId));
  card.querySelector('.reopen-btn')?.addEventListener('click', () => onReopenThread(thread.threadId));
  card.querySelector('.reply-btn')?.addEventListener('click', () => openReplyModal(thread.threadId));
  card.querySelectorAll('.edit-comment-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const cid = btn.dataset.commentId;
      const comment = thread.comments.find(c => c.commentId === cid);
      if (comment) onEditComment(cid, comment.content, thread.threadId);
    });
  });
  card.querySelectorAll('.delete-comment-btn').forEach(btn => {
    btn.addEventListener('click', () => onDeleteComment(btn.dataset.commentId, thread.threadId));
  });
  return card;
}

function buildReplyHtml(comment, threadId) {
  const isMine = comment.author === state.currentUser;
  return `
    <div class="text-xs py-1">
      <div class="flex items-center gap-1 mb-0.5">
        <span class="font-medium text-gray-600 dark:text-gray-400">${escapeHtml(comment.authorName || comment.author)}</span>
        <span class="text-gray-400 dark:text-gray-500">${formatTimeAgo(comment.createdAt)}</span>
        ${isMine ? `<button class="edit-comment-btn ml-1 text-gray-300 hover:text-indigo-500" data-comment-id="${comment.commentId}" data-thread-id="${threadId}">編集</button>
          <button class="delete-comment-btn text-gray-300 hover:text-red-500" data-comment-id="${comment.commentId}" data-thread-id="${threadId}">削除</button>` : ''}
      </div>
      <p class="text-gray-700 dark:text-gray-300 leading-relaxed">${formatCommentContent(comment.content)}</p>
    </div>`;
}

function highlightThread(threadId) {
  // Scroll to thread card and highlight it
  const card = document.querySelector(`#thread-list [data-thread-id="${threadId}"]`);
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    card.classList.add('active');
    setTimeout(() => card.classList.remove('active'), 2000);
  }
  // Highlight anchor
  document.querySelectorAll('.comment-anchor').forEach(el => el.classList.remove('active'));
  document.querySelectorAll(`.comment-anchor[data-thread-id="${threadId}"]`).forEach(el => el.classList.add('active'));
}

// ─── Selection → new comment ──────────────────────────────────────────────────
let selectionAnchor = null;

document.getElementById('doc-content').addEventListener('mouseup', handleTextSelection);

function handleTextSelection(e) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.toString().trim()) {
    hideTooltip();
    return;
  }
  // Only inside doc-content
  const docContent = document.getElementById('doc-content');
  if (!docContent.contains(sel.anchorNode)) { hideTooltip(); return; }

  const selectedText = sel.toString().trim();
  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();

  // Capture context from the range's start/end boundaries (the Range is always
  // normalized start-before-end, so this is correct for backward selections too).
  const startText = range.startContainer.textContent || '';
  const endText = range.endContainer.textContent || '';
  const contextBefore = startText.substring(Math.max(0, range.startOffset - 20), range.startOffset);
  const contextAfter = endText.substring(range.endOffset, range.endOffset + 20);

  selectionAnchor = { selectedText, contextBefore, contextAfter };

  const tooltip = document.getElementById('comment-tooltip');
  tooltip.style.left = `${rect.left + rect.width / 2 - 70}px`;
  tooltip.style.top = `${rect.top - 40}px`;
  tooltip.style.display = 'block';
}

document.addEventListener('mousedown', (e) => {
  if (!e.target.closest('#comment-tooltip') && !e.target.closest('#comment-modal')) {
    hideTooltip();
  }
});

function hideTooltip() {
  document.getElementById('comment-tooltip').style.display = 'none';
}

document.getElementById('comment-tooltip').addEventListener('click', () => {
  if (!selectionAnchor) return;
  state.pendingAnchor = selectionAnchor;
  document.getElementById('anchor-preview').textContent = `"${selectionAnchor.selectedText}"`;
  document.getElementById('comment-input').value = '';
  showModal('comment-modal');
  document.getElementById('comment-input').focus();
  hideTooltip();
  window.getSelection()?.removeAllRanges();
});

// Comment submit
document.getElementById('comment-submit-btn').addEventListener('click', submitNewThread);
document.getElementById('comment-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitNewThread();
  if (e.key === '@') showMentionDropdown('comment-input', 'mention-dropdown');
});
document.getElementById('comment-cancel-btn').addEventListener('click', () => hideModal('comment-modal'));

function submitNewThread() {
  const raw = document.getElementById('comment-input').value.trim();
  if (!raw || !state.pendingAnchor) return;
  const content = mentionsToEmail(raw);
  const mentions = extractMentions(content);
  showLoading('送信中…');
  hideModal('comment-modal');
  google.script.run
    .withSuccessHandler(thread => {
      hideLoading();
      state.threads.push(thread);
      const container = document.getElementById('doc-content');
      wrapAnchorInDOM(container, thread);
      container.querySelectorAll('.comment-anchor').forEach(span => {
        span.addEventListener('click', e => {
          e.stopPropagation();
          highlightThread(span.dataset.threadId);
        });
      });
      renderThreadList(state.threads);
      refreshDocListSilently();
      showToast('コメントを追加しました');
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .createThread(
      state.currentDocId,
      state.pendingAnchor.selectedText,
      state.pendingAnchor.contextBefore,
      state.pendingAnchor.contextAfter,
      content,
      mentions
    );
}

// ─── Reply modal ──────────────────────────────────────────────────────────────
function openReplyModal(threadId) {
  state.pendingReplyThreadId = threadId;
  document.getElementById('reply-input').value = '';
  showModal('reply-modal');
  document.getElementById('reply-input').focus();
}

document.getElementById('reply-submit-btn').addEventListener('click', submitReply);
document.getElementById('reply-input').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitReply();
  if (e.key === '@') showMentionDropdown('reply-input', 'reply-mention-dropdown');
});
document.getElementById('reply-cancel-btn').addEventListener('click', () => hideModal('reply-modal'));

function submitReply() {
  const raw = document.getElementById('reply-input').value.trim();
  if (!raw || !state.pendingReplyThreadId) return;
  const content = mentionsToEmail(raw);
  const mentions = extractMentions(content);
  showLoading('送信中…');
  hideModal('reply-modal');
  google.script.run
    .withSuccessHandler(comment => {
      hideLoading();
      const thread = state.threads.find(t => t.threadId === state.pendingReplyThreadId);
      if (thread) thread.comments.push(comment);
      renderThreadList(state.threads);
      showToast('返信しました');
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .addReply(state.pendingReplyThreadId, content, mentions);
}

// ─── Resolve / Reopen ─────────────────────────────────────────────────────────
function onResolveThread(threadId) {
  showLoading('処理中…');
  google.script.run
    .withSuccessHandler(() => {
      hideLoading();
      const thread = state.threads.find(t => t.threadId === threadId);
      if (thread) thread.status = 'resolved';
      renderThreadList(state.threads);
      // Update anchor style
      document.querySelectorAll(`.comment-anchor[data-thread-id="${threadId}"]`)
        .forEach(el => { el.classList.add('resolved'); el.title = '解決済み'; });
      refreshDocListSilently();
      showToast('解決済みにしました');
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .resolveThread(threadId);
}

function onReopenThread(threadId) {
  showLoading('処理中…');
  google.script.run
    .withSuccessHandler(() => {
      hideLoading();
      const thread = state.threads.find(t => t.threadId === threadId);
      if (thread) thread.status = 'open';
      renderThreadList(state.threads);
      document.querySelectorAll(`.comment-anchor[data-thread-id="${threadId}"]`)
        .forEach(el => { el.classList.remove('resolved'); el.title = 'コメントあり'; });
      showToast('スレッドを再開しました');
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .reopenThread(threadId);
}

// ─── Edit comment ─────────────────────────────────────────────────────────────
function onEditComment(commentId, currentContent, threadId) {
  const input = prompt('コメントを編集', currentContent);
  if (input === null) return;
  const newContent = mentionsToEmail(input);
  if (!newContent || newContent === currentContent) return;
  google.script.run
    .withSuccessHandler(() => {
      const thread = state.threads.find(t => t.threadId === threadId);
      if (thread) {
        const c = thread.comments.find(c => c.commentId === commentId);
        if (c) c.content = newContent;
      }
      renderThreadList(state.threads);
      showToast('コメントを更新しました');
    })
    .withFailureHandler(onError)
    .editComment(commentId, newContent);
}

function onDeleteComment(commentId, threadId) {
  if (!confirm('このコメントを削除しますか？')) return;
  google.script.run
    .withSuccessHandler(() => {
      const thread = state.threads.find(t => t.threadId === threadId);
      if (thread) thread.comments = thread.comments.filter(c => c.commentId !== commentId);
      renderThreadList(state.threads);
      showToast('コメントを削除しました');
    })
    .withFailureHandler(onError)
    .deleteComment(commentId);
}

// ─── Thread filter ────────────────────────────────────────────────────────────
document.getElementById('filter-open-btn').addEventListener('click', () => {
  state.filterMode = 'open';
  document.getElementById('filter-open-btn').className = 'text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900 text-amber-700 dark:text-amber-300 font-medium border border-amber-300 dark:border-amber-700';
  document.getElementById('filter-all-btn').className = 'text-xs px-2 py-0.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 font-medium';
  renderThreadList(state.threads);
});

document.getElementById('filter-all-btn').addEventListener('click', () => {
  state.filterMode = 'all';
  document.getElementById('filter-all-btn').className = 'text-xs px-2 py-0.5 rounded-full bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-200 font-medium';
  document.getElementById('filter-open-btn').className = 'text-xs px-2 py-0.5 rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 font-medium';
  renderThreadList(state.threads);
});

// ─── Edit mode ────────────────────────────────────────────────────────────────
function switchToViewMode() {
  document.getElementById('view-panel').classList.remove('hidden');
  document.getElementById('edit-panel').classList.add('hidden');
  document.getElementById('empty-state').classList.add('hidden');
  state.draftActive = false;
  setEditDraftBanner(false);
  updateViewDraftBanner(); // a still-pending draft stays visible as a resume banner
}

function switchToEditMode() {
  document.getElementById('view-panel').classList.add('hidden');
  document.getElementById('edit-panel').classList.remove('hidden');
  document.getElementById('empty-state').classList.add('hidden');
  document.getElementById('edit-title').textContent = state.currentDocName;
  const editor = document.getElementById('editor-pane');
  editor.value = state.currentDocContent;
  state.draftActive = false;
  setEditDraftBanner(false);
  setEditLock(false); // clear any stale lock from a prior (navigated-away) generation
  setEditRightView('preview'); // normal edits default to the rendered preview
  setEditReviewPanel(false); // start each edit session with the panel closed
  editor.focus();
}

// Open the editor on an AI-revision draft (vs. the saved doc body). The draft is
// already persisted server-side, so the operator can take their time — close the
// browser, reopen, and resume — instead of judging it on the spot.
function enterDraftEdit(draft) {
  if (!draft) return;
  switchToEditMode();
  const editor = document.getElementById('editor-pane');
  editor.value = draft.content || '';
  state.draftActive = true;
  setEditDraftBanner(true, draft);
  setEditRightView('diff'); // a draft opens on the diff so changes are visible at a glance
  setEditReviewPanel(true); // show the review beside the proposal for comparison
  editor.focus();
}

function setEditDraftBanner(open, draft?) {
  const banner = document.getElementById('edit-draft-banner');
  banner.classList.toggle('hidden', !open);
  banner.classList.toggle('flex', !!open);
  if (open && draft) {
    document.getElementById('edit-draft-label').textContent =
      `AI修正案を表示中（${draft.model || draft.provider || 'AI'}）。内容を確認・手直しして「保存」で確定してください。` +
      (draftStale(draft) ? ' ⚠ この案の作成後に本文が更新されています（差分は最新本文との比較です）。' : '');
  }
}

// Block the editor (with a spinner) while a revision is generated, so no other action
// fires mid-flight; release it once the proposal arrives or generation fails.
function setEditLock(open, msg?) {
  const lock = document.getElementById('edit-lock');
  lock.classList.toggle('hidden', !open);
  lock.classList.toggle('flex', !!open);
  if (open) document.getElementById('edit-lock-msg').textContent = msg || '';
}

document.getElementById('edit-btn').addEventListener('click', switchToEditMode);
document.getElementById('cancel-edit-btn').addEventListener('click', switchToViewMode);
document.getElementById('download-doc-btn').addEventListener('click', () => {
  if (!state.currentDocId) return;
  downloadTextFile(safeFileName(state.currentDocName) + '.md', state.currentDocContent || '');
});
document.getElementById('save-btn').addEventListener('click', () => saveDocument());

document.getElementById('editor-pane').addEventListener('input', updatePreview);

let previewTimer = null;
let editRightView = 'preview'; // 'preview' | 'diff' — what the right column shows
function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const content = document.getElementById('editor-pane').value;
    const preview = document.getElementById('preview-pane');
    if (editRightView === 'diff') {
      // Diff the editor against the *saved* doc body so the operator sees exactly
      // what the AI proposal (or their edits) changed before committing.
      renderDiffInto(preview, state.currentDocContent, content);
      return;
    }
    preview.innerHTML = renderMarkdown(content);
    enhanceContent(preview);
    hljs.highlightAll();
    // Reset mermaid processed flags
    preview.querySelectorAll('.mermaid').forEach(el => delete el.dataset.processed);
    renderMermaidBlocks();
  }, 200);
}

function setEditRightView(mode) {
  editRightView = mode;
  const active = 'px-2 py-0.5 rounded font-medium bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300';
  const inactive = 'px-2 py-0.5 rounded font-medium text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700';
  document.getElementById('edit-view-preview').className = mode === 'preview' ? active : inactive;
  document.getElementById('edit-view-diff').className = mode === 'diff' ? active : inactive;
  updatePreview();
}
document.getElementById('edit-view-preview').addEventListener('click', () => setEditRightView('preview'));
document.getElementById('edit-view-diff').addEventListener('click', () => setEditRightView('diff'));

// Line-level diff via an LCS over lines. Inputs are capped (MAX_REVISE_CHARS) so the
// O(n*m) table stays small; a guard bails out if a pathological line count blows it up.
function lineDiff(oldText, newText) {
  const a = String(oldText || '').split('\n');
  const b = String(newText || '').split('\n');
  const n = a.length, m = b.length;
  if ((n + 1) * (m + 1) > 4000000) return null; // too large to diff cheaply
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const rows = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { rows.push({ t: 'ctx', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { rows.push({ t: 'del', text: a[i] }); i++; }
    else { rows.push({ t: 'add', text: b[j] }); j++; }
  }
  while (i < n) rows.push({ t: 'del', text: a[i++] });
  while (j < m) rows.push({ t: 'add', text: b[j++] });
  return rows;
}

function renderDiffInto(el, oldText, newText) {
  const rows = lineDiff(oldText, newText);
  if (!rows) {
    el.innerHTML = '<div class="text-sm text-gray-400 p-2">差分が大きすぎて表示できません。プレビューでご確認ください。</div>';
    return;
  }
  if (!rows.some(r => r.t !== 'ctx')) {
    el.innerHTML = '<div class="text-sm text-gray-400 p-2">元の本文との差分はありません。</div>';
    return;
  }
  const html = rows.map(r => {
    const cls = r.t === 'add' ? 'diff-add' : r.t === 'del' ? 'diff-del' : 'diff-ctx';
    const sign = r.t === 'add' ? '+' : r.t === 'del' ? '−' : ' ';
    return `<div class="diff-line ${cls}"><span class="diff-sign">${sign}</span>${escapeHtml(r.text) || ' '}</div>`;
  }).join('');
  el.innerHTML = `<div class="diff-view">${html}</div>`;
}

function saveDocument(force?) {
  // A stale AI draft would slip past the server CONFLICT check (it's measured against
  // the version we loaded, not the one the draft was built on). Confirm before clobbering.
  if (!force && state.draftActive && draftStale(state.pendingRevision)) {
    if (!confirm('この修正案の作成後に、別の保存で本文が更新されています。\n\n最新の本文に上書きして保存しますか？\n（「差分」タブで最新本文との違いを確認できます）')) return;
  }
  const content = document.getElementById('editor-pane').value;
  showLoading('保存中…');
  google.script.run
    .withSuccessHandler(newLastUpdated => {
      hideLoading();
      state.currentDocContent = content;
      state.currentDocLastUpdated = newLastUpdated || Date.now();
      // Saving supersedes any pending AI-revision draft for this user+doc.
      if (state.pendingRevision) {
        state.pendingRevision = null;
        google.script.run.withFailureHandler(() => {}).discardPendingRevision(state.currentDocId);
      }
      showToast('保存しました');
      switchToViewMode();
      renderDocument(content, state.threads);
    })
    .withFailureHandler(e => {
      hideLoading();
      const msg = String((e && e.message) || e);
      if (msg.indexOf('CONFLICT') !== -1) {
        // Someone else saved since we opened the doc. Let the user choose.
        if (confirm('他のユーザーがこのドキュメントを更新しました。\n\n「OK」: 相手の変更を読み込み直す（自分の編集内容は破棄されます）\n「キャンセル」: 自分の内容で上書き保存する')) {
          switchToViewMode();
          openDocument(state.currentDocId, state.currentDocName);
        } else {
          saveDocument(true); // force overwrite
        }
      } else {
        onError(e);
      }
    })
    // expectedLastUpdated=0 forces an overwrite (skips the conflict check).
    .updateDocument(state.currentDocId, content, force ? 0 : (state.currentDocLastUpdated || 0));
}

// ─── New document ─────────────────────────────────────────────────────────────
document.getElementById('new-doc-btn').addEventListener('click', () => {
  document.getElementById('new-doc-title').value = '';
  showModal('new-doc-modal');
  document.getElementById('new-doc-title').focus();
});
document.getElementById('new-doc-cancel').addEventListener('click', () => hideModal('new-doc-modal'));
document.getElementById('new-doc-submit').addEventListener('click', createNewDocument);
document.getElementById('new-doc-title').addEventListener('keydown', e => { if (e.key === 'Enter') createNewDocument(); });

function createNewDocument() {
  const title = document.getElementById('new-doc-title').value.trim();
  if (!title || !state.currentFolderId) return;
  showLoading('作成中…');
  hideModal('new-doc-modal');
  google.script.run
    .withSuccessHandler(doc => {
      hideLoading();
      openDocument(doc.id, doc.name);
      loadDocList(state.currentFolderId);
      showToast('ドキュメントを作成しました');
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .createDocument(state.currentFolderId, title);
}

// ─── Upload (.md import) ──────────────────────────────────────────────────────
// Markdown is text, so files are read as UTF-8 strings (no Base64) and sent to
// importDocuments. Large selections are split into payload-bounded batches so a
// single google.script.run call never carries too much.
const UPLOAD_MAX_FILES = 20;
const UPLOAD_MAX_FILE_BYTES = 2 * 1024 * 1024;   // per-file cap (mirrors the server)
const UPLOAD_BATCH_CHARS = 1500000;              // ~per-call payload budget

document.getElementById('upload-btn').addEventListener('click', () => {
  if (!state.currentFolderId) { showToast('先にフォルダを選択してください'); return; }
  document.getElementById('upload-input').value = ''; // allow re-selecting the same file
  document.getElementById('upload-input').click();
});
document.getElementById('upload-input').addEventListener('change', e => {
  handleUploadFiles(e.target.files);
});

// Drag & drop onto the sidebar document list.
(function () {
  const wrap = document.getElementById('doc-list-wrap');
  const zone = document.getElementById('upload-dropzone');
  let depth = 0; // dragenter/leave fire per child; count to know when we've truly left
  const show = on => { zone.classList.toggle('hidden', !on); zone.classList.toggle('flex', on); };
  wrap.addEventListener('dragenter', e => { e.preventDefault(); depth++; if (state.currentFolderId) show(true); });
  wrap.addEventListener('dragover', e => { e.preventDefault(); });
  wrap.addEventListener('dragleave', e => { e.preventDefault(); if (--depth <= 0) { depth = 0; show(false); } });
  wrap.addEventListener('drop', e => {
    e.preventDefault(); depth = 0; show(false);
    if (!state.currentFolderId) { showToast('先にフォルダを選択してください'); return; }
    if (e.dataTransfer && e.dataTransfer.files) handleUploadFiles(e.dataTransfer.files);
  });
})();

function handleUploadFiles(fileList) {
  if (!state.currentFolderId) { showToast('先にフォルダを選択してください'); return; }
  const files = Array.from(fileList || []) as File[];
  if (!files.length) return;
  if (files.length > UPLOAD_MAX_FILES) { showToast(`一度に取り込めるのは ${UPLOAD_MAX_FILES} ファイルまでです`); return; }

  // Validate client-side first so obviously-bad files don't make the round trip.
  const accepted = [], rejected = [];
  files.forEach(f => {
    if (!/\.(md|markdown)$/i.test(f.name)) rejected.push({ name: f.name, ok: false, error: '拡張子が非対応（.md / .markdown）' });
    else if (f.size > UPLOAD_MAX_FILE_BYTES) rejected.push({ name: f.name, ok: false, error: 'サイズ上限超過（2MB）' });
    else accepted.push(f);
  });
  if (!accepted.length) { showUploadResult(rejected); return; }

  showLoading('読み込み中…');
  Promise.all(accepted.map(readFileText))
    .then(payloads => {
      // Group into payload-bounded batches (keeps each google.script.run modest).
      const batches = [];
      let cur = [], curChars = 0;
      payloads.forEach(p => {
        if (cur.length && curChars + p.content.length > UPLOAD_BATCH_CHARS) { batches.push(cur); cur = []; curChars = 0; }
        cur.push(p); curChars += p.content.length;
      });
      if (cur.length) batches.push(cur);
      sendUploadBatches(batches, 0, [], rejected, payloads.length);
    })
    .catch(e => { hideLoading(); onError(e); });
}

function readFileText(file) {
  return new Promise<{ name: string; content: string }>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: file.name, content: String(r.result || '') });
    r.onerror = () => reject(new Error(file.name + ' の読み込みに失敗しました'));
    r.readAsText(file); // UTF-8
  });
}

function sendUploadBatches(batches, idx, acc, rejected, total) {
  if (idx >= batches.length) {
    hideLoading();
    showUploadResult(acc.concat(rejected));
    loadDocList(state.currentFolderId);
    return;
  }
  showLoading(`取込中… (${acc.length}/${total})`);
  google.script.run
    .withSuccessHandler(results => sendUploadBatches(batches, idx + 1, acc.concat(results || []), rejected, total))
    .withFailureHandler(e => {
      hideLoading();
      showUploadResult(acc.concat(rejected).concat([{ name: '(送信エラー)', ok: false, error: String((e && e.message) || e) }]));
      loadDocList(state.currentFolderId);
    })
    .importDocuments(state.currentFolderId, batches[idx]);
}

function showUploadResult(results) {
  const okCount = results.filter(r => r.ok).length;
  const ngCount = results.length - okCount;
  document.getElementById('upload-result-title').textContent =
    `取込結果: 成功 ${okCount} 件${ngCount ? ` / 失敗 ${ngCount} 件` : ''}`;
  const body = document.getElementById('upload-result-body');
  body.innerHTML = results.map(r => {
    const renamed = r.ok && r.docName && r.name.replace(/\.(md|markdown)$/i, '') !== r.docName;
    const note = r.ok
      ? (renamed ? ` → <span class="text-gray-500 dark:text-gray-400">${escapeHtml(r.docName)}</span>` : '')
      : ` <span class="text-red-500">— ${escapeHtml(r.error || 'エラー')}</span>`;
    const icon = r.ok
      ? '<span class="text-emerald-500 flex-shrink-0">✓</span>'
      : '<span class="text-red-500 flex-shrink-0">✗</span>';
    return `<div class="flex items-start gap-2 text-xs px-1 py-0.5"><span class="mt-0.5">${icon}</span><span class="min-w-0 break-words">${escapeHtml(r.name)}${note}</span></div>`;
  }).join('');
  if (okCount) showToast(`${okCount} 件を取り込みました`);
  showModal('upload-result-modal');
}
document.getElementById('upload-result-close').addEventListener('click', () => hideModal('upload-result-modal'));
document.getElementById('upload-result-ok').addEventListener('click', () => hideModal('upload-result-modal'));

// Delete document
document.getElementById('delete-doc-btn').addEventListener('click', () => {
  if (!confirm(`"${state.currentDocName}" を削除しますか？`)) return;
  showLoading('削除中…');
  google.script.run
    .withSuccessHandler(() => {
      hideLoading();
      state.currentDocId = null;
      document.getElementById('view-panel').classList.add('hidden');
      document.getElementById('empty-state').classList.remove('hidden');
      loadDocList(state.currentFolderId);
      showToast('削除しました');
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .deleteDocument(state.currentDocId);
});

// ─── New / linked folder ────────────────────────────────────────────────────
let folderModalMode = 'new'; // 'new' = create a folder, 'link' = attach an existing one

function setFolderMode(mode) {
  folderModalMode = mode;
  const isNew = mode === 'new';
  const active = 'flex-1 px-2 py-1.5 rounded-md bg-indigo-600 text-white font-medium';
  const inactive = 'flex-1 px-2 py-1.5 rounded-md text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700';
  document.getElementById('folder-mode-new').className = isNew ? active : inactive;
  document.getElementById('folder-mode-link').className = isNew ? inactive : active;
  document.getElementById('link-folder-id').classList.toggle('hidden', isNew);
  document.getElementById('link-folder-hint').classList.toggle('hidden', isNew);
  document.getElementById('new-folder-name').placeholder = isNew ? 'フォルダ名' : 'フォルダ名（任意）';
}

document.getElementById('folder-mode-new').addEventListener('click', () => setFolderMode('new'));
document.getElementById('folder-mode-link').addEventListener('click', () => setFolderMode('link'));
document.getElementById('new-folder-cancel').addEventListener('click', () => { hideModal('new-folder-modal'); resetFolderModal(); });
document.getElementById('new-folder-submit').addEventListener('click', submitFolder);
document.getElementById('new-folder-name').addEventListener('keydown', e => { if (e.key === 'Enter') submitFolder(); });
document.getElementById('link-folder-id').addEventListener('keydown', e => { if (e.key === 'Enter') submitFolder(); });

function resetFolderModal() {
  document.getElementById('new-folder-name').value = '';
  document.getElementById('link-folder-id').value = '';
  setFolderMode('new');
}

function onFolderAdded(msg) {
  return folder => {
    hideLoading();
    state.folders.push(folder);
    renderFolderTabs();
    selectFolder(folder.id);
    showToast(msg);
    resetFolderModal();
  };
}

function submitFolder() {
  if (folderModalMode === 'link') {
    const driveId = document.getElementById('link-folder-id').value.trim();
    const name = document.getElementById('new-folder-name').value.trim();
    if (!driveId) return;
    showLoading('リンク中…');
    hideModal('new-folder-modal');
    google.script.run
      .withSuccessHandler(onFolderAdded('フォルダをリンクしました'))
      .withFailureHandler(e => { hideLoading(); onError(e); })
      .linkFolder(driveId, name);
    return;
  }
  const name = document.getElementById('new-folder-name').value.trim();
  if (!name) return;
  showLoading('作成中…');
  hideModal('new-folder-modal');
  google.script.run
    .withSuccessHandler(onFolderAdded('フォルダを作成しました'))
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .createFolder(name);
}

// ─── First-run setup ──────────────────────────────────────────────────────────
function showSetupScreen(isOwner) {
  document.getElementById('setup-owner').classList.toggle('hidden', !isOwner);
  document.getElementById('setup-nonowner').classList.toggle('hidden', !!isOwner);
  const el = document.getElementById('setup-screen');
  el.classList.remove('hidden');
  el.classList.add('flex');
}

document.getElementById('setup-submit').addEventListener('click', () => {
  const folderId = document.getElementById('setup-folder-id').value.trim();
  showLoading('セットアップ中…');
  google.script.run
    .withSuccessHandler(() => {
      const el = document.getElementById('setup-screen');
      el.classList.add('hidden');
      el.classList.remove('flex');
      // The DB now exists; re-fetch the full app state to enter the workspace.
      google.script.run.withSuccessHandler(onAppState).withFailureHandler(onError).getAppState();
    })
    .withFailureHandler(e => { hideLoading(); onError(e); })
    .setupDb(folderId);
});

// ─── Members ──────────────────────────────────────────────────────────────────
document.getElementById('members-btn').addEventListener('click', () => {
  renderMemberList();
  showModal('members-modal');
});
document.getElementById('members-close-btn').addEventListener('click', () => hideModal('members-modal'));

function loadMembers() {
  google.script.run
    .withSuccessHandler(members => {
      state.members = members;
      // Assignee chips/selects depend on the member list; refresh once it loads.
      if (state.docs && state.docs.length) renderDocList();
    })
    .withFailureHandler(() => {})
    .getMembers();
}

function renderMemberList() {
  const list = document.getElementById('member-list');
  list.innerHTML = '';
  if (state.members.length === 0) {
    list.innerHTML = '<div class="text-xs text-gray-400 text-center py-2">メンバーが登録されていません</div>';
    return;
  }
  for (const m of state.members) {
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between py-1.5 px-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700';
    row.innerHTML = `
      <div>
        <span class="text-sm font-medium text-gray-700 dark:text-gray-300">${escapeHtml(m.displayName)}</span>
        <span class="text-xs text-gray-400 dark:text-gray-500 ml-2">${escapeHtml(m.email)}</span>
      </div>
      <button class="remove-member-btn text-xs text-red-400 hover:text-red-600 px-2 py-0.5 rounded hover:bg-red-50 dark:hover:bg-red-900/30" data-email="${escapeHtml(m.email)}">削除</button>`;
    row.querySelector('.remove-member-btn').addEventListener('click', () => {
      if (!confirm(`${m.displayName} を削除しますか？`)) return;
      showLoading('削除中…');
      google.script.run
        .withSuccessHandler(() => {
          hideLoading();
          state.members = state.members.filter(x => x.email !== m.email);
          renderMemberList();
          showToast('メンバーを削除しました');
        })
        .withFailureHandler(e => { hideLoading(); onError(e); })
        .removeMember(m.email);
    });
    list.appendChild(row);
  }
}

document.getElementById('add-member-btn').addEventListener('click', () => {
  const emailEl = document.getElementById('member-email-input');
  const nameEl = document.getElementById('member-name-input');
  const btn = document.getElementById('add-member-btn');
  const email = emailEl.value.trim();
  const name = nameEl.value.trim();
  if (!email || !name) return;
  // Immediate feedback: a GAS round-trip takes ~1s, so disable to avoid double
  // submits and show progress.
  btn.disabled = true;
  btn.textContent = '追加中…';
  google.script.run
    .withSuccessHandler(member => {
      btn.disabled = false;
      btn.textContent = '追加';
      state.members.push(member);
      renderMemberList();
      emailEl.value = '';
      nameEl.value = '';
      showToast('メンバーを追加しました');
    })
    .withFailureHandler(e => {
      btn.disabled = false;
      btn.textContent = '追加';
      onError(e);
    })
    .addMember(email, name);
});

// ─── Mention dropdown ─────────────────────────────────────────────────────────
function showMentionDropdown(inputId, dropdownId) {
  state.activeMentionInput = inputId;
  const dropdown = document.getElementById(dropdownId);
  dropdown.innerHTML = '';
  if (state.members.length === 0) return;

  dropdown.classList.remove('hidden');
  for (const m of state.members) {
    const item = document.createElement('div');
    item.className = 'px-3 py-1.5 hover:bg-indigo-50 dark:hover:bg-indigo-900/30 cursor-pointer text-sm';
    item.innerHTML = `<span class="font-medium">${escapeHtml(m.displayName)}</span> <span class="text-gray-400 text-xs">${escapeHtml(m.email)}</span>`;
    item.addEventListener('click', () => {
      const input = document.getElementById(inputId);
      const val = input.value;
      const atIdx = val.lastIndexOf('@');
      input.value = (atIdx !== -1 ? val.substring(0, atIdx) : val) + `@${m.displayName} `;
      dropdown.classList.add('hidden');
      input.focus();
    });
    dropdown.appendChild(item);
  }
}

// Close mention dropdowns on outside click
document.addEventListener('click', e => {
  if (!e.target.closest('#mention-dropdown') && !e.target.closest('#comment-input'))
    document.getElementById('mention-dropdown').classList.add('hidden');
  if (!e.target.closest('#reply-mention-dropdown') && !e.target.closest('#reply-input'))
    document.getElementById('reply-mention-dropdown').classList.add('hidden');
});

// Converts the human-friendly @表示名 typed in the box (and inserted by the
// mention dropdown) into the @email the server stores and matches on. Longest
// names first so "@田中 太郎" is handled before "@田中". Plain string replace, so
// names with spaces / symbols are safe; a raw @email typed directly still works.
function mentionsToEmail(text) {
  let result = text;
  const sorted = [...state.members].sort((a, b) => (b.displayName || '').length - (a.displayName || '').length);
  for (const m of sorted) {
    if (!m.displayName) continue;
    result = result.split('@' + m.displayName).join('@' + m.email);
  }
  return result;
}

function extractMentions(content) {
  const matches = content.match(/@([\w.+\-@]+)/g) || [];
  return [...new Set(matches.map(m => m.substring(1)))];
}

function formatCommentContent(content) {
  // Mentions are stored as @email (stable for matching/notifications) but shown
  // as @表示名 when the email belongs to a known member.
  return escapeHtml(content).replace(/@([\w.+\-@]+)/g, (full, handle) => {
    const member = state.members.find(x => x.email === handle);
    const label = member ? member.displayName : handle;
    return `<span class="text-indigo-600 dark:text-indigo-400 font-medium" title="@${escapeHtml(handle)}">@${escapeHtml(label)}</span>`;
  });
}

// ─── Notifications ────────────────────────────────────────────────────────────
document.getElementById('notif-btn').addEventListener('click', toggleNotifPanel);
document.getElementById('mark-all-read-btn').addEventListener('click', () => {
  google.script.run
    .withSuccessHandler(() => {
      state.unreadCount = 0;
      updateNotifBadge();
      loadNotifications();
      showToast('すべて既読にしました');
    })
    .withFailureHandler(onError)
    .markAllNotificationsRead();
});

function toggleNotifPanel() {
  const panel = document.getElementById('notif-panel');
  const isHidden = panel.classList.toggle('hidden');
  if (!isHidden) {
    panel.classList.add('flex');
    panel.classList.remove('hidden');
    loadNotifications();
  } else {
    panel.classList.remove('flex');
  }
}

// Close notif panel on outside click
document.addEventListener('click', e => {
  const panel = document.getElementById('notif-panel');
  if (!panel.classList.contains('hidden') && !e.target.closest('#notif-panel') && !e.target.closest('#notif-btn')) {
    panel.classList.add('hidden');
    panel.classList.remove('flex');
  }
});

function loadNotifications() {
  document.getElementById('notif-list').innerHTML = '<div class="p-3 text-xs text-gray-400">読み込み中…</div>';
  google.script.run
    .withSuccessHandler(renderNotifications)
    .withFailureHandler(() => {})
    .getNotifications();
}

function renderNotifications(notifs) {
  const list = document.getElementById('notif-list');
  if (notifs.length === 0) {
    list.innerHTML = '<div class="p-4 text-xs text-gray-400 text-center">通知はありません</div>';
    return;
  }
  list.innerHTML = '';
  for (const n of notifs) {
    const item = document.createElement('div');
    item.className = 'px-3 py-2.5 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer ' +
      (n.isRead ? '' : 'bg-indigo-50 dark:bg-indigo-900/20');
    item.innerHTML = `
      <div class="flex items-start gap-2">
        <span class="text-base mt-0.5 flex-shrink-0">${notifIcon(n.type)}</span>
        <div class="flex-1 min-w-0">
          <p class="text-xs text-gray-700 dark:text-gray-300 leading-snug">${escapeHtml(n.message)}</p>
          <p class="text-xs text-gray-400 dark:text-gray-500 mt-0.5 truncate">${escapeHtml(n.documentName)}</p>
          <p class="text-xs text-gray-400 dark:text-gray-500">${formatTimeAgo(n.createdAt)}</p>
        </div>
        ${!n.isRead ? '<span class="w-2 h-2 bg-indigo-500 rounded-full mt-1 flex-shrink-0"></span>' : ''}
      </div>`;
    item.addEventListener('click', () => {
      if (!n.isRead) {
        google.script.run.withSuccessHandler(() => {}).withFailureHandler(() => {}).markNotificationRead(n.notifId);
        item.classList.remove('bg-indigo-50', 'dark:bg-indigo-900/20');
        state.unreadCount = Math.max(0, state.unreadCount - 1);
        updateNotifBadge();
      }
      if (n.documentId) {
        toggleNotifPanel();
        openDocument(n.documentId, n.documentName);
      }
    });
    list.appendChild(item);
  }
}

function notifIcon(type) {
  return type === 'mention' ? '💬' : type === 'reply' ? '↩️' : '✅';
}

function updateNotifBadge() {
  const badge = document.getElementById('notif-badge');
  if (state.unreadCount > 0) {
    badge.textContent = state.unreadCount > 9 ? '9+' : String(state.unreadCount);
    badge.classList.remove('hidden');
    badge.classList.add('flex');
  } else {
    badge.classList.add('hidden');
    badge.classList.remove('flex');
  }
}

// ─── AI review (multi-provider) ──────────────────────────────────────────────────
const AI_PROVIDER_META = {
  claude: {
    label: 'Claude',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyUrlLabel: 'Anthropic Console',
    modelHelp: '利用したい Claude モデル名（例: claude-opus-4-8, claude-sonnet-4-6, claude-haiku-4-5）。',
  },
  openai: {
    label: 'OpenAI',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyUrlLabel: 'OpenAI Platform',
    modelHelp: '利用したい OpenAI モデル名を入力します（モデル名は変わりうるので最新の提供モデルをご確認ください）。',
  },
  gemini: {
    label: 'Gemini',
    keyUrl: 'https://aistudio.google.com/apikey',
    keyUrlLabel: 'Google AI Studio',
    modelHelp: '利用したい Gemini モデル名（例: gemini-2.5-flash, gemini-2.5-pro）。無料枠のキーは入力が学習に使われる場合があります。',
  },
};

document.getElementById('ai-settings-btn').addEventListener('click', openAiSettings);
document.getElementById('ai-settings-close').addEventListener('click', () => hideModal('ai-settings-modal'));
document.getElementById('ai-settings-cancel').addEventListener('click', () => hideModal('ai-settings-modal'));
document.getElementById('ai-provider-select').addEventListener('change', e => applyProviderToForm(e.target.value));

// Fetch the selected provider's usable models (with the stored key) and offer them
// as <datalist> suggestions. The input stays free-text — model ids change over time,
// so this assists rather than constrains.
document.getElementById('ai-model-fetch-btn').addEventListener('click', () => {
  const provider = document.getElementById('ai-provider-select').value;
  const info = (state.aiProviders && state.aiProviders[provider]) || { hasKey: false };
  if (!info.hasKey) { showToast('先にこのプロバイダのキーを保存してください'); return; }
  const btn = document.getElementById('ai-model-fetch-btn');
  btn.disabled = true;
  btn.textContent = '取得中…';
  google.script.run
    .withSuccessHandler(models => {
      btn.disabled = false;
      btn.textContent = '取得';
      const dl = document.getElementById('ai-model-list');
      dl.innerHTML = '';
      (models || []).forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        dl.appendChild(opt);
      });
      showToast(models && models.length ? `${models.length} 件のモデルを取得しました` : '利用可能なモデルが見つかりませんでした');
    })
    .withFailureHandler(e => { btn.disabled = false; btn.textContent = '取得'; onError(e); })
    .listAiModels(provider);
});

// Fill the key/model fields and help text from the loaded per-provider settings.
function applyProviderToForm(provider) {
  const meta = AI_PROVIDER_META[provider] || AI_PROVIDER_META.claude;
  const info = (state.aiProviders && state.aiProviders[provider]) || { hasKey: false, model: '' };
  document.getElementById('ai-key-label').textContent = meta.label + ' API キー';
  document.getElementById('ai-key-input').value = '';
  document.getElementById('ai-model-input').value = info.model || '';
  document.getElementById('ai-model-list').innerHTML = ''; // suggestions are provider-specific
  document.getElementById('ai-key-status').textContent = info.hasKey
    ? '✓ キーは登録済みです（変更する場合のみ入力）'
    : '⚠ キーが未登録です';
  document.getElementById('ai-key-help').innerHTML =
    '<a href="' + meta.keyUrl + '" target="_blank" class="text-violet-600 dark:text-violet-400 hover:underline">' + meta.keyUrlLabel + '</a>'
    + ' でキーを取得できます。キーはあなた専用に保存され、他のメンバーには共有されません。';
  document.getElementById('ai-model-help').textContent = meta.modelHelp;
}

function openAiSettings() {
  const status = document.getElementById('ai-key-status');
  status.textContent = '読み込み中…';
  showModal('ai-settings-modal');
  google.script.run
    .withSuccessHandler(s => {
      state.aiProvider = s.provider || 'claude';
      state.aiProviders = s.providers || {};
      state.hasAiKey = !!(state.aiProviders[state.aiProvider] && state.aiProviders[state.aiProvider].hasKey);
      if (s.github) state.github = s.github;
      document.getElementById('ai-provider-select').value = state.aiProvider;
      applyProviderToForm(state.aiProvider);
      applyGithubToForm();
    })
    .withFailureHandler(e => { status.textContent = ''; onError(e); })
    .getAiSettings();
}

// Reflect state.github into the GitHub section (statuses, owner-only block, repo).
function applyGithubToForm() {
  const g: any = state.github || {};
  document.getElementById('gh-pat-input').value = '';
  document.getElementById('gh-pat-status').textContent = g.hasUserPat
    ? '✓ あなたの PAT は登録済み（変更時のみ入力）'
    : (g.hasSharedPat ? '— 共有 PAT を使用します（個人 PAT 未登録）' : '⚠ PAT が未登録です');
  document.getElementById('gh-owner-block').classList.toggle('hidden', !g.isOwner);
  if (g.isOwner) {
    document.getElementById('gh-shared-pat-input').value = '';
    document.getElementById('gh-shared-pat-status').textContent = g.hasSharedPat ? '✓ 共有 PAT は登録済み（変更時のみ入力）' : '未登録';
    document.getElementById('gh-repo-input').value = g.repo || '';
  }
  document.getElementById('gh-repo-current').textContent = g.repo
    ? `既定リポジトリ: ${g.repo}` : '既定リポジトリ: 未設定（レビュー時に指定が必要）';
}

// Persist state.github from a saver's returned AiSettings and refresh the section.
function applyGithubSettings(s) {
  if (s && s.github) state.github = s.github;
  state.githubReady = !!(state.github.hasUserPat || state.github.hasSharedPat);
  applyGithubToForm();
}

// Show/configure the repo-grounded review toggle. Available whenever a PAT is usable
// (own or shared) — the repo context is fetched via REST and injected, so it works for
// any provider. state.githubReady comes from getAppState at load and is kept fresh by
// the settings modal, so no extra round trip on review open.
function setupRepoReviewRow() {
  const row = document.getElementById('ai-review-repo-row');
  const toggle = document.getElementById('ai-review-repo-toggle');
  const input = document.getElementById('ai-review-repo-input');
  const usable = state.githubReady;
  row.classList.toggle('hidden', !usable);
  toggle.checked = false;
  input.classList.add('hidden');
  input.value = '';
  input.placeholder = state.github.repo ? `owner/name（空欄なら ${state.github.repo}）` : 'owner/name（既定リポ未設定・指定必須）';
}
document.getElementById('ai-review-repo-toggle').addEventListener('change', e => {
  document.getElementById('ai-review-repo-input').classList.toggle('hidden', !e.target.checked);
});

document.getElementById('gh-pat-save').addEventListener('click', () => {
  const v = document.getElementById('gh-pat-input').value.trim();
  if (!v) { showToast('PAT を入力してください'); return; }
  google.script.run.withSuccessHandler(s => { applyGithubSettings(s); showToast('GitHub PAT を保存しました'); })
    .withFailureHandler(onError).saveGithubPat('user', v);
});
document.getElementById('gh-pat-clear').addEventListener('click', () => {
  if (!confirm('あなたの GitHub PAT を削除しますか？')) return;
  google.script.run.withSuccessHandler(s => { applyGithubSettings(s); showToast('PAT を削除しました'); })
    .withFailureHandler(onError).clearGithubPat('user');
});
document.getElementById('gh-shared-pat-save').addEventListener('click', () => {
  const v = document.getElementById('gh-shared-pat-input').value.trim();
  if (!v) { showToast('共有 PAT を入力してください'); return; }
  google.script.run.withSuccessHandler(s => { applyGithubSettings(s); showToast('共有 PAT を保存しました'); })
    .withFailureHandler(onError).saveGithubPat('shared', v);
});
document.getElementById('gh-shared-pat-clear').addEventListener('click', () => {
  if (!confirm('共有 GitHub PAT を削除しますか？')) return;
  google.script.run.withSuccessHandler(s => { applyGithubSettings(s); showToast('共有 PAT を削除しました'); })
    .withFailureHandler(onError).clearGithubPat('shared');
});
document.getElementById('gh-repo-save').addEventListener('click', () => {
  const v = document.getElementById('gh-repo-input').value.trim();
  google.script.run.withSuccessHandler(s => { applyGithubSettings(s); showToast('対象リポジトリを保存しました'); })
    .withFailureHandler(onError).saveGithubRepo(v);
});

document.getElementById('ai-settings-save').addEventListener('click', () => {
  const btn = document.getElementById('ai-settings-save');
  const provider = document.getElementById('ai-provider-select').value;
  const key = document.getElementById('ai-key-input').value.trim();
  const model = document.getElementById('ai-model-input').value.trim();
  btn.disabled = true;
  btn.textContent = '保存中…';
  google.script.run
    .withSuccessHandler(s => {
      btn.disabled = false;
      btn.textContent = '保存';
      state.aiProvider = s.provider || 'claude';
      state.aiProviders = s.providers || {};
      state.hasAiKey = !!(state.aiProviders[state.aiProvider] && state.aiProviders[state.aiProvider].hasKey);
      hideModal('ai-settings-modal');
      showToast('AI設定を保存しました');
    })
    .withFailureHandler(e => { btn.disabled = false; btn.textContent = '保存'; onError(e); })
    .saveAiSettings(provider, key, model);
});

document.getElementById('ai-key-clear-btn').addEventListener('click', () => {
  const provider = document.getElementById('ai-provider-select').value;
  const meta = AI_PROVIDER_META[provider] || AI_PROVIDER_META.claude;
  if (!confirm('登録した ' + meta.label + ' APIキーを削除しますか？')) return;
  google.script.run
    .withSuccessHandler(s => {
      state.aiProviders = s.providers || {};
      state.hasAiKey = !!(state.aiProviders[state.aiProvider] && state.aiProviders[state.aiProvider].hasKey);
      applyProviderToForm(provider);
      showToast('APIキーを削除しました');
    })
    .withFailureHandler(onError)
    .clearAiKey(provider);
});

let reviewHistory = []; // saved reviews for the current doc, newest first

document.getElementById('ai-review-btn').addEventListener('click', () => {
  if (!state.currentDocId) return;
  if (!state.hasAiKey) {
    showToast('先にAI設定でAPIキーを登録してください');
    openAiSettings();
    return;
  }
  document.getElementById('ai-review-instructions').value = '';
  reviewHistory = [];
  setupRepoReviewRow();
  showModal('ai-review-modal');
  // Show saved reviews first (don't auto-run — a fresh review costs an API call).
  const body = document.getElementById('ai-review-body');
  body.innerHTML = '<div class="flex items-center justify-center py-10 text-sm text-gray-400">読み込み中…</div>';
  google.script.run
    .withSuccessHandler(list => { reviewHistory = list || []; renderReviewHistory(); })
    .withFailureHandler(e => { body.innerHTML = ''; onError(e); })
    .getReviews(state.currentDocId);
});
document.getElementById('ai-review-close').addEventListener('click', () => hideModal('ai-review-modal'));
document.getElementById('ai-review-rerun').addEventListener('click', runAiReview);
document.getElementById('ai-review-download').addEventListener('click', () => {
  const r = reviewHistory[Number(document.getElementById('ai-review-history').value || 0)];
  if (!r) return;
  const stamp = r.createdAt ? r.createdAt.slice(0, 10) : '';
  downloadTextFile(`${safeFileName(state.currentDocName)}-review${stamp ? '-' + stamp : ''}.md`, r.content);
});
document.getElementById('ai-review-history').addEventListener('change', e => showReview(Number(e.target.value)));

// ─── AI revision (apply review → human-judged save) ───────────────────────────
// Generating a revision drops the operator straight into the editor with the proposed
// body loaded as a *persisted* draft (full height, scrollable). They read/edit it at
// leisure and save through the normal updateDocument path — no cramped modal, no
// now-or-never decision, and the draft survives the browser being closed.
document.getElementById('ai-review-propose').addEventListener('click', () => {
  const r = reviewHistory[Number(document.getElementById('ai-review-history').value || 0)];
  if (!r || !state.currentDocId) return;
  const docId = state.currentDocId; // guard against a doc switch mid-generation
  hideModal('ai-review-modal');
  switchToEditMode();
  setEditReviewPanel(true);
  setEditLock(true, 'AIが修正案を作成中です…（数十秒かかることがあります）');
  google.script.run
    .withSuccessHandler(res => {
      if (state.currentDocId !== docId) return; // user navigated away; draft is saved server-side
      setEditLock(false);
      const draft = { content: res.revised, provider: res.provider, model: res.model, createdAt: res.createdAt, baseLastUpdated: res.baseLastUpdated };
      state.pendingRevision = draft;
      const editor = document.getElementById('editor-pane');
      editor.value = res.revised;
      state.draftActive = true;
      setEditDraftBanner(true, draft);
      setEditRightView('diff'); // land on the diff so the change is obvious immediately
    })
    .withFailureHandler(e => {
      if (state.currentDocId !== docId) { onError(e); return; }
      setEditLock(false);
      switchToViewMode();
      onError(e);
    })
    .proposeRevision(docId, r.content, '');
});

// Resume a previously-generated draft from the view-mode banner.
document.getElementById('view-draft-open').addEventListener('click', () => {
  if (state.pendingRevision) enterDraftEdit(state.pendingRevision);
});
document.getElementById('view-draft-discard').addEventListener('click', () => discardDraft());
document.getElementById('edit-draft-discard').addEventListener('click', () => {
  // Drop the AI proposal and fall back to the saved doc body in the editor.
  document.getElementById('editor-pane').value = state.currentDocContent;
  state.draftActive = false;
  setEditDraftBanner(false);
  updatePreview();
  discardDraft(true); // keep editing; just clear the pending draft server-side
});

// Discard the persisted draft (server + state). `keepEditing` leaves the editor open.
function discardDraft(keepEditing?) {
  const docId = state.currentDocId;
  if (state.pendingRevision && docId) {
    google.script.run.withFailureHandler(() => {}).discardPendingRevision(docId);
  }
  state.pendingRevision = null;
  if (!keepEditing) updateViewDraftBanner();
}

function reviewLabel(r) {
  const when = r.createdAt ? new Date(r.createdAt).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }) : '';
  const who = r.createdByName ? ' · ' + r.createdByName : '';
  return `${r.model || r.provider || 'AI'} — ${when}${who}`;
}

// Populate the history dropdown and show the newest review (or an empty state).
function renderReviewHistory() {
  const sel = document.getElementById('ai-review-history');
  const body = document.getElementById('ai-review-body');
  const toEdit = document.getElementById('ai-review-to-edit');
  const dl = document.getElementById('ai-review-download');
  const propose = document.getElementById('ai-review-propose');
  sel.innerHTML = '';
  toEdit.classList.toggle('hidden', !reviewHistory.length); // only useful once a review exists
  dl.classList.toggle('hidden', !reviewHistory.length);
  propose.classList.toggle('hidden', !reviewHistory.length);
  if (!reviewHistory.length) {
    sel.classList.add('hidden');
    body.innerHTML = '<div class="flex items-center justify-center py-10 text-sm text-gray-400">まだレビューがありません。「レビュー実行」で作成できます。</div>';
    return;
  }
  sel.classList.remove('hidden');
  reviewHistory.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = reviewLabel(r);
    sel.appendChild(opt);
  });
  sel.value = '0';
  showReview(0);
}

function showReview(i) {
  const r = reviewHistory[i];
  const body = document.getElementById('ai-review-body');
  if (!r) { body.innerHTML = ''; return; }
  body.innerHTML = renderMarkdown(r.content);
  enhanceContent(body);
  hljs.highlightAll();
}

// Fetch saved reviews for the current doc into reviewHistory, then run cb.
function loadReviewsThen(cb) {
  const docId = state.currentDocId;
  if (!docId) return;
  google.script.run
    .withSuccessHandler(list => { reviewHistory = list || []; cb(); })
    .withFailureHandler(onError)
    .getReviews(docId);
}

// ─── Review reference panel (edit mode) ───────────────────────────────────────
// Lets the worker read a saved review beside the editor while revising the source,
// instead of losing it when the modal closes. Reuses the same reviewHistory data.
document.getElementById('edit-review-history').addEventListener('change', e => showEditReview(Number(e.target.value)));
document.getElementById('edit-review-toggle').addEventListener('click', () => {
  const panel = document.getElementById('edit-review-panel');
  setEditReviewPanel(panel.classList.contains('hidden'));
});
document.getElementById('ai-review-to-edit').addEventListener('click', () => {
  hideModal('ai-review-modal');
  switchToEditMode();
  setEditReviewPanel(true);
});

function setEditReviewPanel(open) {
  const panel = document.getElementById('edit-review-panel');
  const btn = document.getElementById('edit-review-toggle');
  panel.classList.toggle('hidden', !open);
  btn.classList.toggle('bg-violet-100', open);
  btn.classList.toggle('dark:bg-violet-900/40', open);
  if (open) loadReviewsThen(renderEditReviewPanel); // refetch so it reflects newly-saved reviews
}

function renderEditReviewPanel() {
  const sel = document.getElementById('edit-review-history');
  const body = document.getElementById('edit-review-body');
  sel.innerHTML = '';
  if (!reviewHistory.length) {
    sel.classList.add('hidden');
    body.innerHTML = '<div class="text-sm text-gray-400 p-4">保存されたレビューがありません。ビュー画面の「AIレビュー」から作成できます。</div>';
    return;
  }
  sel.classList.remove('hidden');
  reviewHistory.forEach((r, i) => {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = reviewLabel(r);
    sel.appendChild(opt);
  });
  sel.value = '0';
  showEditReview(0);
}

function showEditReview(i) {
  const r = reviewHistory[i];
  const body = document.getElementById('edit-review-body');
  if (!r) { body.innerHTML = ''; return; }
  body.innerHTML = renderMarkdown(r.content);
  enhanceContent(body);
}

function runAiReview() {
  const body = document.getElementById('ai-review-body');
  const rerun = document.getElementById('ai-review-rerun');
  const instructions = document.getElementById('ai-review-instructions').value.trim();
  const docId = state.currentDocId;
  if (!docId) return;
  const useRepo = !document.getElementById('ai-review-repo-row').classList.contains('hidden')
    && document.getElementById('ai-review-repo-toggle').checked;
  const repoOverride = document.getElementById('ai-review-repo-input').value.trim();
  rerun.disabled = true;
  rerun.textContent = 'レビュー中…';
  document.getElementById('ai-review-history').classList.add('hidden');
  body.innerHTML = useRepo
    ? '<div class="flex items-center justify-center py-10 text-sm text-gray-400 text-center px-4">リポジトリを取得して照合レビュー中です…<br>（ファイル取得のぶん少し時間がかかります）</div>'
    : '<div class="flex items-center justify-center py-10 text-sm text-gray-400">AIがレビュー中です…（数十秒かかることがあります）</div>';
  const onSuccess = res => {
    rerun.disabled = false;
    rerun.textContent = 'レビュー実行';
    // The new review was saved server-side; prepend it so it becomes the newest.
    reviewHistory.unshift({
      id: '', documentId: docId, provider: res.provider, model: res.model,
      content: res.review, createdBy: '', createdByName: res.createdByName || '', createdAt: res.createdAt,
    });
    renderReviewHistory();
  };
  const onFailure = e => {
    rerun.disabled = false;
    rerun.textContent = 'レビュー実行';
    if (reviewHistory.length) document.getElementById('ai-review-history').classList.remove('hidden');
    body.innerHTML = `<div class="text-sm text-red-500 px-2 py-4">エラー: ${escapeHtml(String(e.message || e))}</div>`;
  };
  const runner = google.script.run.withSuccessHandler(onSuccess).withFailureHandler(onFailure);
  if (useRepo) runner.reviewDocumentRepo(docId, instructions, repoOverride);
  else runner.reviewDocument(docId, instructions);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Trigger a client-side download of `text` as a file (no server round trip — the
// content is already in the client). Used to export the doc body and AI reviews so
// operators can feed both to an external AI of their choice.
function downloadTextFile(filename, text) {
  const blob = new Blob([text != null ? text : ''], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function safeFileName(name) {
  return (String(name || '').replace(/[\\/:*?"<>|]/g, '_').trim()) || 'document';
}

function showModal(id) {
  const el = document.getElementById(id);
  el.classList.remove('hidden');
  el.classList.add('flex');
}
function hideModal(id) {
  const el = document.getElementById(id);
  el.classList.add('hidden');
  el.classList.remove('flex');
}
function showLoading(msg) {
  document.getElementById('loading-msg').textContent = msg || '処理中…';
  const el = document.getElementById('loading');
  el.classList.remove('hidden');
  el.classList.add('flex');
}
function hideLoading() {
  const el = document.getElementById('loading');
  el.classList.add('hidden');
  el.classList.remove('flex');
}

let toastTimer = null;
function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add('hidden'), 2500);
}

function onError(e) {
  hideLoading();
  showToast('エラー: ' + String(e.message || e));
  console.error(e);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

function getInitial(name) {
  return (name || '?').charAt(0).toUpperCase();
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
}

function formatTimeAgo(iso) {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'たった今';
  if (m < 60) return `${m}分前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}時間前`;
  const d = Math.floor(h / 24);
  return `${d}日前`;
}

function refreshDocListSilently() {
  if (!state.currentFolderId) return;
  google.script.run
    .withSuccessHandler(docs => renderDocList(docs))
    .withFailureHandler(() => {})
    .getDocumentList(state.currentFolderId);
}

// Close modals on backdrop click
['comment-modal','reply-modal','new-doc-modal','new-folder-modal','ai-settings-modal','ai-review-modal','upload-result-modal'].forEach(id => {
  document.getElementById(id).addEventListener('click', e => {
    if (e.target === document.getElementById(id)) hideModal(id);
  });
});
