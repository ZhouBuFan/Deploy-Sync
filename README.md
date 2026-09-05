# Deploy Sync

保存文件后自动把当前项目的文件同步到指定目录（例如挂载的网络盘 `/Volumes/your-server`），对应 IDEA 的 Deployment / Automatic Upload。

## 使用

1. 安装依赖并编译：`npm install && npm run compile`
2. 在本目录按 `F5` 启动「扩展开发主机」，或打包安装：
   ```bash
   npx @vscode/vsce package
   code --install-extension deploy-sync-0.0.1.vsix
   ```
3. 打开要部署的项目，执行命令 `Deploy Sync: 配置同步映射（本地 → 目标）`：第 1 步选本地目录（整个项目 / 项目内某个子目录），第 2 步选目标目录如 `/Volumes/your-server/...`。可重复执行，为多个本地子目录配置不同目标。
4. 之后保存任意文件即自动上传；状态栏 `Deploy: 自动 / 手动` 可点击切换。

## 侧边栏

活动栏里的 Deploy Sync 图标下有「未提交的更改」视图，读取 VS Code 内置 Git 扩展的状态，列出当前所有未提交文件（工作区 + 暂存区 + 合并冲突），Git 状态变化时自动刷新。

- 点击文件名打开文件
- 悬停行内按钮：`上传`、`与目标比较`
- 视图标题栏：`上传未提交的更改`、`比较差异`、`刷新`；`...` 菜单里有配置映射、切换自动上传、上传整个项目、查看日志
- 已删除的文件只展示、不提供上传按钮

## 命令

- `Deploy Sync: 上传当前文件`（编辑器/资源管理器右键也可，选中目录则整目录上传）
- `Deploy Sync: 上传整个项目`
- `Deploy Sync: 上传未提交的更改`：只上传 Git 里有改动的文件
- `Deploy Sync: 刷新更改列表`
- `Deploy Sync: 与目标文件比较`：用 VS Code 内置 diff 打开「目标 ↔ 本地」，目标不存在时可直接上传
- `Deploy Sync: 比较差异（本地 ↔ 目标）`：扫描整个项目/目录，列出「目标不存在 / 内容不同 / 内容不同（目标更新）」的文件，可选中单个查看 diff，或一键上传全部差异
- `Deploy Sync: 开启/关闭保存自动上传`
- `Deploy Sync: 配置同步映射（本地 → 目标）`
- `Deploy Sync: 查看日志`

## 配置

写在项目的 `.vscode/settings.json`：

```jsonc
{
  "deploySync.mappings": [
    { "localRoot": "", "remoteRoot": "/Volumes/your-server/www/project" },
    { "localRoot": "web/dist", "remoteRoot": "/Volumes/your-server/www/static" }
  ],
  "deploySync.uploadOnSave": true,
  "deploySync.syncDeletions": false,
  "deploySync.exclude": ["**/.git/**", "**/node_modules/**", "**/.DS_Store"],
  "deploySync.notifyOnSuccess": false
}
```

- `localRoot` 相对工作区根目录，留空表示整个项目；命中多条时取最长匹配。
- 目标目录不存在的层级会自动创建。
- `syncDeletions` 只对通过 VS Code 删除的文件生效（依赖 `onDidDeleteFiles` 事件）。
- 目标盘未挂载时上传会失败并弹出错误提示，日志里有完整路径与原因。

## 调试配置

`.vscode/launch.json`（当前被工作区规则拦截，需手动创建）：

```jsonc
{
  "version": "0.2.0",
  "configurations": [
    {
      "name": "运行扩展",
      "type": "extensionHost",
      "request": "launch",
      "args": ["--extensionDevelopmentPath=${workspaceFolder}"],
      "outFiles": ["${workspaceFolder}/out/**/*.js"]
    }
  ]
}
```
