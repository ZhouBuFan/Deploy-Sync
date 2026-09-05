import * as path from 'path';
import * as vscode from 'vscode';
import { isDirExcluded } from './config';

/** vscode.git 扩展 API 的最小声明，只取本插件用到的部分 */
interface GitChange {
  uri: vscode.Uri;
  originalUri: vscode.Uri;
  status: number;
}

interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    workingTreeChanges: GitChange[];
    indexChanges: GitChange[];
    mergeChanges: GitChange[];
    onDidChange: vscode.Event<void>;
  };
}

interface GitApi {
  state: 'uninitialized' | 'initialized';
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
  onDidCloseRepository: vscode.Event<GitRepository>;
  onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
}

interface GitExtension {
  getAPI(version: 1): GitApi;
}

const enum GitStatus {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9
}

export interface FileNode {
  kind: 'file';
  resourceUri: vscode.Uri;
  relativePath: string;
  status: number;
  staged: boolean;
}

export interface FolderNode {
  kind: 'folder';
  resourceUri: vscode.Uri;
  relativePath: string;
  label: string;
  children: ChangesNode[];
}

interface MessageNode {
  kind: 'message';
  message: string;
}

export type ChangesNode = FileNode | FolderNode | MessageNode;

function statusLabel(status: number, staged: boolean): string {
  const base = (() => {
    switch (status) {
      case GitStatus.INDEX_ADDED:
      case GitStatus.INTENT_TO_ADD:
        return '新增';
      case GitStatus.UNTRACKED:
        return '未跟踪';
      case GitStatus.INDEX_DELETED:
      case GitStatus.DELETED:
        return '已删除';
      case GitStatus.INDEX_RENAMED:
        return '重命名';
      case GitStatus.INDEX_COPIED:
        return '复制';
      default:
        return '已修改';
    }
  })();
  return staged ? `${base}·已暂存` : base;
}

export function isDeleted(status: number): boolean {
  return status === GitStatus.DELETED || status === GitStatus.INDEX_DELETED;
}

export function collectFiles(node: ChangesNode): FileNode[] {
  if (node.kind === 'file') {
    return [node];
  }
  if (node.kind === 'folder') {
    return node.children.flatMap(collectFiles);
  }
  return [];
}

export class GitChangesProvider implements vscode.TreeDataProvider<ChangesNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private api: GitApi | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<string, vscode.Disposable>();
  private refreshTimer: NodeJS.Timeout | undefined;
  /** 取消勾选的文件，默认全部勾选 */
  private readonly unchecked = new Set<string>();
  private roots: ChangesNode[] = [];

  constructor() {
    void this.init();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.repoListeners.forEach((d) => d.dispose());
    this.emitter.dispose();
  }

  refresh(): void {
    this.emitter.fire();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => this.refresh(), 300);
  }

  private async init(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!extension) {
      return;
    }
    const exports = extension.isActive ? extension.exports : await extension.activate();
    this.api = exports.getAPI(1);
    this.disposables.push(
      this.api.onDidChangeState(() => this.scheduleRefresh()),
      this.api.onDidOpenRepository((repo) => {
        this.watch(repo);
        this.scheduleRefresh();
      }),
      this.api.onDidCloseRepository((repo) => {
        this.repoListeners.get(repo.rootUri.toString())?.dispose();
        this.repoListeners.delete(repo.rootUri.toString());
        this.scheduleRefresh();
      })
    );
    this.api.repositories.forEach((repo) => this.watch(repo));
    this.refresh();
  }

  private watch(repo: GitRepository): void {
    const key = repo.rootUri.toString();
    if (this.repoListeners.has(key)) {
      return;
    }
    this.repoListeners.set(key, repo.state.onDidChange(() => this.scheduleRefresh()));
  }

  getTreeItem(node: ChangesNode): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.message);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }

    if (node.kind === 'folder') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      const files = collectFiles(node);
      const excluded = isFolderExcluded(node.resourceUri);
      item.resourceUri = node.resourceUri;
      item.iconPath = vscode.ThemeIcon.Folder;
      item.description = excluded ? `${files.length} 个文件 · 已排除` : `${files.length} 个文件`;
      item.tooltip = node.resourceUri.fsPath;
      item.contextValue = excluded ? 'deploySyncFolderExcluded' : 'deploySyncFolder';
      item.checkboxState = files.every((file) => this.isChecked(file))
        ? vscode.TreeItemCheckboxState.Checked
        : vscode.TreeItemCheckboxState.Unchecked;
      return item;
    }

    const item = new vscode.TreeItem(path.basename(node.relativePath));
    item.resourceUri = node.resourceUri;
    item.description = statusLabel(node.status, node.staged);
    item.tooltip = node.resourceUri.fsPath;
    item.contextValue = isDeleted(node.status) ? 'deploySyncDeleted' : 'deploySyncChange';
    item.checkboxState = this.isChecked(node)
      ? vscode.TreeItemCheckboxState.Checked
      : vscode.TreeItemCheckboxState.Unchecked;
    if (!isDeleted(node.status)) {
      item.command = {
        command: 'vscode.open',
        title: '打开文件',
        arguments: [node.resourceUri]
      };
    }
    return item;
  }

  getChildren(node?: ChangesNode): ChangesNode[] {
    if (node) {
      return node.kind === 'folder' ? node.children : [];
    }
    if (!this.api) {
      return [{ kind: 'message', message: '未找到内置 Git 扩展' }];
    }
    if (this.api.repositories.length === 0) {
      return [{ kind: 'message', message: '当前项目不是 Git 仓库' }];
    }
    this.roots = this.buildTree();
    if (this.roots.length === 0) {
      return [{ kind: 'message', message: '没有未提交的更改' }];
    }
    return this.roots;
  }

  /** 勾选状态变化：目录会级联到其下所有文件 */
  handleCheckboxChange(items: ReadonlyArray<[ChangesNode, vscode.TreeItemCheckboxState]>): void {
    for (const [node, state] of items) {
      const checked = state === vscode.TreeItemCheckboxState.Checked;
      for (const file of collectFiles(node)) {
        if (checked) {
          this.unchecked.delete(file.resourceUri.toString());
        } else {
          this.unchecked.add(file.resourceUri.toString());
        }
      }
    }
    this.refresh();
  }

  setAllChecked(checked: boolean): void {
    if (checked) {
      this.unchecked.clear();
    } else {
      this.allFiles().forEach((file) => this.unchecked.add(file.resourceUri.toString()));
    }
    this.refresh();
  }

  private isChecked(file: FileNode): boolean {
    return !this.unchecked.has(file.resourceUri.toString());
  }

  /** 勾选且可上传（排除已删除）的文件 */
  checkedFiles(): vscode.Uri[] {
    return this.allFiles()
      .filter((file) => this.isChecked(file) && !isDeleted(file.status))
      .map((file) => file.resourceUri);
  }

  allFiles(): FileNode[] {
    return this.buildTree().flatMap(collectFiles);
  }

  private buildTree(): ChangesNode[] {
    const changes = this.collect();
    if (changes.length === 0) {
      return [];
    }
    const multiRepo = new Set(changes.map((c) => c.root)).size > 1;
    const roots: ChangesNode[] = [];

    for (const root of new Set(changes.map((c) => c.root))) {
      const rootUri = vscode.Uri.file(root);
      const folder: FolderNode = {
        kind: 'folder',
        resourceUri: rootUri,
        relativePath: '',
        label: path.basename(root),
        children: []
      };
      const dirs = new Map<string, FolderNode>();
      dirs.set('', folder);

      const ensureDir = (relDir: string): FolderNode => {
        const existing = dirs.get(relDir);
        if (existing) {
          return existing;
        }
        const parent = ensureDir(path.dirname(relDir) === '.' ? '' : path.dirname(relDir));
        const node: FolderNode = {
          kind: 'folder',
          resourceUri: vscode.Uri.file(path.join(root, relDir)),
          relativePath: relDir,
          label: path.basename(relDir),
          children: []
        };
        parent.children.push(node);
        dirs.set(relDir, node);
        return node;
      };

      for (const change of changes.filter((c) => c.root === root)) {
        const relDir = path.dirname(change.file.relativePath);
        ensureDir(relDir === '.' ? '' : relDir).children.push(change.file);
      }

      sortFolder(folder);
      if (multiRepo) {
        roots.push(folder);
      } else {
        roots.push(...folder.children);
      }
    }
    return roots;
  }

  /** 收集所有仓库的未提交更改，同一文件同时存在于暂存区和工作区时只保留一条 */
  private collect(): Array<{ root: string; file: FileNode }> {
    if (!this.api) {
      return [];
    }
    const map = new Map<string, { root: string; file: FileNode }>();
    for (const repo of this.api.repositories) {
      const root = repo.rootUri.fsPath;
      const groups: Array<{ list: GitChange[]; staged: boolean }> = [
        { list: repo.state.indexChanges, staged: true },
        { list: repo.state.workingTreeChanges, staged: false },
        { list: repo.state.mergeChanges, staged: false }
      ];
      for (const group of groups) {
        for (const change of group.list) {
          if (change.status === GitStatus.IGNORED) {
            continue;
          }
          const key = change.uri.toString();
          const existing = map.get(key);
          if (existing) {
            existing.file.staged = existing.file.staged && group.staged;
            continue;
          }
          map.set(key, {
            root,
            file: {
              kind: 'file',
              resourceUri: change.uri,
              relativePath: path.relative(root, change.uri.fsPath),
              status: change.status,
              staged: group.staged
            }
          });
        }
      }
    }
    return [...map.values()];
  }
}

export function isFolderExcluded(uri: vscode.Uri): boolean {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return false;
  }
  const relative = path.relative(folder.uri.fsPath, uri.fsPath);
  if (relative === '' || relative.startsWith('..')) {
    return false;
  }
  return isDirExcluded(uri, relative);
}

function sortFolder(folder: FolderNode): void {  folder.children.sort((a, b) => {
    const aFolder = a.kind === 'folder';
    const bFolder = b.kind === 'folder';
    if (aFolder !== bFolder) {
      return aFolder ? -1 : 1;
    }
    const aLabel = a.kind === 'message' ? '' : path.basename(a.relativePath);
    const bLabel = b.kind === 'message' ? '' : path.basename(b.relativePath);
    return aLabel.localeCompare(bLabel);
  });
  folder.children.filter((child): child is FolderNode => child.kind === 'folder').forEach(sortFolder);
}
