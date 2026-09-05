import * as path from 'path';
import * as vscode from 'vscode';

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

export interface ChangeNode {
  kind: 'change';
  resourceUri: vscode.Uri;
  relativePath: string;
  status: number;
  staged: boolean;
}

interface MessageNode {
  kind: 'message';
  message: string;
}

export type ChangesNode = ChangeNode | MessageNode;

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

function isDeleted(status: number): boolean {
  return status === GitStatus.DELETED || status === GitStatus.INDEX_DELETED;
}

export class GitChangesProvider implements vscode.TreeDataProvider<ChangesNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;

  private api: GitApi | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly repoListeners = new Map<string, vscode.Disposable>();
  private refreshTimer: NodeJS.Timeout | undefined;

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

    const item = new vscode.TreeItem(path.basename(node.relativePath));
    const dir = path.dirname(node.relativePath);
    item.resourceUri = node.resourceUri;
    item.description = dir === '.' ? statusLabel(node.status, node.staged) : `${statusLabel(node.status, node.staged)} · ${dir}`;
    item.tooltip = node.resourceUri.fsPath;
    item.contextValue = isDeleted(node.status) ? 'deploySyncDeleted' : 'deploySyncChange';
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
      return [];
    }
    if (!this.api) {
      return [{ kind: 'message', message: '未找到内置 Git 扩展' }];
    }
    if (this.api.repositories.length === 0) {
      return [{ kind: 'message', message: '当前项目不是 Git 仓库' }];
    }
    const changes = this.collect();
    if (changes.length === 0) {
      return [{ kind: 'message', message: '没有未提交的更改' }];
    }
    return changes;
  }

  /** 收集所有仓库的未提交更改，同一文件同时存在于暂存区和工作区时只保留一条 */
  collect(): ChangeNode[] {
    if (!this.api) {
      return [];
    }
    const map = new Map<string, ChangeNode>();
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
            existing.staged = existing.staged && group.staged;
            continue;
          }
          map.set(key, {
            kind: 'change',
            resourceUri: change.uri,
            relativePath: path.relative(root, change.uri.fsPath),
            status: change.status,
            staged: group.staged
          });
        }
      }
    }
    return [...map.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  /** 可上传的更改文件（排除已删除） */
  changedFiles(): vscode.Uri[] {
    return this.collect()
      .filter((node) => !isDeleted(node.status))
      .map((node) => node.resourceUri);
  }
}
