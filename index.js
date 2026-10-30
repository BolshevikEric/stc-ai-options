// STC Chat Options - AI 生成的聊天选项框 + 魔法棒菜单设置
// 流程:提取最新一条 AI 发言 → 发送给 AI(主 API 或自定义 OpenAI 兼容接口)→ 解析选项 → 渲染编号卡片列表
// 点击选项填充输入框(不自动发送);破限词以系统提示词注入到生成提示词顶部。

import { getContext, extension_settings } from '../../../extensions.js';
import { renderTemplateAsync } from '../../../templates.js';
import { eventSource, event_types } from '../../../events.js';
import {
    saveSettingsDebounced,
    setExtensionPrompt,
    substituteParams,
    extension_prompt_types,
    extension_prompt_roles,
    MAX_INJECTION_DEPTH,
} from '../../../../script.js';
// 命名空间引入:不同版本 script.js 的导出名有差异,避免命名导入缺失导致整个模块加载失败
import * as stScript from '../../../../script.js';
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';

const MODULE_NAME = 'stc_chat_options';
const LOG_PREFIX = '[STC Chat Options]';
const JB_PROMPT_KEY = `${MODULE_NAME}_jailbreak`;
// 模板版本号:更新 settings.html 后递增,绕开浏览器缓存
const TEMPLATE_VERSION = '19';
const TEMPLATE_URL = `/scripts/extensions/third-party/stc-ai-options/settings.html?v=${TEMPLATE_VERSION}`;

const DEFAULT_GEN_PROMPT = `你是一个互动式小说的选项生成器。阅读下面这段最新的剧情,为用户(玩家)生成 {{count}} 个下一步可能的行动或回复选项。

要求:
- 以用户的第一人称视角撰写,简短自然,每条不超过 25 个字
- 选项之间要有明显不同的方向和意图,贴合当前剧情与人物关系
- 只输出一个 JSON 数组,格式严格为: ["选项一","选项二"],不要输出解释、序号或其他任何内容

最新剧情:
{{content}}`;

const defaultSettings = {
    // 选项框总开关
    enabled: true,
    // AI 回复后自动生成选项
    auto: true,
    // 点击选项填充方式:false=覆盖输入框;true=追加到已有内容末尾
    inputAppend: false,
    // 记住生成的选项:跟随 AI 消息分支存储,刷新/切换聊天后自动恢复
    remember: true,
    // 每个聊天最多保留多少条带选项的消息(1–50)
    rememberLimit: 10,
    // 插件外观主题:仅作用于选项框,不改动酒馆本身的 UI 主题
    ui: {
        theme: 'auto', // 'auto' = 跟随酒馆主题;'dark' = 深色;'light' = 浅色
    },
    // 选项生成参数
    gen: {
        count: 4,          // 每次生成的选项数量
        regex: '',         // 提取正则:从最新 AI 发言中抽取匹配内容发送,留空发送原文
        excludeRegex: '',  // 排除正则:先删除匹配内容再发送,留空不删除
        prompt: DEFAULT_GEN_PROMPT,
    },
    // 世界书:勾选的条目内容会附带进生成选项的提示词
    wi: {
        selections: {},   // { [世界书文件名]: [条目 uid, ...] }
    },
    // 扩展自身 AI 调用使用的接口
    api: {
        mode: 'main', // 'main' = 跟随酒馆主 API;'custom' = 自定义 OpenAI 兼容接口
        url: '',
        key: '',
        model: '',
    },
    // 破限词:作为系统提示词注入到生成提示词顶部,不改动聊天记录
    jailbreak: {
        enabled: false,
        text: '',
        depth: 999, // 注入深度,越大越靠近提示词顶部
    },
};

let settings = null;
let $optionsBar = null;
let lastOptions = [];   // 当前渲染的 AI 生成选项
let lastError = null;   // 最近一次生成失败的错误信息
let generating = false; // 是否正在生成
let lastGenSig = '';    // 上次生成选项时"最后一条消息"的签名,防止重复/自触发
let lastDirection = ''; // 用户设置的生成方向(会话内有效,空=不限定)
let dirEditing = false; // 方向输入行是否展开
let barCollapsed = false;    // 选项面板是否折叠(会话内有效)
let selectedOptionText = ''; // 当前高亮的选项文本(覆盖填入时唯一)

// ── 设置初始化 ────────────────────────────────────────────────

function initSettings() {
    const defaults = structuredClone(defaultSettings);
    const store = extension_settings;
    if (!store[MODULE_NAME] || typeof store[MODULE_NAME] !== 'object') {
        store[MODULE_NAME] = defaults;
        settings = store[MODULE_NAME];
        return;
    }
    // 逐字段补齐,兼容旧版本升级后新增的配置项
    const stored = store[MODULE_NAME];
    for (const key of Object.keys(defaults)) {
        if (stored[key] === undefined) stored[key] = structuredClone(defaults[key]);
    }
    if (typeof stored.ui !== 'object' || stored.ui === null) stored.ui = defaults.ui;
    for (const key of Object.keys(defaults.ui)) {
        if (stored.ui[key] === undefined) stored.ui[key] = defaults.ui[key];
    }
    if (typeof stored.gen !== 'object' || stored.gen === null) stored.gen = defaults.gen;
    for (const key of Object.keys(defaults.gen)) {
        if (stored.gen[key] === undefined) stored.gen[key] = defaults.gen[key];
    }
    if (typeof stored.wi !== 'object' || stored.wi === null) stored.wi = defaults.wi;
    if (typeof stored.wi.selections !== 'object' || stored.wi.selections === null) stored.wi.selections = {};
    if (typeof stored.api !== 'object' || stored.api === null) stored.api = defaults.api;
    for (const key of Object.keys(defaults.api)) {
        if (stored.api[key] === undefined) stored.api[key] = defaults.api[key];
    }
    if (typeof stored.jailbreak !== 'object' || stored.jailbreak === null) stored.jailbreak = defaults.jailbreak;
    for (const key of Object.keys(defaults.jailbreak)) {
        if (stored.jailbreak[key] === undefined) stored.jailbreak[key] = defaults.jailbreak[key];
    }
    settings = stored;
}

function persist() {
    saveSettingsDebounced();
}

// ── 破限词注入 ────────────────────────────────────────────────

function clampDepth(depth) {
    const n = Math.round(Number(depth) || 0);
    if (n < 1) return 1;
    if (n > MAX_INJECTION_DEPTH) return MAX_INJECTION_DEPTH;
    return n;
}

function applyJailbreakInjection() {
    const jb = settings.jailbreak;
    const depth = clampDepth(jb.depth);
    if (jb.enabled && String(jb.text ?? '').trim()) {
        setExtensionPrompt(JB_PROMPT_KEY, String(jb.text), extension_prompt_types.IN_PROMPT, depth, false, extension_prompt_roles.SYSTEM);
    } else {
        setExtensionPrompt(JB_PROMPT_KEY, '', extension_prompt_types.IN_PROMPT, depth, false, extension_prompt_roles.SYSTEM);
    }
}

// ── 扩展自身的 AI 调用 ────────────────────────────────────────

async function generateWithConfig(prompt, { systemPrompt = '', maxTokens } = {}) {
    if (settings.api.mode === 'custom') {
        return await generateViaCustomApi(prompt, systemPrompt, maxTokens);
    }
    const context = getContext();
    const reply = await context.generateRaw({ prompt, systemPrompt });
    return String(reply ?? '').trim();
}

// ── CSRF 辅助(调用本站后端接口) ─────────────────────────────
let _csrfToken = null;
async function getCsrfHeaders() {
    if (!_csrfToken) {
        try {
            const r = await fetch('/csrf-token');
            if (r.ok) _csrfToken = (await r.json()).token;
        } catch { /* 忽略,后续请求会重试 */ }
    }
    const h = { 'Content-Type': 'application/json' };
    if (_csrfToken) h['x-csrf-token'] = _csrfToken;
    return h;
}

async function generateViaCustomApi(prompt, systemPrompt, maxTokens) {
    const { url, key, model } = settings.api;
    if (!url || !model) {
        throw new Error('请先在设置中填写自定义 API 地址与模型名');
    }
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: prompt });

    // 走酒馆原生后端端点(与连接设置里「自定义(兼容 OpenAI)」来源同款架构):
    // 浏览器 → 酒馆后端 → 自定义接口,服务器对服务器转发,不受浏览器跨域限制,
    // 原版酒馆即自带此端点,任何部署都可用,无需额外后端支持。
    const resp = await fetch('/api/backends/chat-completions/generate', {
        method: 'POST',
        headers: await getCsrfHeaders(),
        body: JSON.stringify({
            chat_completion_source: 'custom',
            custom_url: url,
            model,
            messages,
            temperature: 0.8,
            stream: false,
            ...(maxTokens ? { max_tokens: maxTokens } : {}),
            custom_include_headers: key ? { Authorization: `Bearer ${key}` } : {},
        }),
    });

    if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
            const body = await resp.json();
            if (body?.error) {
                const e = body.error;
                detail = typeof e === 'string' ? e : (e?.message || JSON.stringify(e));
            }
        } catch { /* 非 JSON 响应,保留状态码 */ }
        throw new Error(String(detail).slice(0, 200));
    }
    const data = await resp.json();
    const msg = data?.choices?.[0]?.message ?? {};
    const content = String(msg.content ?? '').trim();
    if (!content) {
        // 推理模型的思考 token 计入 max_tokens,预算被思考占满时正文会是空串
        const reasoning = String(msg.reasoning_content ?? msg.reasoning ?? '').trim();
        if (reasoning) {
            throw new Error(`模型只输出了思考内容、正文为空:思考过程占满了 ${maxTokens ?? '默认'} token 上限,请调高 token 限制或关闭思考模式`);
        }
        throw new Error('响应中没有返回内容');
    }
    return content;
}

// ── AI 选项生成 ───────────────────────────────────────────────

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

/**
 * 找到最新一条真实 AI 发言。
 * 跳过用户消息、系统消息与系统注入的 HTML 提示(如欢迎语、/help 输出)。
 * 返回 { index, msg },没有则返回 null。
 */
function findLastAiMessage() {
    const chat = getContext().chat;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        if (typeof m.mes !== 'string' || !m.mes.trim()) continue;
        if (m.name === 'SillyTavern System' || /^\s*<(div|button|span)\b/i.test(m.mes)) continue;
        return { index: i, msg: m };
    }
    return null;
}

function extractContent() {
    return String(findLastAiMessage()?.msg?.mes ?? '').trim();
}

/**
 * 按用户设置的正则从原文中抽取匹配内容。
 * 支持 /pattern/flags 写法;无匹配或正则无效时回退发送原文。
 * 有捕获组时取第 1 组,否则取整个匹配;全局模式下多个匹配按行拼接。
 */
function applyContentRegex(text, pattern) {
    const src = String(pattern ?? '').trim();
    if (!src) return text;
    let re;
    try {
        const m = src.match(/^\/(.*)\/([a-z]*)$/s);
        re = m ? new RegExp(m[1], m[2]) : new RegExp(src);
    } catch (e) {
        console.warn(LOG_PREFIX, '提取正则无效,发送原文:', e?.message);
        return text;
    }
    try {
        if (re.global) {
            const matches = [...text.matchAll(re)];
            if (!matches.length) return text;
            const out = matches.map(m => (m.length > 1 ? m[1] ?? '' : m[0])).filter(Boolean).join('\n');
            return out || text;
        }
        const m = text.match(re);
        if (!m) return text;
        const out = m.length > 1 ? (m[1] ?? m[0]) : m[0];
        return out || text;
    } catch (e) {
        console.warn(LOG_PREFIX, '正则提取失败,发送原文:', e?.message);
        return text;
    }
}

/**
 * 排除正则:把匹配到的内容从原文中删除,不发送给 AI(提取正则的反向操作)。
 * 支持 /pattern/flags 写法;强制全局替换,一次移除所有匹配;
 * 删除后压缩多余空行,避免留下大段空白;正则无效或无匹配时自动回退原文。
 */
function applyExcludeRegex(text, pattern) {
    const src = String(pattern ?? '').trim();
    if (!src) return text;
    let re;
    try {
        const m = src.match(/^\/(.*)\/([a-z]*)$/s);
        const flags = m ? (m[2].includes('g') ? m[2] : `${m[2]}g`) : 'g';
        re = m ? new RegExp(m[1], flags) : new RegExp(src, 'g');
        if (!re.test(text)) return text;
    } catch (e) {
        console.warn(LOG_PREFIX, '排除正则无效,发送原文:', e?.message);
        return text;
    }
    try {
        re.lastIndex = 0;
        return text.replace(re, '').replace(/\n{3,}/g, '\n\n').trim();
    } catch (e) {
        console.warn(LOG_PREFIX, '正则排除失败,发送原文:', e?.message);
        return text;
    }
}

/**
 * 酒馆原生占位符全量替换:整段交给酒馆原生宏引擎(substituteParams)处理,
 * {{char}}/{{user}}、<char>/<user>、{{time}}、{{date}}、{{roll}} 等全部按原生规范取值;
 * 角色/用户解析为空时回退「角色」/「用户」。
 * 只用于生成指令模板与世界书条目内容,{{content}}(最新剧情原文)不做替换,
 * 避免剧情里引用的字面占位符被误改。
 */
function applyNativeMacros(text) {
    let str = String(text ?? '');
    if (!str) return str;
    const char = String(substituteParams('{{char}}') ?? '').trim();
    const user = String(substituteParams('{{user}}') ?? '').trim();
    if (!char) str = str.replace(/\{\{\s*char\s*\}\}/gi, '角色').replace(/<char>/gi, '角色');
    if (!user) str = str.replace(/\{\{\s*user\s*\}\}/gi, '用户').replace(/<user>/gi, '用户');
    return substituteParams(str);
}

/** 从文本中抠出最外层平衡的 JSON 数组字面量(跳过字符串内的括号)。 */
function extractJsonArrayLiteral(text) {
    const start = text.indexOf('[');
    if (start < 0) return null;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (escape) { escape = false; continue; }
        if (ch === '\\') { escape = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '[') depth++;
        else if (ch === ']') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return depth > 0 ? text.slice(start) : null;
}

function tryParseJsonArray(raw) {
    const text = String(raw ?? '').trim();
    if (!text) return null;
    // 整段
    try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) return parsed;
        // 双重编码:外层是 JSON 字符串,内容才是数组
        if (typeof parsed === 'string') {
            const inner = parsed.trim();
            try {
                const arr = JSON.parse(inner);
                if (Array.isArray(arr)) return arr;
            } catch { /* 继续用字面量提取 */ }
            const lit = extractJsonArrayLiteral(inner);
            if (lit) {
                try {
                    const arr = JSON.parse(lit);
                    if (Array.isArray(arr)) return arr;
                } catch { /* 忽略 */ }
            }
        }
    } catch { /* 忽略 */ }
    // 从文中抠数组(兼容 ```json 代码块、前后说明文字)
    const lit = extractJsonArrayLiteral(text);
    if (lit) {
        try {
            const arr = JSON.parse(lit);
            if (Array.isArray(arr)) return arr;
        } catch { /* 忽略 */ }
    }
    return null;
}

/**
 * 去掉选项两侧的 JSON/列表残留包裹。
 * 只处理 ASCII 引号与尾随逗号;不剥中文引号「“”『』」——那是台词标点,剥了会缺字。
 */
function cleanOptionText(raw) {
    let x = String(raw ?? '').trim();
    // 若整段是 JSON 字符串字面量(带转义),先解一层
    try {
        const parsed = JSON.parse(x);
        if (typeof parsed === 'string') x = parsed.trim();
    } catch { /* 非 JSON 字符串字面量 */ }
    for (let i = 0; i < 3; i++) {
        const next = x
            .trim()
            .replace(/^["'`]+/, '')
            .replace(/["'`]+$/, '')
            .replace(/,\s*$/, '')
            .trim();
        if (next === x) break;
        x = next;
    }
    // 转义引号残留 \"text\"
    x = x.replace(/^\\+"/, '').replace(/\\+"$/, '').trim();
    return x;
}

function parseOptions(reply, count) {
    let text = String(reply ?? '').trim();
    if (!text) return [];
    // 去掉模型有时包在外面的 markdown 代码块
    text = text.replace(/```(?:json|JSON)?\s*/g, '').replace(/```/g, '').trim();

    const fromJson = tryParseJsonArray(text);
    let arr;
    let needsClean = false;
    if (Array.isArray(fromJson)) {
        // JSON 已是干净字符串,只做轻量 trim;避免误剥台词里的中文引号
        arr = fromJson.map(x => String(x ?? '').trim());
    } else {
        // 降级:逐行解析,去掉序号 / 列表符号前缀
        needsClean = true;
        arr = text
            .split('\n')
            .map(line => line.replace(/^\s*(?:\d+\s*[.、)．]|[-*•])\s*/, '').trim())
            .filter(Boolean);
    }
    const list = [...new Set(
        arr
            .map(x => (needsClean ? cleanOptionText(x) : x))
            .filter(Boolean)
    )].slice(0, count);
    console.debug(LOG_PREFIX, 'parseOptions', {
        fromJson: !!fromJson,
        count: list.length,
        first: list[0]?.slice(0, 50) ?? '',
    });
    return list;
}

// ── 选项存储:跟随 AI 消息分支 ──────────────────────────────
// 落点是 msg.extra(当前分支的 extra),不是 swipe_info[id].extra。
// 酒馆在离开分支时执行 syncMesToSwipe():
//   swipe_info[swipe_id].extra = structuredClone(msg.extra)
// 也就是用 msg.extra 整块覆盖该分支的 extra——写进 swipe_info 的数据会被直接抹掉;
// 切回分支时 syncSwipeToMes() 又把 swipe_info[id].extra 克隆回 msg.extra。
// 所以只写 msg.extra,分支隔离与来回同步交给酒馆自己。
// 每个聊天保留最近 N 条带选项的消息,更老的整条清除;N 可在设置里改。

const OPTIONS_KEY = 'stc_chat_options';
const OPTIONS_STORE_VERSION = 1;
const REMEMBER_LIMIT_MIN = 1;
const REMEMBER_LIMIT_MAX = 50;
const REMEMBER_LIMIT_DEFAULT = 10;

/** 当前生效的保留条数(读设置并夹在 1–50)。 */
function optionHistoryLimit() {
    return clampInt(settings.rememberLimit, REMEMBER_LIMIT_MIN, REMEMBER_LIMIT_MAX, REMEMBER_LIMIT_DEFAULT);
}

let persistTimer = null;

function getSwipeId(msg) {
    return Number.isInteger(msg?.swipe_id) ? msg.swipe_id : 0;
}

/**
 * 当前分支签名:分支号 + 正文前 120 字。
 * 不含消息下标——删除前面的消息会让下标平移,带上反而会把有效数据判成失效;
 * 数据本身就存在这条消息里,不需要靠下标认身份。
 */
function branchSignature(found) {
    if (!found) return '';
    return `${getSwipeId(found.msg)}|${String(found.msg.mes ?? '').slice(0, 120)}`;
}

function lastChatSignature() {
    return branchSignature(findLastAiMessage());
}

/**
 * 兼容 0.5.1:那一版把数据写进了 swipe_info[swipe_id].extra。
 * 当前分支还在、签名对得上就搬到 msg.extra,并清掉旧位置。
 */
function migrateLegacySwipeInfo(msg) {
    if (!Array.isArray(msg?.swipe_info)) return;
    const swipeId = getSwipeId(msg);
    const extra = msg.swipe_info[swipeId]?.extra;
    const legacy = extra?.[OPTIONS_KEY];
    if (!legacy || legacy.v !== OPTIONS_STORE_VERSION) return;
    const sig = branchSignature({ msg });
    if (legacy.sig === sig && !msg.extra?.[OPTIONS_KEY]) {
        if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
        msg.extra[OPTIONS_KEY] = legacy;
    }
    delete extra[OPTIONS_KEY];
}

/** 读取当前分支已存的选项数据;版本不符或结构损坏返回 null。 */
function readStoredOptions(msg) {
    const data = msg?.extra?.[OPTIONS_KEY];
    if (!data || data.v !== OPTIONS_STORE_VERSION) return null;
    if (!Array.isArray(data.options) || !data.options.length) return null;
    return data;
}

/** 把当前选项写入最新 AI 消息(即当前分支的 extra)。 */
function writeStoredOptions() {
    const found = findLastAiMessage();
    if (!found) return;
    const msg = found.msg;
    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
    msg.extra[OPTIONS_KEY] = {
        v: OPTIONS_STORE_VERSION,
        options: lastOptions.slice(),
        direction: String(lastDirection ?? ''),
        selected: String(selectedOptionText ?? ''),
        sig: branchSignature(found),
        updatedAt: Date.now(),
    };
}

/** 只保留最近 N 条带选项的消息,更老的整条(含各分支残留)清除。 */
function pruneStoredOptions() {
    const chat = getContext().chat;
    if (!Array.isArray(chat)) return;
    const limit = optionHistoryLimit();
    let kept = 0;
    for (let i = chat.length - 1; i >= 0; i--) {
        const msg = chat[i];
        if (!msg) continue;
        const inExtra = Boolean(msg.extra?.[OPTIONS_KEY]);
        const inSwipes = Array.isArray(msg.swipe_info)
            && msg.swipe_info.some(s => s?.extra?.[OPTIONS_KEY]);
        if (!inExtra && !inSwipes) continue;
        kept += 1;
        if (kept <= limit) continue;
        if (inExtra) delete msg.extra[OPTIONS_KEY];
        if (inSwipes) {
            for (const s of msg.swipe_info) {
                if (s?.extra?.[OPTIONS_KEY]) delete s.extra[OPTIONS_KEY];
            }
        }
    }
}

async function saveChatSafe() {
    const fn = typeof stScript?.saveChat === 'function' ? stScript.saveChat : null;
    if (!fn) {
        console.warn(LOG_PREFIX, '当前版本未提供 saveChat,选项只在酒馆下次保存聊天时落盘');
        return;
    }
    try {
        await fn();
    } catch (e) {
        console.warn(LOG_PREFIX, '保存聊天失败:', e);
    }
}

/**
 * 落盘当前选项。生成成功后 immediate=true 立即写;
 * 点选高亮这类高频操作走 800ms 防抖,避免每次点击都整份写聊天。
 */
function persistOptions({ immediate = false } = {}) {
    if (!settings.remember || !lastOptions.length) return;
    writeStoredOptions();
    pruneStoredOptions();
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    if (immediate) {
        saveChatSafe();
    } else {
        persistTimer = setTimeout(() => {
            persistTimer = null;
            saveChatSafe();
        }, 800);
    }
}

function clearOptionsState() {
    lastOptions = [];
    lastError = null;
    selectedOptionText = '';
    lastGenSig = '';
}

/**
 * 从当前分支恢复已存选项。
 * 签名一致才回填(正文被编辑或分支对不上时视为失效);没有记录则清空面板。
 */
function restoreStoredOptions() {
    if (!settings.remember) {
        lastOptions = [];
        lastError = null;
        selectedOptionText = '';
        lastGenSig = '';
        return;
    }
    const found = findLastAiMessage();
    if (found) migrateLegacySwipeInfo(found.msg);
    const data = found ? readStoredOptions(found.msg) : null;
    const sig = branchSignature(found);
    if (data && sig && data.sig === sig) {
        lastOptions = data.options.map(x => String(x ?? '').trim()).filter(Boolean);
        const saved = String(data.selected ?? '');
        selectedOptionText = lastOptions.includes(saved) ? saved : '';
        lastError = null;
        lastGenSig = sig; // 已有选项,不再重复自动生成
        return;
    }
    lastOptions = [];
    lastError = null;
    selectedOptionText = '';
    lastGenSig = '';
}

async function generateOptions({ manual = false } = {}) {
    if (generating) return;
    const context = getContext();
    if (!isChatLoaded() || !context.chat.length) {
        if (manual) toastr.warning('当前没有聊天内容,无法生成选项');
        return;
    }

    generating = true;
    lastError = null;
    lastOptions = []; // 生成期间清空,避免失败时残留上一轮选项
    selectedOptionText = '';
    dirEditing = false;
    renderBar();

    try {
        const count = clampInt(settings.gen.count, 1, 8, 4);
        const raw = extractContent();
        if (!raw) throw new Error('没有可用的对话内容');
        // 先用排除正则删掉不发送的内容,再用提取正则从剩余文本中抽取;两者都留空即发送原文
        const content = applyContentRegex(applyExcludeRegex(raw, settings.gen.excludeRegex), settings.gen.regex);
        if (!content) throw new Error('内容已被排除正则全部删除,请检查排除正则');
        // 勾选的世界书条目:生成选项时附带进提示词(不影响酒馆主对话)
        if (Object.keys(settings.wi.selections).length) {
            await ensureWorldBooks();
        }
        const worldInfo = buildWorldInfoContent();
        let prompt = applyNativeMacros(String(settings.gen.prompt || DEFAULT_GEN_PROMPT))
            .replaceAll('{{count}}', () => String(count))
            .replaceAll('{{content}}', () => content);
        // 生成方向:模板写了 {{direction}} 就就地替换,没写则追加到指令末尾;方向文本不做宏替换
        const direction = String(lastDirection ?? '').trim();
        if (direction) {
            prompt = prompt.replaceAll('{{direction}}', () => direction);
            if (!String(settings.gen.prompt || DEFAULT_GEN_PROMPT).includes('{{direction}}')) {
                prompt = `${prompt}\n\n请围绕以下方向生成选项:${direction}`;
            }
        }
        // 世界书设定注入到正文末尾(条目内容同样做原生占位符替换)
        if (worldInfo) {
            prompt = `${prompt}\n\n${applyNativeMacros(worldInfo)}`;
        }
        // 破限词必须在最开头
        const jbText = String(settings.jailbreak.text ?? '').trim();
        if (settings.jailbreak.enabled && jbText) {
            prompt = `${jbText}\n\n${prompt}`;
        }
        const reply = await generateWithConfig(prompt, {
            systemPrompt: '你是选项生成器,只输出 JSON 数组。',
            // 推理模型的思考 token 计入 max_tokens,预算过小会占满导致正文为空
            maxTokens: 8192,
        });
        const list = parseOptions(reply, count);
        if (!list.length) throw new Error('AI 未返回有效选项,请调整生成指令后重试');
        lastOptions = list;
        lastGenSig = lastChatSignature();
        lastError = null;
        persistOptions({ immediate: true });
    } catch (e) {
        console.error(LOG_PREFIX, 'Option generation failed:', e);
        lastError = e.message || String(e);
        if (manual) toastr.error(`选项生成失败:${lastError}`);
    } finally {
        generating = false;
        renderBar();
    }
}

// ── 世界书 ───────────────────────────────────────────────────

let wiCache = [];        // 已加载的世界书数据(含勾选状态)
let wiLoadedOnce = false;

function esc(text) {
    return String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// 从酒馆后端拉取全部世界书,并恢复勾选状态:
// 同一会话内以内存中的勾选为准(避免重拉时丢失),跨页面加载时用已保存的勾选恢复
async function loadWorldBooks() {
    const headers = await getCsrfHeaders();
    const list = await fetch('/api/worldinfo/list', { method: 'POST', headers })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });

    const books = [];
    for (const item of list) {
        try {
            const book = await fetch('/api/worldinfo/get', {
                method: 'POST',
                headers,
                body: JSON.stringify({ name: item.file_id }),
            }).then(r => (r.ok ? r.json() : null));
            if (!book || !book.entries) continue;

            const saved = Array.isArray(settings.wi.selections[item.file_id])
                ? settings.wi.selections[item.file_id]
                : [];
            const prevBook = wiCache.find(b => b.id === item.file_id);
            const entries = Object.values(book.entries)
                .filter(e => e && !e.disable)
                .map(e => {
                    const keys = Array.isArray(e.key) ? e.key.join(', ') : String(e.key ?? '');
                    const prev = prevBook?.entries.find(x => x.uid === e.uid);
                    return {
                        uid: e.uid,
                        title: String(e.comment ?? '').trim() || keys || `条目 ${e.uid}`,
                        keys,
                        content: String(e.content ?? ''),
                        constant: !!e.constant,
                        checked: prev ? prev.checked : saved.includes(e.uid),
                    };
                });
            books.push({ id: item.file_id, name: String(book.name || item.name || item.file_id), entries });
        } catch { /* 单本加载失败,跳过 */ }
    }
    wiCache = books;
    wiLoadedOnce = true;
}

// 按需加载(生成选项时若从未打开过设置面板,也会应用已保存的勾选)
async function ensureWorldBooks() {
    if (wiLoadedOnce) return;
    try {
        await loadWorldBooks();
    } catch (e) {
        console.warn(LOG_PREFIX, '世界书加载失败:', e);
    }
}

// 把勾选条目的内容拼成附加提示词
function buildWorldInfoContent() {
    const lines = [];
    for (const b of wiCache) {
        const checked = b.entries.filter(e => e.checked && e.content.trim());
        if (!checked.length) continue;
        lines.push(`【${b.name}】`);
        for (const e of checked) {
            lines.push(`- ${e.title ? e.title + ': ' : ''}${e.content.trim()}`);
        }
    }
    return lines.length ? `【世界书设定】\n${lines.join('\n')}` : '';
}

// ── 聊天末尾选项框 ────────────────────────────────────────────

function isChatLoaded() {
    const context = getContext();
    return Array.isArray(context.chat);
}

function ensureOptionsBar() {
    const chat = document.querySelector('#chat');
    if (!chat) return null;
    if (!$optionsBar) {
        $optionsBar = $('<div id="stc-chat-options-bar"></div>');
    }
    const bar = $optionsBar[0];
    // 始终保持在聊天消息列表的末尾
    if (bar.parentElement !== chat) {
        chat.appendChild(bar);
    } else if (chat.lastElementChild !== bar) {
        chat.appendChild(bar);
    }
    return bar;
}

function makeRow(className) {
    const row = document.createElement('div');
    row.className = className;
    return row;
}

// 标题栏操作按钮(生成/换一批 / 生成方向)
function makeHeaderAction({ iconClass, label, title, active = false, disabled = false, onClick }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stc-co-act' + (active ? ' is-active' : '');
    btn.title = title;
    btn.setAttribute('aria-label', title);
    if (disabled) btn.disabled = true;
    const icon = document.createElement('i');
    icon.className = iconClass;
    icon.setAttribute('aria-hidden', 'true');
    const span = document.createElement('span');
    span.textContent = label;
    btn.append(icon, span);
    btn.addEventListener('click', onClick);
    return btn;
}

// 折叠按钮:收起后只保留标题栏
function buildCollapseButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'stc-co-collapse';
    btn.setAttribute('aria-expanded', String(!barCollapsed));
    btn.setAttribute('aria-controls', 'stc-co-panel-body');
    const label = document.createElement('span');
    label.textContent = barCollapsed ? '展开' : '收起';
    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-chevron-down stc-co-collapse-icon';
    icon.setAttribute('aria-hidden', 'true');
    btn.append(label, icon);
    btn.addEventListener('click', () => {
        barCollapsed = !barCollapsed;
        renderBar();
    });
    return btn;
}

// 内嵌方向输入行:预填当前方向,回车/✓ 确认,Esc/✕ 取消
function buildDirInputRow() {
    const row = makeRow('stc-co-dir-row');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'stc-co-dir-input';
    input.maxLength = 200;
    input.value = lastDirection;
    input.placeholder = '输入生成方向,如:往悬疑方向…(留空清除)';
    const ok = document.createElement('div');
    ok.className = 'stc-co-dir-act stc-co-dir-ok';
    ok.title = '确认:保存方向并立即生成';
    ok.innerHTML = '<i class="fa-solid fa-check"></i>';
    const cancel = document.createElement('div');
    cancel.className = 'stc-co-dir-act stc-co-dir-cancel';
    cancel.title = '取消';
    cancel.innerHTML = '<i class="fa-solid fa-xmark"></i>';
    ok.addEventListener('click', () => confirmDirection(input.value));
    cancel.addEventListener('click', () => { dirEditing = false; renderBar(); });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); confirmDirection(input.value); }
        else if (e.key === 'Escape') { dirEditing = false; renderBar(); }
    });
    row.appendChild(input);
    row.appendChild(ok);
    row.appendChild(cancel);
    requestAnimationFrame(() => input.focus());
    return row;
}

// 确认方向:非空则保存并立即生成;留空仅清除方向
function confirmDirection(value) {
    lastDirection = String(value ?? '').trim();
    dirEditing = false;
    renderBar();
    if (lastDirection) {
        toastr.success(`生成方向已设置:${lastDirection}`);
        generateOptions({ manual: true });
    }
}

function buildOptionRow(seq, text) {
    const item = document.createElement('li');
    // 逐条错峰入场
    item.style.setProperty('--delay', `${Math.min((seq - 1) * 35, 210)}ms`);

    const btn = makeRow('stc-co-btn');
    btn.setAttribute('aria-label', `选择回应 ${seq}:${text}`);
    if (selectedOptionText === text) btn.classList.add('is-selected');

    const num = document.createElement('span');
    num.className = 'stc-co-num';
    num.textContent = String(seq).padStart(2, '0');
    num.setAttribute('aria-hidden', 'true');

    const copy = document.createElement('span');
    copy.className = 'stc-co-text';
    copy.textContent = text;

    const arrow = document.createElement('span');
    arrow.className = 'stc-co-arrow';
    arrow.textContent = '›';
    arrow.setAttribute('aria-hidden', 'true');

    btn.append(num, copy, arrow);
    btn.addEventListener('click', () => {
        // 覆盖填入时只保留一个高亮;追加填入允许逐条高亮,与填入行为一致
        if (!settings.inputAppend) {
            document.querySelectorAll('#stc-chat-options-bar .stc-co-btn.is-selected')
                .forEach(el => el.classList.remove('is-selected'));
            selectedOptionText = '';
        }
        btn.classList.add('is-selected');
        selectedOptionText = text;
        fillInput(text);
        persistOptions(); // 记下高亮项,刷新后仍保留选中态
    });
    item.appendChild(btn);
    return item;
}

// 生成中 / 生成入口 / 生成失败的占位框
function buildStateBox(kind) {
    const clickable = kind !== 'generating';
    const box = makeRow('stc-co-empty' + (kind === 'error' ? ' is-error' : '') + (clickable ? ' is-clickable' : ''));
    const strong = document.createElement('strong');
    const detail = document.createElement('span');
    if (kind === 'generating') {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-spinner fa-spin';
        icon.setAttribute('aria-hidden', 'true');
        strong.append(icon, document.createTextNode('正在生成选项…'));
        detail.textContent = 'AI 正在阅读最新剧情,请稍候';
    } else if (kind === 'error') {
        strong.textContent = `生成失败:${lastError}`;
        detail.textContent = '点击此处重试,或在右上角修改生成方向';
        box.title = '点击重试';
    } else {
        const icon = document.createElement('i');
        icon.className = 'fa-solid fa-wand-magic-sparkles';
        icon.setAttribute('aria-hidden', 'true');
        strong.append(icon, document.createTextNode('还没有生成选项'));
        detail.textContent = '点击此处立即生成,或先设定生成方向';
        box.title = '点击生成选项';
    }
    box.append(strong, detail);
    if (clickable) {
        box.addEventListener('click', () => generateOptions({ manual: true }));
    }
    return box;
}

function renderBar() {
    const bar = ensureOptionsBar();
    if (!bar) return;
    bar.innerHTML = '';

    // 应用插件本地主题(仅影响选项框外观,不改动酒馆主题)
    bar.classList.remove('stc-theme-dark', 'stc-theme-light');
    if (settings.ui?.theme === 'dark') bar.classList.add('stc-theme-dark');
    if (settings.ui?.theme === 'light') bar.classList.add('stc-theme-light');
    bar.classList.toggle('is-collapsed', barCollapsed);

    if (!settings.enabled || !isChatLoaded()) {
        bar.style.display = 'none';
        return;
    }
    bar.style.display = '';

    // ── 标题栏:标题 + 计数徽章 + 操作区 ──
    const header = makeRow('stc-co-header');
    const titleBlock = makeRow('stc-co-titleblock');
    titleBlock.title = '点击折叠或展开选项面板';
    const titleRow = makeRow('stc-co-title-row');
    const title = document.createElement('span');
    title.className = 'stc-co-title';
    title.textContent = '回应选项';
    const badge = document.createElement('span');
    badge.className = 'stc-co-badge';
    badge.textContent = generating ? '…' : String(lastOptions.length);
    titleRow.append(title, badge);
    titleBlock.appendChild(titleRow);
    titleBlock.addEventListener('click', () => {
        barCollapsed = !barCollapsed;
        renderBar();
    });
    header.appendChild(titleBlock);

    const actions = makeRow('stc-co-actions');
    // 生成入口常驻标题栏:未生成=生成选项,有选项=换一批,失败=重试,生成中置灰
    actions.appendChild(generating
        ? makeHeaderAction({
            iconClass: 'fa-solid fa-spinner fa-spin',
            label: '生成中',
            title: '正在生成选项…',
            disabled: true,
        })
        : makeHeaderAction({
            iconClass: 'fa-solid ' + (lastOptions.length || lastError ? 'fa-rotate-right' : 'fa-wand-magic-sparkles'),
            label: lastError ? '重试' : (lastOptions.length ? '换一批' : '生成选项'),
            title: lastError ? '重新生成选项' : (lastOptions.length ? '重新生成一批选项' : '根据最新剧情生成选项'),
            onClick: () => generateOptions({ manual: true }),
        }));
    actions.appendChild(makeHeaderAction({
        iconClass: 'fa-solid fa-compass',
        label: '生成方向',
        title: lastDirection ? `当前方向:${lastDirection}(点击修改)` : '设置本次生成选项的方向',
        active: Boolean(lastDirection),
        onClick: () => { dirEditing = !dirEditing; renderBar(); },
    }));
    actions.appendChild(buildCollapseButton());
    header.appendChild(actions);
    bar.appendChild(header);

    // ── 主体:选项列表 / 状态占位框 + 内嵌方向输入行 ──
    const body = makeRow('stc-co-body');
    body.id = 'stc-co-panel-body';
    const region = makeRow('stc-co-region');
    if (generating) {
        region.appendChild(buildStateBox('generating'));
    } else if (!lastOptions.length && lastError) {
        region.appendChild(buildStateBox('error'));
    } else if (!lastOptions.length) {
        region.appendChild(buildStateBox('entry'));
    } else {
        const list = document.createElement('ol');
        list.className = 'stc-co-list';
        lastOptions.forEach((text, idx) => list.appendChild(buildOptionRow(idx + 1, text)));
        region.appendChild(list);
    }
    if (dirEditing) region.appendChild(buildDirInputRow());
    body.appendChild(region);
    bar.appendChild(body);

    // ── 状态栏:计数 + 最近状态 ──
    const hasError = Boolean(!lastOptions.length && lastError);
    const footer = makeRow('stc-co-footer');
    const count = document.createElement('span');
    count.textContent = generating
        ? '正在生成…'
        : lastOptions.length ? `共 ${lastOptions.length} 项` : '暂无可用选项';
    const status = document.createElement('span');
    status.className = 'stc-co-status' + (hasError ? ' is-error' : '');
    status.textContent = hasError ? '生成失败,点击面板重试' : (dirEditing ? '正在编辑生成方向' : '就绪');
    footer.append(count, status);
    bar.appendChild(footer);
}

function fillInput(text) {
    const $ta = $('#send_textarea');
    let next = text;
    if (settings?.inputAppend) {
        const prev = String($ta.val() ?? '');
        next = prev.trim() ? `${prev}\n${text}` : text;
    }
    $ta.val(next).trigger('input').trigger('focus');
}

// #chat 的子节点增删(新消息、删除、swipe 渲染等)后,把选项框重新置底
function observeChat() {
    const chat = document.getElementById('chat');
    if (!chat || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver(() => {
        const bar = $optionsBar?.[0];
        if (!bar) return;
        if (chat.lastElementChild !== bar) {
            chat.appendChild(bar);
        }
    });
    observer.observe(chat, { childList: true });
}

// ── 自动生成触发 ──────────────────────────────────────────────

async function onGenerationEnded() {
    if (!settings.enabled || !settings.auto || generating) return;
    const chat = getContext().chat;
    if (!Array.isArray(chat) || !chat.length) return;
    const last = chat[chat.length - 1];
    if (last?.is_user || last?.is_system) return; // 没有新的 AI 内容时不生成
    if (lastChatSignature() === lastGenSig) return; // 同一条消息不重复生成
    await generateOptions();
}

// ── 魔法棒菜单按钮 ────────────────────────────────────────────

function injectWandButton() {
    if (document.getElementById('stc-chat-options-menu-item')) return;
    const item = document.createElement('div');
    item.id = 'stc-chat-options-menu-item';
    item.className = 'list-group-item flex-container flexGap5';
    item.title = '聊天选项设置';
    item.innerHTML = `
        <div class="fa-solid fa-sliders extensionsMenuExtensionButton"></div>
        <span>聊天选项</span>`;
    item.addEventListener('click', openSettingsPopup);
    $('#extensionsMenu').append(item);
}

// ── 设置弹窗 ─────────────────────────────────────────────────

async function openSettingsPopup() {
    const html = await renderTemplateAsync(TEMPLATE_URL, {}, true, true, true);
    const $content = $(html);
    wireSettingsContent($content);
    await callGenericPopup($content, POPUP_TYPE.TEXT, '', {
        okButton: '关闭',
        wide: true,
        allowVerticalScrolling: true,
    });
}

// 渲染设置面板里的世界书列表
function renderWiList($content) {
    const $wrap = $content.find('#stc-wi-books');
    if (!$wrap.length) return;
    const kw = String($content.find('#stc-wi-search').val() ?? '').trim().toLowerCase();
    $wrap.empty();

    if (!wiCache.length) {
        $wrap.append('<div class="wi-empty">没有找到任何世界书</div>');
        updateWiSummary($content);
        return;
    }

    for (const book of wiCache) {
        const bookMatch = !kw || book.name.toLowerCase().includes(kw);
        const entries = book.entries.filter(e =>
            bookMatch || !kw ||
            e.title.toLowerCase().includes(kw) || e.keys.toLowerCase().includes(kw) || e.content.toLowerCase().includes(kw));
        if (kw && !bookMatch && entries.length === 0) continue;

        const checkedCount = book.entries.filter(e => e.checked).length;
        // 有勾选条目的书默认展开,避免误以为勾选丢失
        if (book.open === undefined) book.open = checkedCount > 0;
        const $book = $(`<div class="wi-book${book.open ? ' open' : ''}"></div>`);
        const $head = $(`
            <div class="wi-book-head">
                <label class="checkbox_label">
                    <input type="checkbox" class="wi-book-check" />
                    <span><i class="fa-solid fa-book"></i> ${esc(book.name)}</span>
                </label>
                <span class="wi-book-meta">${book.entries.length} 条 · ${checkedCount} 已选</span>
                <i class="fa-solid fa-chevron-down wi-toggle"></i>
            </div>`);
        const $check = $head.find('.wi-book-check');
        $check.prop('checked', checkedCount === book.entries.length && book.entries.length > 0);
        $check.prop('indeterminate', checkedCount > 0 && checkedCount < book.entries.length);

        const $box = $('<div class="wi-entries"></div>');
        for (const e of entries) {
            const $row = $(`
                <label class="wi-entry${e.checked ? ' checked' : ''}">
                    <input type="checkbox" ${e.checked ? 'checked' : ''} />
                    <span class="wi-entry-title">${esc(e.title)}</span>
                    <span class="wi-badge ${e.constant ? 'blue' : 'green'}">${e.constant ? '常驻' : '关键词'}</span>
                    ${e.keys ? `<span class="wi-keys"><i class="fa-solid fa-key"></i> ${esc(e.keys)}</span>` : ''}
                    <span class="wi-preview">${esc(e.content)}</span>
                </label>`);
            $row.find('input').on('change', function () {
                e.checked = $(this).prop('checked');
                $row.toggleClass('checked', e.checked);
                saveWiSelections();
                // 更新书级勾选状态(全选/半选)
                const total = book.entries.length;
                const c = book.entries.filter(x => x.checked).length;
                $check.prop('checked', c === total);
                $check.prop('indeterminate', c > 0 && c < total);
                $head.find('.wi-book-meta').text(`${total} 条 · ${c} 已选`);
                updateWiSummary($content);
            });
            $box.append($row);
        }

        $check.on('change', function () {
            const checked = $(this).prop('checked');
            book.entries.forEach(e => e.checked = checked);
            saveWiSelections();
            renderWiList($content);
        });
        $head.on('click', function (ev) {
            if ($(ev.target).closest('.checkbox_label').length) return;
            book.open = !book.open;
            $book.toggleClass('open', book.open);
        });

        $book.append($head);
        $book.append($box);
        $wrap.append($book);
    }
    updateWiSummary($content);
}

function updateWiSummary($content) {
    let books = 0, entries = 0;
    for (const b of wiCache) {
        const c = b.entries.filter(e => e.checked).length;
        if (c > 0) { books++; entries += c; }
    }
    $content.find('#stc-wi-summary').html(entries === 0
        ? '未勾选任何条目 — 生成选项的提示词不含世界书内容,其余照常'
        : `已选 <b>${books}</b> 本世界书 · <b>${entries}</b> 个条目,生成选项时将附带这些设定`);
}

function saveWiSelections() {
    const selections = {};
    for (const b of wiCache) {
        const uids = b.entries.filter(e => e.checked).map(e => e.uid);
        if (uids.length) selections[b.id] = uids;
    }
    settings.wi.selections = selections;
    persist();
}

function wireSettingsContent($content) {
    // ── 世界书 ──
    const $wiBlock = $content.find('.stc-wi-block');
    const $wiBody = $content.find('#stc-wi-body');
    const $wiExpandBtn = $content.find('#stc-wi-expand');
    let wiLoadedOnce = false;
    const setWiExpanded = (expanded) => {
        $wiBlock.toggleClass('open', expanded);
        $wiBody.prop('hidden', !expanded);
        $wiExpandBtn.attr('aria-expanded', expanded ? 'true' : 'false')
            .attr('title', expanded ? '收起世界书列表' : '展开世界书列表');
        if (expanded && !wiLoadedOnce) {
            wiLoadedOnce = true;
            loadWorldBooks()
                .then(() => renderWiList($content))
                .catch(e => {
                    console.error(LOG_PREFIX, '世界书加载失败:', e);
                    $content.find('#stc-wi-books').html(`<div class="wi-empty">加载失败:${esc(e.message)}</div>`);
                });
        }
    };
    setWiExpanded(false);
    $wiExpandBtn.on('click', () => setWiExpanded(!$wiBlock.hasClass('open')));
    $content.find('#stc-wi-search').on('input', () => renderWiList($content));
    $content.find('#stc-wi-refresh').on('click', async function () {
        const btn = this;
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i>';
        try {
            await loadWorldBooks();
            renderWiList($content);
        } catch (e) {
            toastr.error(`世界书加载失败:${e.message}`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    });

    // ── 总开关 ──
    $content.find('#stc-co-enabled')
        .prop('checked', settings.enabled)
        .on('change', function () {
            settings.enabled = $(this).prop('checked');
            persist();
            renderBar();
        });

    $content.find('#stc-co-input-append')
        .prop('checked', settings.inputAppend)
        .on('change', function () {
            settings.inputAppend = $(this).prop('checked');
            persist();
            toastr.success(settings.inputAppend ? '选项将追加到输入框末尾' : '选项将覆盖输入框内容');
        });

    // ── 记住选项(跟随消息分支) ──
    $content.find('#stc-co-remember')
        .prop('checked', settings.remember !== false)
        .on('change', function () {
            settings.remember = $(this).prop('checked');
            persist();
            $content.find('#stc-co-remember-limit').prop('disabled', !settings.remember);
            if (settings.remember) {
                restoreStoredOptions();
                persistOptions({ immediate: true });
                toastr.success(`将记住选项:每个聊天最多保留最近 ${optionHistoryLimit()} 条消息,分支各自独立`);
            } else {
                toastr.success('不再记住选项(已写入聊天的数据保留,可随时重新开启)');
            }
            renderBar();
        });

    const $rememberLimit = $content.find('#stc-co-remember-limit');
    $rememberLimit
        .val(optionHistoryLimit())
        .prop('disabled', !settings.remember)
        .on('change', function () {
            settings.rememberLimit = clampInt($(this).val(), REMEMBER_LIMIT_MIN, REMEMBER_LIMIT_MAX, REMEMBER_LIMIT_DEFAULT);
            $(this).val(settings.rememberLimit);
            persist();
            // 调小上限立即裁剪已存数据
            pruneStoredOptions();
            if (settings.remember) saveChatSafe();
            toastr.success(`每个聊天最多保留最近 ${settings.rememberLimit} 条消息的选项`);
        });

    // ── 插件主题:仅控制选项框外观,不改动酒馆本身的 UI 主题 ──
    $content.find('#stc-co-ui-theme')
        .val(settings.ui?.theme ?? 'auto')
        .on('change', function () {
            const value = String($(this).val() ?? 'auto');
            settings.ui.theme = ['auto', 'dark', 'light'].includes(value) ? value : 'auto';
            persist();
            renderBar();
            toastr.success(`插件主题已切换:${settings.ui.theme === 'dark' ? '深色' : settings.ui.theme === 'light' ? '浅色' : '跟随酒馆'}`);
        });

    // ── AI 选项生成 ──
    $content.find('#stc-co-auto')
        .prop('checked', settings.auto)
        .on('change', function () {
            settings.auto = $(this).prop('checked');
            persist();
        });

    const $count = $content.find('#stc-co-gen-count');
    $count.val(settings.gen.count).on('change', function () {
        settings.gen.count = clampInt($(this).val(), 1, 8, 4);
        $(this).val(settings.gen.count);
        persist();
    });

    $content.find('#stc-co-gen-regex').val(settings.gen.regex ?? '').on('input', function () {
        settings.gen.regex = String($(this).val() ?? '');
        persist();
    });

    $content.find('#stc-co-gen-exclude-regex').val(settings.gen.excludeRegex ?? '').on('input', function () {
        settings.gen.excludeRegex = String($(this).val() ?? '');
        persist();
    });

    $content.find('#stc-co-gen-prompt').val(settings.gen.prompt).on('input', function () {
        settings.gen.prompt = String($(this).val() ?? '');
        persist();
    });

    // ── AI API ──
    const api = settings.api;
    $content.find(`input[name="stc-co-api-mode"][value="${api.mode === 'custom' ? 'custom' : 'main'}"]`).prop('checked', true);
    const syncApiMode = () => {
        const mode = $content.find('input[name="stc-co-api-mode"]:checked').val() === 'custom' ? 'custom' : 'main';
        api.mode = mode;
        $content.find('#stc-co-custom-fields').toggle(mode === 'custom');
        persist();
    };
    $content.find('input[name="stc-co-api-mode"]').on('change', syncApiMode);
    syncApiMode();

    $content.find('#stc-co-api-url').val(api.url).on('input change', function () {
        api.url = String($(this).val() ?? '').trim();
        persist();
    });
    $content.find('#stc-co-api-key').val(api.key).on('input change', function () {
        api.key = String($(this).val() ?? '');
        persist();
    });
    $content.find('#stc-co-api-model').val(api.model).on('input change', function () {
        api.model = String($(this).val() ?? '').trim();
        persist();
    });

    $content.find('#stc-co-test-btn').on('click', async function () {
        const btn = this;
        const originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 测试中…';
        try {
            // 预算放宽:推理模型的思考 token 也计入 max_tokens,过小会导致正文被截成空串
            const reply = await generateWithConfig('这是一次连接测试。请只回复两个字符:成功', { maxTokens: 8192 });
            toastr.success(`连接成功,模型返回:${reply.slice(0, 60)}`);
        } catch (e) {
            console.error(LOG_PREFIX, 'API test failed:', e);
            toastr.error(`连接失败:${e.message}`);
        } finally {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
        }
    });

    // ── 破限词 ──
    const jb = settings.jailbreak;
    $content.find('#stc-co-jb-enabled')
        .prop('checked', jb.enabled)
        .on('change', function () {
            jb.enabled = $(this).prop('checked');
            persist();
            applyJailbreakInjection();
            toastr.success(jb.enabled ? '破限词已启用注入' : '破限词已停用');
        });
    $content.find('#stc-co-jb-text').val(jb.text).on('input', function () {
        jb.text = String($(this).val() ?? '');
        persist();
    });
    $content.find('#stc-co-jb-depth').val(jb.depth).on('change', function () {
        jb.depth = clampDepth($(this).val());
        $(this).val(jb.depth);
        persist();
        applyJailbreakInjection();
    });
}

// ── 入口 ─────────────────────────────────────────────────────

jQuery(async () => {
    initSettings();
    applyJailbreakInjection();
    injectWandButton();
    restoreStoredOptions(); // 页面加载后恢复当前分支已存的选项
    renderBar();
    observeChat();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        // 切换聊天:先清空,再尝试从新聊天的最后一条消息恢复已存选项
        clearOptionsState();
        restoreStoredOptions();
        renderBar();
    });
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

    // 分支切换 / 删除 / 编辑消息后,按新的当前分支重新取选项
    const syncFromMessage = () => {
        restoreStoredOptions();
        renderBar();
    };
    if (event_types.MESSAGE_SWIPED) eventSource.on(event_types.MESSAGE_SWIPED, syncFromMessage);
    if (event_types.MESSAGE_DELETED) eventSource.on(event_types.MESSAGE_DELETED, syncFromMessage);
    if (event_types.MESSAGE_EDITED) eventSource.on(event_types.MESSAGE_EDITED, syncFromMessage);

    console.log(LOG_PREFIX, 'loaded');
});
