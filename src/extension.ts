import * as path from 'path';
import * as fs from 'fs/promises';
import * as vscode from 'vscode';
import { ChangeNode, GitChangesProvider } from './gitChanges';

interface Mapping {
  localRoot: string;
  remoteRoot: string;
}

interface Target {
  folder: vscode.WorkspaceFolder;
  relativePath: string;
  remotePath: string;
}

let output: vscode.OutputChannel;
let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('Deploy Sync');
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'deploySync.toggleUploadOnSave';
  context.subscriptions.push(output, statusBar);
  refreshStatusBar();

  const changesProvider = new GitChangesProvider();
  const changesView = vscode.window.createTreeView('deploySync.changes', {
    treeDataProvider: changesProvider
  });
  context.subscriptions.push(changesProvider, changesView);

  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (doc.uri.scheme !== 'file') {
        return;
      }
      if (!getConfig(doc.uri).get<boolean>('uploadOnSave', true)) {
        return;
      }
      await uploadFile(doc.uri, { silent: true });
    }),

    vscode.workspace.onDidDeleteFiles(async (event) => {
      for (const uri of event.files) {
        if (!getConfig(uri).get<boolean>('syncDeletions', false)) {
          continue;
        }
        await deleteRemote(uri);
      }
    }),

    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('deploySync')) {
        refreshStatusBar();
      }
    }),

    vscode.commands.registerCommand('deploySync.uploadCurrentFile', async (arg?: vscode.Uri | ChangeNode) => {
      const target = toUri(arg) ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage('Deploy Sync: 没有可上传的文件');
        return;
      }
      const stat = await vscode.workspace.fs.stat(target);
      if (stat.type === vscode.FileType.Directory) {
        await uploadGlob(target, '上传目录');
      } else {
        await uploadFile(target, { silent: false });
      }
    }),

    vscode.commands.registerCommand('deploySync.uploadWorkspace', async () => {
      const folder = await pickFolder();
      if (folder) {
        await uploadGlob(folder.uri, '上传整个项目');
      }
    }),

    vscode.commands.registerCommand('deploySync.uploadChangedFiles', async () => {
      const files = changesProvider.changedFiles();
      if (files.length === 0) {
        vscode.window.showInformationMessage('Deploy Sync: 没有未提交的更改');
        return;
      }
      await uploadMany(files, '上传未提交的更改');
    }),

    vscode.commands.registerCommand('deploySync.refreshChanges', () => changesProvider.refresh()),

    vscode.commands.registerCommand('deploySync.toggleUploadOnSave', async () => {
      const config = vscode.workspace.getConfiguration('deploySync');
      const next = !config.get<boolean>('uploadOnSave', true);
      await config.update('uploadOnSave', next, vscode.ConfigurationTarget.Workspace);
      refreshStatusBar();
      vscode.window.showInformationMessage(`Deploy Sync: 保存自动上传已${next ? '开启' : '关闭'}`);
    }),

    vscode.commands.registerCommand('deploySync.compareWithRemote', async (arg?: vscode.Uri | ChangeNode) => {
      const target = toUri(arg) ?? vscode.window.activeTextEditor?.document.uri;
      if (!target) {
        vscode.window.showWarningMessage('Deploy Sync: 没有可比较的文件');
        return;
      }
      await compareWithRemote(target);
    }),

    vscode.commands.registerCommand('deploySync.compareWorkspace', async (arg?: vscode.Uri | ChangeNode) => {
      let root = toUri(arg);
      if (!root) {
        root = (await pickFolder())?.uri;
      }
      if (root) {
        await compareTree(root);
      }
    }),

    vscode.commands.registerCommand('deploySync.configureTarget', configureTarget),

    vscode.commands.registerCommand('deploySync.showLog', () => output.show(true))
  );
}

export function deactivate(): void {
  // 无需清理，资源已挂到 context.subscriptions
}

function getConfig(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('deploySync', resource);
}

/** 命令可能来自命令面板、资源管理器右键（Uri）或侧边栏树节点（ChangeNode） */
function toUri(arg?: vscode.Uri | ChangeNode): vscode.Uri | undefined {
  if (!arg) {
    return undefined;
  }
  return arg instanceof vscode.Uri ? arg : arg.resourceUri;
}

function refreshStatusBar(): void {
  const on = getConfig().get<boolean>('uploadOnSave', true);
  statusBar.text = on ? '$(cloud-upload) Deploy: 自动' : '$(circle-slash) Deploy: 手动';
  statusBar.tooltip = '点击切换「保存后自动上传」';
  statusBar.show();
}

async function pickFolder(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    vscode.window.showWarningMessage('Deploy Sync: 当前没有打开的项目');
    return undefined;
  }
  if (folders.length === 1) {
    return folders[0];
  }
  const picked = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, folder: f })),
    { placeHolder: '选择要同步的项目' }
  );
  return picked?.folder;
}

function resolveTarget(uri: vscode.Uri): Target | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
  if (relativePath.startsWith('..')) {
    return undefined;
  }
  const mappings = getConfig(uri).get<Mapping[]>('mappings', []);
  const candidates = mappings
    .filter((m) => m.remoteRoot)
    .map((m) => ({ ...m, localRoot: normalizeLocalRoot(m.localRoot) }))
    .filter((m) => m.localRoot === '' || relativePath === m.localRoot || relativePath.startsWith(m.localRoot + path.sep))
    .sort((a, b) => b.localRoot.length - a.localRoot.length);

  const mapping = candidates[0];
  if (!mapping) {
    return undefined;
  }
  const suffix = mapping.localRoot === '' ? relativePath : path.relative(mapping.localRoot, relativePath);
  return {
    folder,
    relativePath,
    remotePath: path.join(mapping.remoteRoot, suffix)
  };
}

function normalizeLocalRoot(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return path.normalize(value).replace(/^[./\\]+/, '').replace(/[/\\]+$/, '');
}

function isExcluded(uri: vscode.Uri, relativePath: string): boolean {
  const patterns = getConfig(uri).get<string[]>('exclude', []);
  const posixPath = relativePath.split(path.sep).join('/');
  return patterns.some((pattern) => globToRegExp(pattern).test(posixPath));
}

function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') {
          i++;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

async function uploadFile(uri: vscode.Uri, options: { silent: boolean }): Promise<boolean> {
  const target = resolveTarget(uri);
  if (!target) {
    if (!options.silent) {
      await promptMissingMapping();
    }
    return false;
  }
  if (isExcluded(uri, target.relativePath)) {
    log(`跳过（命中 exclude）：${target.relativePath}`);
    return false;
  }

  try {
    await fs.mkdir(path.dirname(target.remotePath), { recursive: true });
    await fs.copyFile(uri.fsPath, target.remotePath);
    log(`上传成功：${target.relativePath} -> ${target.remotePath}`);
    if (!options.silent || getConfig(uri).get<boolean>('notifyOnSuccess', false)) {
      vscode.window.setStatusBarMessage(`$(check) Deploy Sync: ${path.basename(target.remotePath)} 已上传`, 3000);
    }
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`上传失败：${target.relativePath} -> ${target.remotePath}（${message}）`);
    vscode.window.showErrorMessage(`Deploy Sync 上传失败：${target.relativePath}`, '查看日志').then((choice) => {
      if (choice) {
        output.show(true);
      }
    });
    return false;
  }
}

async function deleteRemote(uri: vscode.Uri): Promise<void> {
  const target = resolveTarget(uri);
  if (!target || isExcluded(uri, target.relativePath)) {
    return;
  }
  try {
    await fs.rm(target.remotePath, { recursive: true, force: true });
    log(`已删除目标文件：${target.remotePath}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log(`删除目标文件失败：${target.remotePath}（${message}）`);
  }
}

async function uploadGlob(root: vscode.Uri, title: string): Promise<void> {
  if (!resolveTarget(root) && !vscode.workspace.getWorkspaceFolder(root)) {
    await promptMissingMapping();
    return;
  }
  const excludes = getConfig(root).get<string[]>('exclude', []);
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '**/*'),
    excludes.length > 0 ? `{${excludes.join(',')}}` : undefined
  );
  if (files.length === 0) {
    vscode.window.showInformationMessage('Deploy Sync: 没有需要上传的文件');
    return;
  }

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deploy Sync: ${title}`, cancellable: true },
    async (progress, token) => {
      let done = 0;
      let failed = 0;
      for (const file of files) {
        if (token.isCancellationRequested) {
          break;
        }
        const ok = await uploadFile(file, { silent: true });
        if (ok) {
          done++;
        } else {
          failed++;
        }
        progress.report({
          increment: 100 / files.length,
          message: `${done + failed}/${files.length}`
        });
      }
      vscode.window.showInformationMessage(`Deploy Sync: 完成 ${done} 个，失败/跳过 ${failed} 个`);
    }
  );
}

type DiffState = 'local-only' | 'different' | 'remote-newer';

interface DiffEntry {
  uri: vscode.Uri;
  relativePath: string;
  remotePath: string;
  state: DiffState;
}

const STATE_LABEL: Record<DiffState, string> = {
  'local-only': '目标不存在',
  different: '内容不同',
  'remote-newer': '内容不同（目标更新）'
};

async function compareWithRemote(uri: vscode.Uri): Promise<void> {
  const target = resolveTarget(uri);
  if (!target) {
    await promptMissingMapping();
    return;
  }
  const remoteUri = vscode.Uri.file(target.remotePath);
  try {
    await fs.access(target.remotePath);
  } catch {
    const choice = await vscode.window.showWarningMessage(
      `Deploy Sync: 目标中不存在 ${target.relativePath}`,
      '上传'
    );
    if (choice) {
      await uploadFile(uri, { silent: false });
    }
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    remoteUri,
    uri,
    `${path.basename(target.relativePath)}（目标 ↔ 本地）`
  );
}

async function compareTree(root: vscode.Uri): Promise<void> {
  if (!vscode.workspace.getWorkspaceFolder(root)) {
    await promptMissingMapping();
    return;
  }
  const excludes = getConfig(root).get<string[]>('exclude', []);
  const files = await vscode.workspace.findFiles(
    new vscode.RelativePattern(root, '**/*'),
    excludes.length > 0 ? `{${excludes.join(',')}}` : undefined
  );

  const diffs = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Deploy Sync: 比较差异', cancellable: true },
    async (progress, token) => {
      const result: DiffEntry[] = [];
      let scanned = 0;
      for (const file of files) {
        if (token.isCancellationRequested) {
          break;
        }
        scanned++;
        if (scanned % 20 === 0) {
          progress.report({ message: `${scanned}/${files.length}` });
        }
        const entry = await compareOne(file);
        if (entry) {
          result.push(entry);
        }
      }
      return result;
    }
  );

  if (diffs.length === 0) {
    vscode.window.showInformationMessage('Deploy Sync: 本地与目标一致');
    return;
  }

  const items: (vscode.QuickPickItem & { entry?: DiffEntry; uploadAll?: boolean })[] = [
    {
      label: `$(cloud-upload) 上传全部差异文件（${diffs.length}）`,
      uploadAll: true
    },
    ...diffs.map((entry) => ({
      label: `${entry.state === 'local-only' ? '$(diff-added)' : '$(diff-modified)'} ${entry.relativePath}`,
      description: STATE_LABEL[entry.state],
      detail: entry.remotePath,
      entry
    }))
  ];

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: `共 ${diffs.length} 个差异，选择文件查看 diff`,
    matchOnDescription: true
  });
  if (!picked) {
    return;
  }
  if (picked.uploadAll) {
    await uploadMany(
      diffs.map((entry) => entry.uri),
      '上传差异文件'
    );
  } else if (picked.entry) {
    await compareWithRemote(picked.entry.uri);
  }
}

async function compareOne(uri: vscode.Uri): Promise<DiffEntry | undefined> {
  const target = resolveTarget(uri);
  if (!target || isExcluded(uri, target.relativePath)) {
    return undefined;
  }
  const base = { uri, relativePath: target.relativePath, remotePath: target.remotePath };
  let remoteStat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    remoteStat = await fs.stat(target.remotePath);
  } catch {
    return { ...base, state: 'local-only' };
  }
  const localStat = await fs.stat(uri.fsPath);
  if (localStat.size === remoteStat.size && (await sameContent(uri.fsPath, target.remotePath))) {
    return undefined;
  }
  return {
    ...base,
    state: remoteStat.mtimeMs > localStat.mtimeMs ? 'remote-newer' : 'different'
  };
}

async function sameContent(localPath: string, remotePath: string): Promise<boolean> {
  const [a, b] = await Promise.all([fs.readFile(localPath), fs.readFile(remotePath)]);
  return a.equals(b);
}

async function uploadMany(files: vscode.Uri[], title: string): Promise<void> {
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Deploy Sync: ${title}`, cancellable: true },
    async (progress, token) => {
      let done = 0;
      let failed = 0;
      for (const file of files) {
        if (token.isCancellationRequested) {
          break;
        }
        if (await uploadFile(file, { silent: true })) {
          done++;
        } else {
          failed++;
        }
        progress.report({ increment: 100 / files.length, message: `${done + failed}/${files.length}` });
      }
      vscode.window.showInformationMessage(`Deploy Sync: 完成 ${done} 个，失败/跳过 ${failed} 个`);
    }
  );
}

async function promptMissingMapping(): Promise<void> {
  const choice = await vscode.window.showWarningMessage(
    'Deploy Sync: 还没有配置目标目录',
    '选择目标目录'
  );
  if (choice) {
    await configureTarget();
  }
}

async function configureTarget(): Promise<void> {
  const folder = await pickFolder();
  if (!folder) {
    return;
  }

  const scope = await vscode.window.showQuickPick(
    [
      { label: '$(root-folder) 整个项目', description: folder.uri.fsPath, sub: false },
      { label: '$(folder) 选择本地子目录…', description: '只同步项目内某个目录', sub: true }
    ],
    { placeHolder: '第 1 步：选择要同步的本地目录' }
  );
  if (!scope) {
    return;
  }

  let localRoot = '';
  if (scope.sub) {
    const pickedLocal = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: '设为本地源目录',
      defaultUri: folder.uri
    });
    if (!pickedLocal || pickedLocal.length === 0) {
      return;
    }
    const relative = path.relative(folder.uri.fsPath, pickedLocal[0].fsPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      vscode.window.showErrorMessage('Deploy Sync: 本地目录必须在当前项目内');
      return;
    }
    localRoot = normalizeLocalRoot(relative);
  }

  const localLabel = localRoot === '' ? '整个项目' : localRoot;
  const pickedRemote = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: '设为部署目标',
    title: `第 2 步：选择「${localLabel}」的目标目录`,
    defaultUri: vscode.Uri.file('/Volumes')
  });
  if (!pickedRemote || pickedRemote.length === 0) {
    return;
  }
  const remoteRoot = pickedRemote[0].fsPath;

  const config = vscode.workspace.getConfiguration('deploySync', folder.uri);
  const existing = config
    .get<Mapping[]>('mappings', [])
    .filter((m) => normalizeLocalRoot(m.localRoot) !== localRoot);
  await config.update(
    'mappings',
    [{ localRoot, remoteRoot }, ...existing],
    vscode.ConfigurationTarget.WorkspaceFolder
  );

  log(`映射已设置：${localLabel} -> ${remoteRoot}`);
  vscode.window.showInformationMessage(`Deploy Sync: ${localLabel} → ${remoteRoot}`);
}

function log(message: string): void {
  output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
}
