# STC AI Options

一个 SillyTavern(酒馆)UI 扩展:利用 AI 根据剧情自动生成下一步行动选项,以编号卡片列表渲染在聊天末尾,点击即可填入输入框继续对话。

![license](https://img.shields.io/badge/license-AGPL--3.0-blue)

## 功能

- **AI 选项生成**:提取最近对话正文发送给 AI,生成下一步行动/回复选项,以编号卡片列表渲染在聊天末尾
  - 点击选项把内容填入输入框(不自动发送,可再编辑);「换一批」重新生成
  - AI 回复结束后自动生成(可关),或手动点击「生成选项」
  - 可配置:生成数量、生成指令模板(占位符 `{{count}}` / `{{content}}`)
  - 解析健壮性:优先解析 JSON 数组,失败后自动降级为按行解析
- **AI API**:默认跟随酒馆主 API;也可配置自定义 OpenAI 兼容接口(地址 / Key / 模型名),带「测试连接」按钮
  - 在 SillyTavernchat MOD 环境下,自定义请求自动经后端转发,不受浏览器跨域(CORS)限制
  - 请求经酒馆原生后端端点(`/api/backends/chat-completions/generate`)转发,不受浏览器跨域(CORS)限制,任何 SillyTavern 部署可用
- **插件主题**:选项框外观可切换(跟随酒馆 / 深色 / 浅色),只作用于本插件,不改动酒馆的 UI 主题
- **破限词注入**:可选将自定义文本以系统提示词角色注入到每次主生成的提示词顶部(基于 `setExtensionPrompt`,不写入聊天记录、不改预设),深度可调
- **响应式布局**:适配 PC 与手机端

## 安装

### 方式一:扩展管理器安装(推荐)

在 SillyTavern 顶栏打开「扩展」面板 → **Install extension** → 粘贴本仓库地址:

```
https://github.com/BolshevikEric/stc-ai-options
```

### 方式二:手动安装

克隆到酒馆的全局扩展目录:

```bash
cd <SillyTavern 目录>/public/scripts/extensions/third-party
git clone https://github.com/BolshevikEric/stc-ai-options
```

刷新浏览器页面即可。设置入口:顶栏**魔法棒菜单 →「聊天选项」**。

## 使用说明

1. 打开魔法棒菜单 →「聊天选项」,确认已启用
2. 与 AI 正常对话,AI 回复结束后会自动生成一组选项(也可点选项框里的「生成选项 / 换一批」手动触发)
3. 点击选项 → 内容填入输入框 → 可再编辑后发送

### 设置项

| 设置 | 说明 |
|---|---|
| 启用选项框 | 总开关 |
| AI 回复后自动生成 | 关闭后仅手动触发 |
| 生成数量  | 每次 AI 生成几个选项|
| 生成指令模板 | 发给 AI 的指令,`{{count}}` 为数量,`{{content}}` 为正文 |
| AI API | `跟随酒馆主 API`(默认)或自定义 OpenAI 兼容接口 |
| 插件主题 | 选项框外观:跟随酒馆 / 深色 / 浅色(不改动酒馆主题) |
| 破限词注入 | 以系统提示词注入到生成提示词顶部,深度可调(默认 999 ≈ 顶部) |

## 兼容性说明

- 基于 SillyTavern 1.18.0 开发,使用官方扩展 API(`getContext`、`setExtensionPrompt`、`eventSource` 等)
- 自定义 API 经酒馆后端转发,无浏览器跨域限制

## 开发

- 目录结构:`index.js`(入口)+ `settings.html`(设置面板模板)+ `style.css` + `manifest.json`
- 官方扩展开发文档:<https://docs.sillytavern.app/for-contributors/writing-extensions/>

## 许可证

[AGPL-3.0](./LICENSE)
