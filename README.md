# 小黑盒论坛 - VSCode 插件 🎮

[![GitHub](https://img.shields.io/badge/GitHub-WenfuRainbow/heybox-blue?logo=github)](https://github.com/WenfuRainbow/heybox)

在 VSCode 中浏览小黑盒（xiaoheihe.cn）论坛帖子和评论，支持隐身模式。

## 功能

### 🔐 登录/退出登录
侧边栏工具栏提供登录和退出登录按钮：
- **登录** — 弹出输入框，粘贴从浏览器复制的 Cookie 即可登录
- **退出登录** — 清除已保存的 Cookie

### 🎨 主题切换
支持手动切换 Webview 主题：
- **跟随 VSCode** — 自动匹配当前主题（默认）
- **暗色主题** — 强制使用暗色
- **亮色主题** — 强制使用亮色

### 📌 推荐 & 📁 板块 & ⭐ 收藏（Tab 切换）
侧边栏顶部有 Tab 切换按钮：
- **推荐** — 热门推荐信息流
- **板块** — 论坛话题板块（数码硬件、盒友杂谈、Steam 等），点击展开帖子列表，支持"加载更多"分页
- **收藏** — 我的收藏帖子列表，右键帖子可收藏/取消收藏（本地 + 服务端同步）

### 🔍 搜索帖子
点击侧边栏顶部的 🔍 图标，输入关键词搜索全站帖子，搜索结果支持分页和"返回话题列表"。

### 📄 帖子详情
点击帖子在 Webview 中查看完整内容和评论（含图片、楼层、子评论嵌套）。评论自动加载、去重、分页。当服务端折叠评论时会显示折叠提示。

支持三种显示位置，通过设置 `heybox.postDetailLocation` 切换：

| 选项 | 效果 |
|------|------|
| `sidebar`（默认） | 在侧边栏/面板区域显示（可拖到下方 Panel，VSCode 记住位置） |
| `editor` | 在编辑区打开全尺寸 Webview 面板 |
| `beside` | 在编辑区右侧分栏显示 |

### 🎭 隐身模式
开启后界面伪装为代码片段名称，适合办公环境使用。

设置项：`heybox.stealthMode: true`

- Webview 标题显示为 `README.md`
- 帖子作者和评论者头像隐藏
- 评论点赞数隐藏
- 无论帖子详情显示在哪个位置均生效

### 🌿 简约模式
隐藏点赞/评论等社交数据，帖子列表看起来更像代码文件列表。

设置项：`heybox.minimalMode: true`

### 🖼️ 图片大小控制
帖子详情顶部有图片大小拖动条（5%~100%），可统一缩放正文和评论中的图片。设置项持久化（localStorage）。

### 🔍 图片悬停预览
鼠标悬停在帖子正文或评论的图片上时，在鼠标右侧显示原图大小的预览框（不受缩放滑块限制），方便查看图片细节。

### ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+Shift+J` | 切换侧边栏显示/隐藏 |
| `Alt+H` | 切换侧边栏（备选） |
| `Ctrl+Shift+Enter` | 从剪贴板 URL 自动打开帖子 |

## 安装

### 从 VSIX 安装
1. 下载 `.vsix` 文件
2. 在 VSCode 中按 `Ctrl+Shift+P` → `Extensions: Install from VSIX...`
3. 选择下载的 `.vsix` 文件

## 首次使用

1. 安装后在侧边栏出现 HeyBox 图标，点击展开侧边栏
2. 点击侧边栏工具栏的登录按钮，粘贴 Cookie
3. 或者：打开浏览器访问 [xiaoheihe.cn](https://www.xiaoheihe.cn) 并登录，按 `F12` 打开开发者工具 → Network → 复制 Cookie

> ⚠️ Cookie 会过期，过期后重新登录即可。

## 配置项

| 设置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `heybox.cookie` | string | `""` | 小黑盒网站 Cookie（通过登录命令设置） |
| `heybox.heyboxId` | string | `""` | 用户 ID（自动从 Cookie 提取） |
| `heybox.deviceId` | string | `""` | 设备 ID（自动生成） |
| `heybox.stealthMode` | boolean | `false` | 隐身模式 |
| `heybox.minimalMode` | boolean | `false` | 简约模式 |
| `heybox.postDetailLocation` | enum | `"sidebar"` | 帖子详情显示位置（sidebar/editor/beside） |
| `heybox.theme` | enum | `"auto"` | Webview 主题（auto/dark/light） |

## 命令

| 命令 | 说明 |
|------|------|
| HeyBox: 登录 | 弹出输入框登录 |
| HeyBox: 退出登录 | 清除 Cookie |
| HeyBox: 切换主题 | 切换 Webview 主题 |
| HeyBox: 打开帖子 | 打开选中的帖子 |
| HeyBox: 搜索帖子 | 搜索论坛帖子 |
| HeyBox: 刷新列表 | 刷新话题/搜索结果/推荐 |
| HeyBox: 通过URL打开帖子 | 输入链接打开帖子 |
| HeyBox: 加载更多 | 加载更多帖子/搜索结果 |
| HeyBox: 加载更多推荐 | 加载更多推荐内容 |
| HeyBox: 返回话题列表 | 退出搜索模式 |
| HeyBox: 在浏览器中打开 | 在浏览器中打开帖子 |
| HeyBox: 收藏/取消收藏 | 收藏或取消收藏选中帖子 |
| HeyBox: 切换到推荐 | 切换到推荐 Tab |
| HeyBox: 切换到板块 | 切换到板块 Tab |
| HeyBox: 切换到收藏 | 切换到收藏 Tab |
| HeyBox: 切换侧边栏 | `Ctrl+Shift+J` |
| HeyBox: 从剪贴板URL打开帖子 | `Ctrl+Shift+Enter` |

## 开发

```bash
npm install      # 安装依赖
npm run compile  # 编译 TypeScript
F5               # 启动 Extension Development Host
```

## 隐私说明

- 插件仅通过 API 读取公开论坛数据
- Cookie 存储在 VSCode SecretStorage 中（加密），不写入明文配置
- 不会收集任何用户数据

## 免责声明

本插件为非官方开源项目，仅供学习交流使用。小黑盒及其数据的版权归其所有者所有。
