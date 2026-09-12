# HeyBox Forum for VS Code

[![GitHub](https://img.shields.io/badge/GitHub-WenfuRainbow%2Fheybox-181717?logo=github)](https://github.com/WenfuRainbow/heybox)

> 把小黑盒论坛装进编辑器。摸鱼时看两眼，认真时也能低调一点。 🎮

HeyBox Forum 是一个非官方 VS Code 插件，让你不用离开编辑器，就能浏览小黑盒论坛的推荐、板块、收藏、消息和完整帖子。它支持扫码登录、主题跟随、图片预览，以及一键“隐身”。

## 亮点

- **论坛就在侧边栏**：推荐、板块、收藏和消息一处切换；搜索、分页与帖子详情也都不用跳出 VS Code。
- **登录省心**：用小黑盒 App 扫码即可登录；凭证保存于 VS Code 的安全存储。扫码不可用时，也可以手动粘贴 Cookie。
- **看帖舒服**：正文、楼层、嵌套回复和原图都能正常阅读；图片可缩放，点击后在查看器中浏览。
- **收消息但不打扰**：登录后自动检查回复、获赞、关注、@我、官方消息与游戏优惠；只对新消息提醒。
- **办公友好**：隐身模式会把界面伪装成 `README.md`，并隐藏头像与点赞数；简约模式则把列表收成更像文件树的样子。

## 安装

需要 VS Code 1.85 或更高版本。请从 [GitHub Releases](https://github.com/WenfuRainbow/heybox/releases) 下载与版本号对应的 `.vsix` 文件，然后在 VS Code 中：

1. 按 `Ctrl+Shift+P`
2. 运行 `Extensions: Install from VSIX...`
3. 选择下载好的 `.vsix` 文件

## 三步开始

1. 安装后，点击活动栏里的 **HeyBox** 图标。
2. 在侧边栏工具栏打开菜单，选择“登录”，再用小黑盒 App 扫码并在手机上确认。
3. 开始逛推荐、进板块、搜帖子，或打开你的收藏和消息。

登录状态过期后重新扫码即可。二维码失效时，在登录面板点击“刷新二维码”。如果遇到小黑盒服务端风控，请等待限制解除后再试；也可以先在浏览器完成人机验证，再手动导入 Cookie。插件不提供网页登录入口。

## 你会用到的功能

### 浏览、搜索与收藏

- **推荐 / 板块 / 收藏 / 消息**：通过列表顶部的“切换”入口选择。板块、收藏、搜索结果与各类消息均支持“加载更多”。
- **搜索**：点击工具栏的 🔍，输入关键词搜索全站帖子。
- **收藏同步**：优先读取小黑盒服务端默认收藏夹；右键帖子即可收藏或取消收藏，操作后列表会自动更新。
- **消息中心**：按需查看评论与回复、获赞、关注、@我、官方消息和游戏优惠；带帖子链接的互动消息可直接跳转到对应帖子。
- **阅读记录**：菜单中的“阅读历史”可重新打开已读帖子；“继续阅读上次帖子”会恢复到保存的位置。

### 看帖与评论

点击列表项即可打开帖子详情。正文图片按原文位置呈现，评论支持楼层、嵌套回复与按需展开；打开“全部 N 条回复”不会让你反复看到已经加载的内容。富文本仅保留安全的内容标签和图片/网页链接，脚本与事件属性不会执行。

帖子详情可在设置 `heybox.postDetailLocation` 中选择显示位置：

| 选项 | 适合什么场景 |
| --- | --- |
| `sidebar`（默认） | 在侧边栏或下方面板快速扫一眼 |
| `editor` | 在编辑区全尺寸阅读 |
| `beside` | 一边写代码，一边把帖子放在右侧 |

详情页的“阅读设置”可将正文和评论图片统一缩放（5%–100%），设置会自动记住。点击图片会打开查看器；可用 `←` / `→` 切换上一张、下一张，用 `Esc` 关闭并回到原来的图片。需要原图时，点击查看器中的“加载原图”会在独立预览中打开；加载失败会显示原因。

详情工具栏提供收藏、复制链接、在浏览器打开和跳转评论。默认详情仍在侧边栏；将 `heybox.postDetailLocation` 设为 `editor` 或 `beside`，可启用更宽的编辑区阅读布局。

### 主题与低调模式

- **主题**：默认跟随 VS Code，也可手动切换亮色或暗色。
- **隐身模式**：设置 `heybox.stealthMode: true`。Webview 会显示为 `README.md`，头像与评论点赞数会隐藏。
- **简约模式**：设置 `heybox.minimalMode: true`，隐藏收藏、评论等社交信息，让帖子列表更干净。

### 消息提醒

登录后，插件每 3 分钟检查一次新互动和优惠消息。状态栏会显示新消息数量；点击可打开消息中心。提醒的开关和分类订阅可在侧边栏菜单中配置。接口明确返回未读状态时才会推送；没有已读字段的消息类别，仅提醒插件启动后新出现的内容，不会把历史消息当作新消息打扰你。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+Shift+J` | 显示 / 隐藏 HeyBox 侧边栏 |
| `Alt+H` | 切换侧边栏（备选） |
| `Ctrl+Shift+Enter` | 从剪贴板链接打开帖子 |

macOS 下，`Ctrl+Shift+J` 和 `Ctrl+Shift+Enter` 分别对应 `Cmd+Shift+J`、`Cmd+Shift+Enter`。

## 设置

| 设置项 | 默认值 | 说明 |
| --- | --- | --- |
| `heybox.stealthMode` | `false` | 开启隐身模式 |
| `heybox.minimalMode` | `false` | 隐藏社交数据，使用简约列表 |
| `heybox.postDetailLocation` | `sidebar` | 帖子详情位置：`sidebar` / `editor` / `beside` |
| `heybox.theme` | `auto` | Webview 主题：`auto` / `dark` / `light` |
| `heybox.cookie` | 空 | 旧版手动 Cookie 兼容项；首次读取时会迁移至 VS Code SecretStorage 并清空该设置，正常扫码无需设置 |
| `heybox.deviceId` | 空 | 设备 ID；留空时插件自动生成并保存 |
| `heybox.heyboxId` | 空 | 小黑盒用户 ID；通常从 Cookie 自动提取 |
| `heybox.proxy` | 空 | HTTP/HTTPS 代理地址，例如 `http://127.0.0.1:7890`；留空即直连 |
| `heybox.browserMode` | `auto` | 请求通道：`auto` / `node` / `browser`；小黑盒风控 Node TLS 指纹时使用 `browser` |
| `heybox.browserPath` | 空 | Edge/Chrome 可执行文件路径；留空则自动查找本机浏览器 |
| `heybox.webVersion` | `2.5` | 网页 API 兼容版本；留空时由服务端协商能力 |

除网络排障外，通常不需要手动修改 `deviceId`、`heyboxId`、`webVersion` 或浏览器路径。

## 常用命令

在命令面板中输入 `HeyBox:` 即可找到全部命令。最常用的是：

- 登录 / 退出登录
- 搜索帖子、通过 URL 打开帖子、在浏览器中打开
- 刷新列表、加载更多、收藏 / 取消收藏
- 切换推荐、板块、收藏、消息中心
- 开关消息提醒、配置提醒分类

“标记所有消息为已读”不会向小黑盒写入状态；请在小黑盒客户端中标记已读，插件会在后续轮询中同步服务端状态。

## 开发

```bash
npm install
npm test
# 按 F5 启动 Extension Development Host
```

`npm test` 会连续执行 TypeScript 编译、ESLint 和不依赖线上账号的离线契约测试。

## 自动构建与发布

仓库中的 GitHub Actions 会在提交或拉取请求进入 `master` 时自动执行测试并打包 VSIX。正式发布由 `v*.*.*` 标签触发，只有标签版本与 `package.json` 中的 `version` 完全一致时，构建产物才会发布到 Visual Studio Marketplace。

首次启用前需要完成一次配置：

1. 确认当前 Microsoft 账号可以管理 Marketplace 发布者 `kyo`。
2. 在 Azure DevOps 创建 Personal Access Token：Organization 选择 **All accessible organizations**，Scope 只授予 **Marketplace > Manage**。
3. 在 GitHub 仓库的 **Settings > Environments** 创建 `vscode-marketplace` 环境。
4. 在该环境的 **Environment secrets** 中新增名为 `VSCE_PAT` 的 Secret，值为上一步创建的 Token。不要把 Token 写入代码或工作流文件。

发布新版本时执行：

```bash
# patch 也可以替换为 minor 或 major
npm version patch
git push origin master --follow-tags
```

`npm version` 会同时更新 `package.json`、`package-lock.json` 并创建对应的 `vX.Y.Z` 标签。普通 push 只构建，不会覆盖或重复发布 Marketplace 版本。标签发布成功后，同一个 VSIX 会作为 GitHub Release Asset 上传，也可从对应 GitHub Actions 运行记录的 Artifacts 中下载。

## 隐私与免责声明

- 插件仅通过小黑盒 API 读取论坛数据，不收集用户数据。
- 扫码二维码在本地生成；登录凭证仅存放于 VS Code SecretStorage，不写入明文配置或 Webview。
- 浏览器通道会使用本地无头 Edge/Chrome 发起 API 请求，Cookie 仍只在本机处理。
- 本项目为非官方开源项目，仅供学习交流。小黑盒及相关数据的权利归其权利人所有。
