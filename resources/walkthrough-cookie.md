## 获取 Cookie

1. 打开浏览器，访问 [小黑盒官网](https://www.xiaoheihe.cn)
2. 登录你的账号
3. 按 `F12` 打开开发者工具
4. 切换到 **Network（网络）** 标签
5. 刷新页面（`F5`）
6. 点击任意请求（如 `categories` 或 `home`）
7. 在右侧找到 **Request Headers（请求头）**→ **Cookie**
8. **右键 → Copy value** 复制完整的 Cookie 值
9. 回到 VSCode，粘贴到 `heybox.cookie` 设置中

> ⚠️ Cookie 包含你的登录凭据，**不要分享给他人**。
> ⚠️ Cookie 会过期，如果插件提示登录过期，按上述步骤重新获取即可。