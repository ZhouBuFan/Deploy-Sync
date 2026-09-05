import * as path from 'path';
import * as vscode from 'vscode';

export interface Mapping {
  localRoot: string;
  remoteRoot: string;
}

export interface Target {
  folder: vscode.WorkspaceFolder;
  relativePath: string;
  remotePath: string;
}

export function getConfig(resource?: vscode.Uri): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('deploySync', resource);
}

export function normalizeLocalRoot(value: string | undefined): string {
  if (!value) {
    return '';
  }
  return path.normalize(value).replace(/^[./\\]+/, '').replace(/[/\\]+$/, '');
}

export function getMappings(resource?: vscode.Uri): Mapping[] {
  return getConfig(resource).get<Mapping[]>('mappings', []);
}

/** 写配置：优先写文件夹设置，不被允许时退回工作区设置 */
export async function updateSetting(
  folder: vscode.WorkspaceFolder,
  key: string,
  value: unknown
): Promise<void> {
  const config = getConfig(folder.uri);
  try {
    await config.update(key, value, vscode.ConfigurationTarget.WorkspaceFolder);
  } catch {
    await config.update(key, value, vscode.ConfigurationTarget.Workspace);
  }
}

export function resolveTarget(uri: vscode.Uri): Target | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) {
    return undefined;
  }
  const relativePath = path.relative(folder.uri.fsPath, uri.fsPath);
  if (relativePath.startsWith('..')) {
    return undefined;
  }
  const candidates = getMappings(uri)
    .filter((m) => m.remoteRoot)
    .map((m) => ({ ...m, localRoot: normalizeLocalRoot(m.localRoot) }))
    .filter(
      (m) =>
        m.localRoot === '' || relativePath === m.localRoot || relativePath.startsWith(m.localRoot + path.sep)
    )
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

export function isExcluded(uri: vscode.Uri, relativePath: string): boolean {
  const patterns = getConfig(uri).get<string[]>('exclude', []);
  const posixPath = relativePath.split(path.sep).join('/');
  return patterns.some((pattern) => globToRegExp(pattern).test(posixPath));
}

/** 目录是否被 exclude 覆盖（目录本身没有路径末尾的文件名，用 `dir/x` 试探） */
export function isDirExcluded(uri: vscode.Uri, relativePath: string): boolean {
  const posixPath = relativePath.split(path.sep).join('/');
  const patterns = getConfig(uri).get<string[]>('exclude', []);
  return patterns.some((pattern) => globToRegExp(pattern).test(`${posixPath}/x`));
}

export function excludePatternFor(relativePath: string): string {
  return `${relativePath.split(path.sep).join('/')}/**`;
}

export function globToRegExp(pattern: string): RegExp {
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
