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
import { POPUP_TYPE, callGenericPopup } from '../../../popup.js';

const MODULE_NAME = 'stc_chat_options';
const LOG_PREFIX = '[STC Chat Options]';
const JB_PROMPT_KEY = `${MODULE_NAME}_jailbreak`;
// 模板版本号:更新 settings.html 后递增,绕开浏览器缓存
const TEMPLATE_VERSION = '10';
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
    // 插件外观主题:仅作用于选项框,不改动酒馆本身的 UI 主题
    ui: {
        theme: 'auto', // 'auto' = 跟随酒馆主题;'dark' = 深色;'light' = 浅色
    },
    // 选项生成参数
    gen: {
        count: 4,      // 每次生成的选项数量
        regex: '',     // 提取正则:从最新 AI 发言中抽取匹配内容发送,留空发送原文
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
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
        throw new Error('响应中没有返回内容');
    }
    return String(content).trim();
}

// ── AI 选项生成 ───────────────────────────────────────────────

function clampInt(value, min, max, fallback) {
    const n = Math.round(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
}

function extractContent() {
    const chat = getContext().chat;
    if (!Array.isArray(chat)) return '';
    // 只取最新一条真实 AI 发言的原文;跳过用户消息、系统消息与系统注入的 HTML 提示(如欢迎语、/help 输出)
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        if (typeof m.mes !== 'string' || !m.mes.trim()) continue;
        if (m.name === 'SillyTavern System' || /^\s*<(div|button|span)\b/i.test(m.mes)) continue;
        return m.mes.trim();
    }
    return '';
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
 * {{char}}/{{user}} 占位符替换:取值走酒馆原生宏引擎(substituteParams),
 * 解析为空时回退「角色」/「用户」。只用于生成指令模板与世界书条目内容,
 * {{content}}(最新剧情原文)不做替换,避免剧情里引用的字面占位符被误改。
 */
function applyCharUserMacros(text) {
    let str = String(text ?? '');
    if (!str.includes('{{')) return str;
    const char = String(substituteParams('{{char}}') ?? '').trim() || '角色';
    const user = String(substituteParams('{{user}}') ?? '').trim() || '用户';
    str = str.replace(/\{\{\s*char\s*\}\}/gi, () => char);
    str = str.replace(/\{\{\s*user\s*\}\}/gi, () => user);
    return str;
}

function parseOptions(reply, count) {
    const text = String(reply ?? '').trim();
    if (!text) return [];
    let arr = null;
    const jsonMatch = text.match(/\[[\s\S]*?\]/);
    if (jsonMatch) {
        try { arr = JSON.parse(jsonMatch[0]); } catch { /* 忽略,走降级解析 */ }
    }
    if (!Array.isArray(arr)) {
        try {
            const parsed = JSON.parse(text);
            if (Array.isArray(parsed)) arr = parsed;
        } catch { /* 忽略,走降级解析 */ }
    }
    if (!Array.isArray(arr)) {
        // 降级:逐行解析,去掉序号 / 列表符号前缀
        arr = text
            .split('\n')
            .map(line => line.replace(/^\s*(?:\d+\s*[.、)．]|[-*•])\s*/, '').trim())
            .filter(Boolean);
    }
    return [...new Set(
        arr
            .map(x => String(x ?? '').trim().replace(/^["“「']|["”」']$/g, ''))
            .filter(Boolean)
    )].slice(0, count);
}

function lastChatSignature() {
    const chat = getContext().chat;
    const last = Array.isArray(chat) && chat.length ? chat[chat.length - 1] : null;
    if (!last) return '';
    return `${chat.length}|${String(last.mes ?? '').slice(0, 120)}`;
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
    renderBar();

    try {
        const count = clampInt(settings.gen.count, 1, 8, 4);
        const content = applyContentRegex(extractContent(), settings.gen.regex);
        if (!content) throw new Error('没有可用的对话内容');
        // 勾选的世界书条目:生成选项时附带进提示词(不影响酒馆主对话)
        if (Object.keys(settings.wi.selections).length) {
            await ensureWorldBooks();
        }
        const worldInfo = buildWorldInfoContent();
        let prompt = applyCharUserMacros(String(settings.gen.prompt || DEFAULT_GEN_PROMPT))
            .replaceAll('{{count}}', () => String(count))
            .replaceAll('{{content}}', () => content);
        // 世界书设定注入到正文末尾(条目内容里的 {{char}}/{{user}} 同样替换)
        if (worldInfo) {
            prompt = `${prompt}\n\n${applyCharUserMacros(worldInfo)}`;
        }
        // 破限词必须在最开头
        const jbText = String(settings.jailbreak.text ?? '').trim();
        if (settings.jailbreak.enabled && jbText) {
            prompt = `${jbText}\n\n${prompt}`;
        }
        const reply = await generateWithConfig(prompt, {
            systemPrompt: '你是选项生成器,只输出 JSON 数组。',
            maxTokens: 400,
        });
        const list = parseOptions(reply, count);
        if (!list.length) throw new Error('AI 未返回有效选项,请调整生成指令后重试');
        lastOptions = list;
        lastGenSig = lastChatSignature();
        lastError = null;
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

function makeIconRow(className, iconClass, text) {
    const row = makeRow(className);
    const icon = document.createElement('i');
    icon.className = iconClass;
    const span = document.createElement('span');
    span.textContent = text;
    row.appendChild(icon);
    row.appendChild(span);
    return row;
}

function buildOptionRow(seq, text) {
    const btn = makeRow('stc-co-btn');
    btn.title = text;

    const num = document.createElement('div');
    num.className = 'stc-co-num';
    num.textContent = String(seq);
    btn.appendChild(num);

    const main = document.createElement('div');
    main.className = 'stc-co-main';
    main.textContent = text;
    btn.appendChild(main);

    btn.addEventListener('click', () => fillInput(text));
    return btn;
}

function renderBar() {
    const bar = ensureOptionsBar();
    if (!bar) return;
    bar.innerHTML = '';

    // 应用插件本地主题(仅影响选项框外观,不改动酒馆主题)
    bar.classList.remove('stc-theme-dark', 'stc-theme-light');
    if (settings.ui?.theme === 'dark') bar.classList.add('stc-theme-dark');
    if (settings.ui?.theme === 'light') bar.classList.add('stc-theme-light');

    if (!settings.enabled || !isChatLoaded()) {
        bar.style.display = 'none';
        return;
    }

    if (generating) {
        bar.style.display = '';
        bar.appendChild(makeIconRow('stc-co-state', 'fa-solid fa-spinner fa-spin', '正在生成选项…'));
        return;
    }

    if (!lastOptions.length && lastError) {
        bar.style.display = '';
        const row = makeIconRow('stc-co-state stc-co-error', 'fa-solid fa-triangle-exclamation', `生成失败:${lastError},点击重试`);
        row.addEventListener('click', () => generateOptions({ manual: true }));
        bar.appendChild(row);
        return;
    }

    if (!lastOptions.length) {
        // 尚未生成过:显示一个入口按钮
        bar.style.display = '';
        const row = makeIconRow('stc-co-state stc-co-entry', 'fa-solid fa-wand-magic-sparkles', '生成选项');
        row.addEventListener('click', () => generateOptions({ manual: true }));
        bar.appendChild(row);
        return;
    }

    bar.style.display = '';
    lastOptions.forEach((text, idx) => bar.appendChild(buildOptionRow(idx + 1, text)));
    const refresh = makeIconRow('stc-co-refresh', 'fa-solid fa-rotate-right', '换一批');
    refresh.addEventListener('click', () => generateOptions({ manual: true }));
    bar.appendChild(refresh);
}

function fillInput(text) {
    const $ta = $('#send_textarea');
    $ta.val(text).trigger('input').trigger('focus');
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
    const wireWi = () => {
        renderWiList($content);
        loadWorldBooks()
            .then(() => renderWiList($content))
            .catch(e => {
                console.error(LOG_PREFIX, '世界书加载失败:', e);
                $content.find('#stc-wi-books').html(`<div class="wi-empty">加载失败:${esc(e.message)}</div>`);
            });
    };
    wireWi();
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
            const reply = await generateWithConfig('这是一次连接测试。请只回复两个字符:成功', { maxTokens: 20 });
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
    renderBar();
    observeChat();

    eventSource.on(event_types.CHAT_CHANGED, () => {
        // 切换聊天后清空旧选项,等下一次生成
        lastOptions = [];
        lastError = null;
        lastGenSig = '';
        renderBar();
    });
    eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);

    console.log(LOG_PREFIX, 'loaded');
});
