import * as path from 'path';
import * as vscode from 'vscode';
import { Mapping, getMappings, normalizeLocalRoot, updateSetting } from './config';

export interface MappingNode {
  kind: 'mapping';
  folder: vscode.WorkspaceFolder;
  mapping: Mapping;
}

interface HintNode {
  kind: 'hint';
  message: string;
}

export type MappingsNode = MappingNode | HintNode;

export class MappingsProvider
  implements vscode.TreeDataProvider<MappingsNode>, vscode.TreeDragAndDropController<MappingsNode>
{
  readonly dropMimeTypes = ['text/uri-list'];
  readonly dragMimeTypes: string[] = [];

  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly log: (message: string) => void) {
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('deploySync.mappings')) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh())
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
    this.emitter.dispose();
  }

  refresh(): void {
    this.emitter.fire();
  }

  getTreeItem(node: MappingsNode): vscode.TreeItem {
    if (node.kind === 'hint') {
      const item = new vscode.TreeItem(node.message);
      item.iconPath = new vscode.ThemeIcon('info');
      return item;
    }
    const localRoot = normalizeLocalRoot(node.mapping.localRoot);
    const item = new vscode.TreeItem(localRoot === '' ? '整个项目' : localRoot);
    item.iconPath = new vscode.ThemeIcon(localRoot === '' ? 'root-folder' : 'folder');
    item.description = `→ ${node.mapping.remoteRoot}`;
    item.tooltip = `${path.join(node.folder.uri.fsPath, localRoot)}\n→ ${node.mapping.remoteRoot}`;
    item.contextValue = 'deploySyncMapping';
    return item;
  }

  getChildren(node?: MappingsNode): MappingsNode[] {
    if (node) {
      return [];
    }
    const folders = vscode.workspace.workspaceFolders ?? [];
    const nodes: MappingsNode[] = [];
    for (const folder of folders) {
      for (const mapping of getMappings(folder.uri)) {
        nodes.push({ kind: 'mapping', folder, mapping });
      }
    }
    if (nodes.length === 0) {
      return [{ kind: 'hint', message: '把项目里的文件夹拖到这里即可新建映射' }];
    }
    return nodes;
  }

  /** 从资源管理器拖入文件夹 → 询问目标目录 → 写入映射 */
  async handleDrop(
    target: MappingsNode | undefined,
    dataTransfer: vscode.DataTransfer,
    token: vscode.CancellationToken
  ): Promise<void> {
    const item = dataTransfer.get('text/uri-list');
    if (!item) {
      return;
    }
    const raw = await item.asString();
    const uris = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line) => vscode.Uri.parse(line));

    for (const uri of uris) {
      if (token.isCancellationRequested) {
        return;
      }
      await this.addMappingForLocal(uri, target);
    }
  }

  private async addMappingForLocal(uri: vscode.Uri, target?: MappingsNode): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) {
      vscode.window.showErrorMessage('Deploy Sync: 只能拖入当前项目内的文件夹');
      return;
    }
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      return;
    }
    const dirUri = stat.type === vscode.FileType.Directory ? uri : vscode.Uri.file(path.dirname(uri.fsPath));
    const localRoot = normalizeLocalRoot(path.relative(folder.uri.fsPath, dirUri.fsPath));
    const localLabel = localRoot === '' ? '整个项目' : localRoot;

    const defaultRemote =
      target?.kind === 'mapping' ? vscode.Uri.file(target.mapping.remoteRoot) : vscode.Uri.file('/Volumes');
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '设为部署目标',
      title: `选择「${localLabel}」的目标目录`,
      defaultUri: defaultRemote
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const remoteRoot = picked[0].fsPath;
    const existing = getMappings(folder.uri).filter((m) => normalizeLocalRoot(m.localRoot) !== localRoot);
    await updateSetting(folder, 'mappings', [{ localRoot, remoteRoot }, ...existing]);
    this.log(`映射已设置：${localLabel} -> ${remoteRoot}`);
    this.refresh();
  }

  async removeMapping(node: MappingNode): Promise<void> {
    const localRoot = normalizeLocalRoot(node.mapping.localRoot);
    const remaining = getMappings(node.folder.uri).filter(
      (m) => normalizeLocalRoot(m.localRoot) !== localRoot || m.remoteRoot !== node.mapping.remoteRoot
    );
    await updateSetting(node.folder, 'mappings', remaining);
    this.log(`映射已删除：${localRoot === '' ? '整个项目' : localRoot} -> ${node.mapping.remoteRoot}`);
    this.refresh();
  }

  async changeTarget(node: MappingNode): Promise<void> {
    const localRoot = normalizeLocalRoot(node.mapping.localRoot);
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '设为部署目标',
      title: `选择「${localRoot === '' ? '整个项目' : localRoot}」的目标目录`,
      defaultUri: vscode.Uri.file(node.mapping.remoteRoot)
    });
    if (!picked || picked.length === 0) {
      return;
    }
    const mappings = getMappings(node.folder.uri).map((m) =>
      normalizeLocalRoot(m.localRoot) === localRoot && m.remoteRoot === node.mapping.remoteRoot
        ? { localRoot, remoteRoot: picked[0].fsPath }
        : m
    );
    await updateSetting(node.folder, 'mappings', mappings);
    this.log(`映射已更新：${localRoot === '' ? '整个项目' : localRoot} -> ${picked[0].fsPath}`);
    this.refresh();
  }
}
