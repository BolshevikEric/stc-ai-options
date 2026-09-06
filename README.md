# STC AI Options

一个 SillyTavern(酒馆)UI 扩展:利用 AI 根据剧情自动生成下一步行动选项,渲染在聊天末尾,点击填入输入框继续对话。基于 SillyTavern 1.18.0 开发。

![license](https://img.shields.io/badge/license-AGPL--3.0-blue)

## 功能

- **AI 选项生成**:提取最新一条 AI 发言发送给 AI,生成选项卡片;点击填入输入框,「换一批」重新生成;AI 回复结束后自动生成(可关)
  - 可配置:生成数量、提取正则(可选,留空发送原文)、生成指令模板(占位符 `{{count}}` / `{{content}}`)
- **世界书**:勾选哪些条目,生成选项时这些设定注入到正文末尾;书级复选框三态:全选 ✓ / 部分选中 —
- **AI API**:默认跟随酒馆主 API;也可配置自定义 OpenAI 兼容接口,带「测试连接」
- **破限词注入**:以系统提示词注入到提示词最顶部,深度可调;生成选项时同样置于最开头
- **插件主题**:选项框外观可切换(跟随酒馆 / 深色 / 浅色)
- **响应式布局**:适配 PC 与手机端

## 安装

在酒馆顶栏打开「扩展」面板 → **Install extension** → 粘贴仓库地址:

```
https://github.com/BolshevikEric/stc-ai-options
```

或手动克隆到 `public/scripts/extensions/third-party` 后刷新页面。

## 使用说明

1. 魔法棒菜单 →「聊天选项」,确认已启用
2. 与 AI 对话,回复结束后自动生成选项(也可点「生成选项 / 换一批」手动触发)
3. 点击选项填入输入框,可编辑后发送
4. (可选)在设置里勾选需要的世界书条目

### 设置项

| 设置 | 说明 |
|---|---|
| 启用选项框 | 总开关 |
| AI 回复后自动生成 | 关闭后仅手动触发 |
| 生成数量 | 每次 AI 生成几个选项 |
| 提取正则 | 可选,留空发送原文;支持 `/pattern/flags`,有捕获组取第 1 组 |
| 生成指令模板 | `{{count}}` 为数量,`{{content}}` 为最新剧情,`{{char}}`/`{{user}}`、`<char>`/`<user>` 为角色/用户名 |
| 世界书 | 勾选要附带给 AI 的条目;条目内角色/用户占位符同样替换;书级复选框:全选 ✓ / 部分选中 — |
| AI API | `跟随酒馆主 API`(默认)或自定义 OpenAI 兼容接口 |
| 插件主题 | 跟随酒馆 / 深色 / 浅色 |
| 破限词注入 | 注入到提示词顶部,深度可调(默认 999) |

## 开发

- 目录:`index.js` + `settings.html` + `style.css` + `manifest.json`
- 发版需递增 `manifest.json` 里 `js` / `css` 的 `?v=` 参数,防止客户端缓存旧代码
- 官方扩展开发文档:<https://docs.sillytavern.app/for-contributors/writing-extensions/>

## 许可证

[AGPL-3.0](./LICENSE)
