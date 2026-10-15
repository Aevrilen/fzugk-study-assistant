// ==UserScript==
// @name         福州大学自考考试刷分助手
// @namespace    local.codex.fzugk
// @version      1.3.4
// @description  阶段考试辅助：可选全自动首答、交卷、平台核对与一轮重做；身份验证由本人完成，平台未公开的正确答案不猜测入库。
// @match        https://fzugk.edu-xl.com/*
// @match        https://resgk.edu-xl.com/*
// @match        https://cws.edu-edu.com/*
// @match        https://em.edu-edu.com.cn/*
// @match        https://e13.edu-edu.com.cn/*
// @match        https://e14.edu-edu.com.cn/*
// @run-at       document-idle
// @downloadURL  http://127.0.0.1:8766/install/exam-assistant.user.js
// @updateURL    http://127.0.0.1:8766/install/exam-assistant.meta.js
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function (root) {
    'use strict';

    const SCRIPT_ID = 'fzugk-exam-assistant';
    const VERSION = '1.3.4';
    const EXAM_ANSWER_TIMEOUT_MS = 15000;
    // GM 存储按脚本隔离，通过用户显式导入配置共享数据。
    const ANSWER_BANK_KEY = 'fzugk-exam-answer-bank-v2';
    const SETTINGS_KEY = 'fzugk-exam-assistant-settings-v1';
    const ANSWERS_KEY = 'fzugk-exam-answers-v1';
    const FLOW_KEY = 'fzugk-exam-flow-v2';
    const RUN_KEY = 'fzugk-exam-run-v2';
    const PENDING_KEY = 'fzugk-exam-pending-v2';
    const PROGRESS_KEY = 'fzugk-exam-progress-v2';
    const TENTATIVE_KEY = 'fzugk-exam-tentative-v1';
    const RECORD_HANDOFF_KEY = 'fzugk-exam-record-handoff-v1';
    const FEEDBACK_KEY = 'fzugk-exam-feedback-v1';
    const ENUM_KEY = 'fzugk-exam-enumeration-v1';

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: false,
        autoAdvance: false,
        fullAuto: false,             // 显式开启后：首轮暂选、自动交卷、读记录并重做一次
        autoRandomFill: false,       // 兼容旧设置键，自动流程不再使用随机答案
        autoFillCorrect: true,       // 兼容旧设置键，自动流程统一使用 AI 优先策略
        useAiFallback: true,         // 沿用存储键名；开启时 AI 优先，非题库兜底
        assistantServiceEnabled: false,
        assistantServiceUrl: 'http://127.0.0.1:8766',
        assistantServiceToken: '',
        minAnswerConfidence: 0.85,
        loopIntervalMs: 1500
    });

    const runtime = {
        state: 'IDLE',
        phase: 'UNKNOWN',
        settings: { ...DEFAULT_SETTINGS },
        timer: null,
        busy: false,
        lastUrl: '',
        course: '',
        papers: [],
        currentPaper: null,
        questions: [],
        logLines: [],
        panel: null,
        answerGeneration: 0,
        lastActionAt: 0,
        submittedAt: 0,
        requests: new Set(),
        lastAiError: '',
        pendingAction: null,
        processedView: '',
        progress: new Map(),
        flow: null,
        tabId: '',
        scanTimer: null,
        observers: new Map(),
        frameListeners: new Map(),
        diagnostic: null,
        scanCount: 0,
        tentative: {},
        targetCandidate: null,
        handoffTimer: null,
        enumResumeTimer: null
    };

    // ---------- 工具函数 ----------

    function normalizeText(value) {
        return String(value ?? '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .replace(/^\s*[（(]?[A-DＡ-Ｄ1-9一二三四五六七八九][）).、．]\s*/i, '')
            .trim()
            .toLowerCase();
    }

    function compactText(value) {
        return String(value ?? '').replace(/\s+/g, '').trim();
    }

    function escapeHtml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fnv1a(value) {
        let hash = 0x811c9dc5;
        const text = String(value);
        for (let i = 0; i < text.length; i += 1) {
            hash ^= text.charCodeAt(i);
            hash = Math.imul(hash, 0x01000193);
        }
        return (`00000000${(hash >>> 0).toString(16)}`).slice(-8);
    }

    function questionFingerprint(course, stem, options) {
        const normalizedOptions = [...(options || [])]
            .map((option) => normalizeText(option.text ?? option))
            .filter(Boolean)
            .sort();
        return fnv1a([normalizeText(course), normalizeText(stem), normalizedOptions.join('|')].join('::'));
    }

    function isVisible(element) {
        if (!element || !element.isConnected) return false;
        const view = element.ownerDocument?.defaultView || root;
        const style = view.getComputedStyle ? view.getComputedStyle(element) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
        for (let parent = element.parentElement; parent; parent = parent.parentElement) {
            const parentStyle = view.getComputedStyle?.(parent);
            if (parentStyle && (parentStyle.display === 'none' || Number(parentStyle.opacity) === 0)) return false;
        }
        const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { width: 1, height: 1 };
        return rect.width > 0 && rect.height > 0;
    }

    function uniqueElements(elements) {
        return [...new Set(elements.filter(Boolean))];
    }

    function sleep(ms) {
        return new Promise((resolve) => root.setTimeout(resolve, ms));
    }

    function gmGet(key, fallback) {
        try {
            if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
            const value = root.localStorage?.getItem(key);
            return value == null ? fallback : JSON.parse(value);
        } catch (_) {
            return fallback;
        }
    }

    function gmSet(key, value) {
        try {
            if (typeof GM_setValue === 'function') return GM_setValue(key, value);
            root.localStorage?.setItem(key, JSON.stringify(value));
        } catch (error) {
            console.warn(`[${SCRIPT_ID}] 本地设置保存失败：${error.message}`);
        }
    }

    function log(message, level = 'info') {
        const line = { at: new Date().toLocaleTimeString(), level, message: String(message) };
        runtime.logLines.push(line);
        if (runtime.logLines.length > 120) runtime.logLines.shift();
        const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
        console[method](`[${SCRIPT_ID}] ${line.message}`);
        updatePanel();
    }

    function notify(title, text) {
        try {
            if (typeof GM_notification === 'function') GM_notification({ title, text, timeout: 10000 });
        } catch (_) {}
        try {
            const context = new (root.AudioContext || root.webkitAudioContext)();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.frequency.value = 620;
            gain.gain.value = 0.08;
            oscillator.connect(gain).connect(context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.25);
        } catch (_) {}
    }

    function loadSettings() {
        try {
            runtime.tabId = root.sessionStorage.getItem('fzugk-exam-tab-v2') || root.crypto.randomUUID();
            root.sessionStorage.setItem('fzugk-exam-tab-v2', runtime.tabId);
            // 跨域内嵌考试拥有独立运行权；不凭父页的 enabled 自动恢复。
            if (root.document.defaultView.parent !== root.document.defaultView) runtime.tabId += `:frame:${root.crypto.randomUUID()}`;
            runtime.pendingAction = JSON.parse(root.sessionStorage.getItem(PENDING_KEY) || 'null');
            const progress = JSON.parse(root.sessionStorage.getItem(PROGRESS_KEY) || '[]');
            const tentative = JSON.parse(root.sessionStorage.getItem(TENTATIVE_KEY) || '{}');
            if (tentative && typeof tentative === 'object' && !Array.isArray(tentative)) runtime.tentative = tentative;
            if (Array.isArray(progress)) runtime.progress = new Map(progress.filter(item => Array.isArray(item) && typeof item[0] === 'string' && Array.isArray(item[1])).map(([key, values]) => [key, new Set(values.filter(value => /^[0-9a-f]{8}$/i.test(value)))]));
        } catch (_) { runtime.tabId = `${Date.now()}-${Math.random()}`; }
        const saved = gmGet(SETTINGS_KEY, {});
        runtime.settings = {
            ...DEFAULT_SETTINGS,
            ...(saved && typeof saved === 'object' ? saved : {})
        };
        runtime.settings.loopIntervalMs = Math.max(750, Number(runtime.settings.loopIntervalMs) || 1500);
        const confidence = Number(runtime.settings.minAnswerConfidence);
        runtime.settings.minAnswerConfidence = Number.isFinite(confidence) && confidence >= 0 && confidence <= 1 ? confidence : 0.85;
        const flow = gmGet(FLOW_KEY, null);
        runtime.flow = flow?.origin === root.location?.origin && Date.now() - Number(flow.at) < 4 * 60 * 60 * 1000 ? flow : null;
        return runtime.settings;
    }

    function saveSettings(patch) {
        runtime.settings = { ...runtime.settings, ...patch };
        gmSet(SETTINGS_KEY, runtime.settings);
        updatePanel();
    }

    // ---------- 文档遍历（含同源 iframe） ----------

    function sameOriginDocuments() {
        const docs = [];
        function visit(doc) {
            if (!doc?.body || docs.includes(doc)) return;
            docs.push(doc);
            for (const frame of doc.querySelectorAll('iframe, frame')) {
                if (!isVisible(frame)) continue;
                try { visit(frame.contentDocument); } catch (_) {}
            }
        }
        visit(root.document);
        return docs;
    }

    // ---------- 控件查找 ----------

    function controlText(element) {
        return String(element?.innerText || element?.value || element?.getAttribute?.('aria-label') || element?.getAttribute?.('title') || '').replace(/\s+/g, '').trim();
    }

    function isInsidePanel(element) {
        return Boolean(element?.closest?.(`#${SCRIPT_ID}-panel`));
    }

    // 平台按钮短语白名单。div/span 只有在自身文字与短语完全一致时才被视为按钮，避免容器 innerText 误匹配。
    const ACTION_PHRASES = Object.freeze([
        '开始考试', '开始答题', '进入考试', '开始测验', '开始测试', '开始作答',
        '提交试卷', '交卷', '提交答卷', '确认交卷', '结束考试', '确认提交', '提交考试',
        '继续考试', '继续答题', '继续作答', '再次考试', '重新考试',
        '考试记录', '成绩查询', '答题记录', '考试历史', '查看记录', '考试成绩', '查看成绩', '查看答案', '查看解析', '查看详情', '查看答卷',
        '下一题', '下一道', '返回', '返回列表', '返回上一', '完成', '关闭', '知道了'
    ]);
    const CLICKABLE_SELECTOR = 'button, a, [role="button"], input[type="button"], input[type="submit"], .ivu-btn, .btn';

    function collectControls(doc = root.document) {
        const strict = [...doc.querySelectorAll(CLICKABLE_SELECTOR)];
        const loose = [...doc.querySelectorAll('span, div, li, p, label')].filter((element) => {
            const text = compactText(controlText(element));
            return text.length > 0 && text.length <= 14 && ACTION_PHRASES.includes(text);
        });
        return uniqueElements([...strict, ...loose]).filter((element) => isVisible(element) && !isInsidePanel(element));
    }

    function findControlByText(regex, scope = null) {
        const scopes = scope ? [scope] : sameOriginDocuments();
        for (const doc of scopes) {
            for (const element of collectControls(doc)) {
                if (!regex.test(controlText(element))) continue;
                const found = element.closest('button, a, [role="button"], input[type="button"], input[type="submit"]') || element;
                if (!found.disabled && found.getAttribute('aria-disabled') !== 'true' && !found.classList.contains('disabled') && isVisible(found)) return found;
            }
        }
        return null;
    }

    function findSubmitPaperButton() {
        return findControlByText(/提交试卷|交卷|提交答卷|确认交卷|结束考试|确认提交|提交考试/);
    }

    function findStartExamButton() {
        return findControlByText(/开始考试|开始答题|进入考试|开始测验|开始测试|开始作答/);
    }

    function findContinueExamButton() {
        return findControlByText(/继续考试|继续答题|继续作答|再次考试|重新考试/);
    }

    function findRecordButton() {
        return findControlByText(/考试记录|成绩查询|答题记录|考试历史|查看记录|考试成绩|查看成绩|查看答案|查看解析|查看详情|查看答卷/);
    }

    // 仅适配已实测的 e13/e14 提交成功页及答卷页，不把普通提示当作成功。
    function card2AttemptToken(kind) {
        if (!['e13.edu-edu.com.cn', 'e14.edu-edu.com.cn'].includes(root.location?.hostname)) return '';
        const path = root.location.pathname;
        const patterns = {
            paper: /^\/exam\/student\/exam2\/doexam\/[^/]+\/\d+\/(\d{10,})$/,
            finished: /^\/exam\/student\/exam\/finished\/[^/]+_(\d{10,})$/,
            record: /^\/exam\/student\/exam2\/(?:view|doview)\/[^/]+_(\d{10,})\/1$/
        };
        return path.match(patterns[kind])?.[1] || '';
    }

    function finishedRecordControl() {
        if (!card2AttemptToken('finished')) return null;
        const infos = [...root.document.querySelectorAll('.ui-info')].filter(node => isVisible(node)
            && [...node.querySelectorAll('p')].some(p => isVisible(p) && /^您的试卷已提交[。.]?$/.test(p.innerText.trim())));
        const buttons = uniqueElements(infos.flatMap(info => collectControls(info).filter(button => controlText(button) === '查看考卷')));
        return buttons.length === 1 ? buttons[0] : null;
    }

    function findNextButton() {
        const card = card2Context();
        if (card && card.index === card.cards.length - 1) return null;
        return findControlByText(/^下一题$|^下一道$|^下一题/);
    }

    function findReturnButton() {
        return findControlByText(/^返回$|返回列表|返回上一|完成|关闭|知道了/);
    }

    // ---------- 课程信息 ----------

    function extractCourseName(preferredDoc = root.document) {
        const recordList = recordListContext();
        if (recordList) return recordList.title;
        for (const doc of uniqueElements([preferredDoc, ...sameOriginDocuments()])) {
            for (const selector of ['.bigTitle > h3', '[data-course-name]', '.course-name', '.course-title', '#courseName', '.subject-name', '.kc-name']) {
                const element = [...doc.querySelectorAll(selector)].find(item => isVisible(item) && !isInsidePanel(item));
                const text = String(element?.getAttribute('data-course-name') || element?.innerText || '').trim();
                if (text) return text.slice(0, 120);
            }
        }
        const heading = preferredDoc.querySelector('h1');
        return (isVisible(heading) && !isInsidePanel(heading) && heading.innerText.trim()) || preferredDoc.title || '未识别课程';
    }

    // ---------- 题目解析（与主脚本同源的解析逻辑） ----------

    const QUESTION_SELECTORS = [
        '.question-item', '.question', '.subject-item', '.test-question', '.topic-item', '.quiz-question',
        '.questionBox', '.ui-question', '[data-question-id]', '[data-subject-id]', '[data-question-idx]',
        '[class*="question-item" i]', '[class*="subject-item" i]', '[class*="exam-question" i]'
    ];

    function usableChoiceInput(input) {
        if (!input?.isConnected) return false;
        const label = input.closest('label') || input.parentElement;
        return isVisible(input) || isVisible(label);
    }

    function findQuestionNodes() {
        const groups = [];
        for (const doc of sameOriginDocuments()) {
            const explicit = uniqueElements(QUESTION_SELECTORS.flatMap(selector => [...doc.querySelectorAll(selector)]))
                .filter(node => isVisible(node) && !isInsidePanel(node) && (node.matches('.ui-question') || node.querySelector('input[type="radio"], input[type="checkbox"], textarea, input[type="text"], .question-options .question-option')));
            if (explicit.length) {
                groups.push(...explicit.filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && node.contains(other))));
                continue;
            }
            for (const input of doc.querySelectorAll('input[type="radio"], input[type="checkbox"], textarea')) {
                if (!usableChoiceInput(input) || isInsidePanel(input)) continue;
                const node = input.closest('.form-group, .topic, .question, .subject, fieldset, [role="group"]') || input.closest('li');
                if (node) groups.push(node);
            }
        }
        return uniqueElements(groups);
    }

    function labelForInput(input, container) {
        if (input.id) {
            try {
                const label = container.querySelector(`label[for="${(container.ownerDocument.defaultView.CSS || root.CSS).escape(input.id)}"]`);
                if (label) return label;
            } catch (_) {}
        }
        return input.closest('label') || input.parentElement;
    }

    function extractStem(container) {
        const selectors = ['.questionBox', '.question-stem-content-preview', '.question-title', '.question-stem', '.stem', '.subject-title', '.topic-title', '.question-content', '.title', 'legend'];
        for (const selector of selectors) {
            const element = [...container.querySelectorAll(selector)].find((item) => isVisible(item) && normalizeText(item.innerText));
            if (element) return String(element.innerText).replace(/^\s*\d+[.、．]\s*/, '').trim();
        }
        const clone = container.cloneNode(true);
        clone.querySelectorAll('input, textarea, button, script, style, .option, .options, label').forEach((node) => node.remove());
        return String(clone.innerText || '').replace(/^\s*\d+[.、．]\s*/, '').trim().slice(0, 1000);
    }

    function parseQuestion(container) {
        // e13/e14 实际单题结构；本轮仅验证读取，不猜测平台点击或选中状态协议。
        if (container.matches('.ui-question')) return parseUiQuestion(container);
        const inputs = [...container.querySelectorAll('input[type="radio"], input[type="checkbox"]')].filter(usableChoiceInput);
        const textInputs = [...container.querySelectorAll('textarea, input[type="text"]')].filter(isVisible);
        const inputOptions = inputs.map((input, index) => {
            const label = labelForInput(input, container);
            const text = String(label?.innerText || input.getAttribute('data-text') || input.value || '').trim();
            return { key: String.fromCharCode(65 + index), text, value: input.value, input, clickTarget: input, controlType: 'input', element: label || input };
        });
        const customOptions = [...container.querySelectorAll('.question-options .question-option')]
            .filter(isVisible)
            .map((element, index) => {
                const marker = element.querySelector('.mark, [class*="mark" i]');
                const textElement = element.querySelector('.option-list, [class*="option-list" i]') || element;
                const markerText = String(marker?.innerText || '').replace(/[.、．)）]/g, '').trim();
                const key = /^[A-ZＡ-Ｚ]$/i.test(markerText) ? markerText.toUpperCase() : String.fromCharCode(65 + index);
                return {
                    key,
                    text: String(textElement.innerText || '').trim(),
                    value: key,
                    input: null,
                    clickTarget: marker || element,
                    controlType: 'custom',
                    element
                };
            });
        const options = inputOptions.length ? inputOptions : customOptions;
        const stem = extractStem(container);
        const typeLabel = String(container.querySelector('.question-stem-preview .question-stem-content-preview, .base-type-label, [class*="type-label" i]')?.innerText || '').trim();
        const type = /多选/.test(typeLabel) || /^(?:多选题|多项选择题)/.test(stem.trim()) || inputs.some((input) => input.type === 'checkbox') ? '多选题'
            : options.length ? (/判断/.test(typeLabel) || options.every(item => /^(正确|错误|对|错|是|否|true|false)$/i.test(normalizeText(item.text))) ? '判断题' : '单选题')
                : textInputs.length ? '填空题' : '未知题型';
        const course = extractCourseName(container.ownerDocument);
        return {
            container,
            course,
            chapter: course,
            type,
            stem,
            options,
            textInputs,
            fingerprint: questionFingerprint(course, stem, options),
            pageUrl: `${root.location?.origin || ''}${root.location?.pathname || ''}`
        };
    }

    function card2Context() {
        // 根据实站已加载的 exam_card2.js / paper_card2.js 及 DOM 验证，严格限定当前作答路由。
        if (!['e13.edu-edu.com.cn', 'e14.edu-edu.com.cn'].includes(root.location?.hostname) || !/^\/exam\/student\/exam2\/doexam\//.test(root.location?.pathname || '')) return null;
        const docs = sameOriginDocuments();
        const panels = docs.flatMap(doc => [...doc.querySelectorAll('.ui-card-panel')]).filter(isVisible);
        const wrappers = docs.flatMap(doc => [...doc.querySelectorAll('.ui-paper-wrapper')]).filter(isVisible);
        if (panels.length !== 1 || wrappers.length !== 1) return null;
        const wrapper = wrappers[0], doc = panels[0].ownerDocument;
        if (wrapper.querySelectorAll('.ui-paper-title').length !== 1 || !wrapper.ownerDocument.querySelector('script[src$="/paper_card2.js"]')) return null;
        const cards = [...panels[0].querySelectorAll('.ui-card-question > ul > li')];
        const all = [...wrapper.querySelectorAll('.ui-question')];
        const visible = all.filter(isVisible);
        const ids = cards.map(card => card.id);
        if (!all.length || cards.length !== all.length || new Set(ids).size !== cards.length
            || new Set(all.map(q => q.id)).size !== all.length || visible.length !== 1
            || all.some(q => !/^q_\d+$/.test(q.id) || !/^psq_\d+$/.test(q.getAttribute('code') || '') || !ids.includes(q.id))) return null;
        const active = cards.filter(card => card.classList.contains('current'));
        if (active.length !== 1 || active[0].id !== visible[0].id) return null;
        if (doc.querySelectorAll('#next-btn').length !== 1 || doc.querySelectorAll('.ui-action-submit').length !== 1) return null;
        return { doc, wrapper, cards, all, current: visible[0], card: active[0], index: cards.indexOf(active[0]) };
    }

    function parseUiQuestion(container) {
        const stemNodes = [...container.querySelectorAll(':scope > .ui-question-title > .ui-question-content-wrapper')].filter(isVisible);
        const optionNodes = [...container.querySelectorAll(':scope > .ui-question-options > li')].filter(isVisible);
        const options = optionNodes.map(element => {
            const markers = element.querySelectorAll(':scope > .ui-question-options-order');
            const contents = element.querySelectorAll(':scope > .ui-question-content-wrapper');
            const key = markers.length === 1 ? markers[0].innerText.trim().toUpperCase() : '';
            return { key, value: key, text: contents.length === 1 ? contents[0].innerText.trim() : '',
                input: null, clickTarget: markers.length === 1 ? markers[0] : null, controlType: 'readonly', element,
                platformCode: element.getAttribute('code') || '', selected: null };
        });
        const typeLabel = container.closest('.ui-question-group')?.querySelector('.ui-question-group-title')?.innerText || '';
        const type = /多选|多项选择/.test(typeLabel) ? '多选题' : /单选|单项选择/.test(typeLabel) ? '单选题' : /判断/.test(typeLabel) ? '判断题' : '未知题型';
        const stem = stemNodes.length === 1 ? stemNodes[0].innerText.trim() : '';
        const course = extractCourseName(container.ownerDocument);
        const mappingValid = Boolean(stem && options.length >= 2 && options.every(o => /^[A-Z]$/.test(o.key) && o.text)
            && new Set(options.map(o => o.key)).size === options.length
            && new Set(options.map(o => normalizeText(o.text))).size === options.length);
        const recordEvidence = Boolean(container.querySelector(':scope > .ui-question-hint, .ui-question-answer-right, .ui-question-answer-error')
            && options.some(o => o.element.matches('.ui-correct-answer')));
        const conflictingControls = Boolean(container.querySelector('input, textarea, [role="radio"], [role="checkbox"]')
            || (container.querySelector('.ui-question-answer-right') && container.querySelector('.ui-question-answer-error')));
        const right = container.querySelector('.ui-question-answer-right');
        const error = container.querySelector('.ui-question-answer-error');
        const resultRecord = Boolean(card2AttemptToken('record') && mappingValid && !conflictingControls
            && container.ownerDocument.querySelector('script[src$="/paper_card2.js"]')
            && ((isVisible(right) && compactText(right.innerText) === '您答对了')
                || (isVisible(error) && /^您答错了/.test(compactText(error.innerText)))));
        const context = card2Context();
        const hasRecordMarker = Boolean(container.querySelector('.ui-question-hint, .ui-correct-answer, .ui-question-answer-error, .ui-question-answer-right'));
        const typeMatches = (type === '单选题' && container.classList.contains('ui-question-1')) || (type === '多选题' && container.classList.contains('ui-question-2'));
        const editable = Boolean(context && context.current === container && mappingValid && !conflictingControls && !hasRecordMarker && typeMatches
            && options.every(o => /^[a-z]$/i.test(o.platformCode) && o.clickTarget && isVisible(o.clickTarget))
            && new Set(options.map(o => o.platformCode.toLowerCase())).size === options.length);
        for (const option of options) {
            option.controlType = editable ? 'card2' : 'readonly';
            option.selected = option.element.classList.contains('ui-option-selected');
            if (!editable) option.clickTarget = null;
        }
        return { container, course, chapter: course, type, stem, options, textInputs: [],
            readOnly: !editable, adapter: 'ui-question', mappingValid, recordEvidence, resultRecord, conflictingControls,
            liveContext: Boolean(context), hasRecordMarker,
            fingerprint: questionFingerprint(course, stem, options), pageUrl: '' };
    }

    function isOptionSelected(option) {
        if (option.controlType === 'readonly') return false;
        if (option.input) return Boolean(option.input.checked);
        if (option.controlType === 'card2') return option.element.classList.contains('ui-option-selected');
        const element = option.element || option.clickTarget;
        return Boolean(element?.getAttribute('aria-checked') === 'true' || element?.classList.contains('selected')
            || element?.querySelector('.selected, .ivu-radio-checked, .ivu-checkbox-checked, .ivu-radio-wrapper-checked, .ivu-checkbox-wrapper-checked'));
    }

    function isOptionLocked(option) {
        if (option.controlType === 'readonly') return true;
        if (option.input) return Boolean(option.input.disabled);
        if (option.controlType === 'card2' && (option.element.closest('[disabled], [aria-disabled="true"], .disabled') || !isVisible(option.clickTarget))) return true;
        const element = option.element || option.clickTarget;
        return Boolean(element?.classList.contains('disabled') || element?.getAttribute('aria-disabled') === 'true');
    }

    // ---------- 答案填写与随机作答 ----------

    function applyAnswer(question, answer, planOnly = false) {
        if (question.readOnly) return { applied: false, reason: '只读题目，尚未验证交互映射' };
        if (!question.container?.isConnected) return { applied: false, reason: '题目已离开页面' };
        if (question.adapter === 'ui-question' && (!card2Context() || !isVisible(question.container) || identityBlocked())) return { applied: false, reason: '平台状态已变化或存在提示窗口' };
        if (question.options.length) {
            const keys = [...new Set((answer.answers || []).map(value => String(value).trim().toUpperCase().replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248))))];
            const texts = [...new Set((answer.answerTexts || []).map(normalizeText).filter(Boolean))];
            const targets = [];
            for (const key of keys) {
                const matches = question.options.filter(option => option.key === key || String(option.value).trim().toUpperCase() === key);
                if (matches.length !== 1) return { applied: false, reason: '答案含无法唯一匹配的选项' };
                targets.push(matches[0]);
            }
            const textTargets = [];
            for (const text of texts) {
                const matches = question.options.filter(option => normalizeText(option.text) === text);
                if (matches.length !== 1) return { applied: false, reason: '答案文字无法唯一匹配选项' };
                textTargets.push(matches[0]);
            }
            if (keys.length && texts.length && (targets.length !== textTargets.length || targets.some(item => !textTargets.includes(item)))) {
                return { applied: false, reason: '答案字母与文字冲突' };
            }
            const matches = uniqueElements(texts.length ? textTargets : targets);
            if (!matches.length) return { applied: false, reason: '答案为空' };
            if (question.type !== '多选题' && matches.length !== 1) return { applied: false, reason: '单选题答案数量异常' };
            const changes = question.options.filter(option => isOptionSelected(option) !== matches.includes(option));
            if (changes.some(isOptionLocked)) return { applied: false, reason: '题目选项已锁定' };
            // 单选无需取消原项，直接点击目标即可；多选逐项同步完整集合。
            const clicks = question.type === '多选题' ? changes : matches.filter(option => !isOptionSelected(option));
            if (planOnly) return { planned: true, clicks, selected: matches.map(option => option.key) };
            for (const option of clicks) option.clickTarget?.click();
            const verified = question.options.every(option => isOptionSelected(option) === matches.includes(option));
            return { applied: verified, selected: matches.map(option => option.key), reason: verified ? '' : '页面选择状态校验失败' };
        }
        const values = (answer.answerTexts?.length ? answer.answerTexts : answer.answers || []).map(item => String(item).trim()).filter(Boolean);
        if (!question.textInputs.length || values.length !== question.textInputs.length) return { applied: false, reason: '文字答案与输入框数量不一致' };
        if (question.textInputs.some(input => input.disabled || input.readOnly)) return { applied: false, reason: '文字输入框已锁定' };
        for (let i = 0; i < values.length; i++) {
            const input = question.textInputs[i];
            const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
            if (setter) setter.call(input, values[i]); else input.value = values[i];
            const EventCtor = input.ownerDocument.defaultView.Event;
            input.dispatchEvent(new EventCtor('input', { bubbles: true }));
            input.dispatchEvent(new EventCtor('change', { bubbles: true }));
        }
        const verified = question.textInputs.every((input, i) => input.value === values[i]);
        return { applied: verified, selected: values, reason: verified ? '' : '文字填写校验失败' };
    }

    function randomFill(question, planOnly = false) {
        if (question.readOnly) return { applied: false, reason: '只读题目不可填写' };
        if (!question.options.length) return { applied: false, reason: '该题型不支持随机首答，请本人填写' };
        if (question.options.some(isOptionLocked)) return { applied: false, reason: '题目选项已锁定' };
        const shuffled = [...question.options];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        const count = question.type === '多选题' ? 1 + Math.floor(Math.random() * shuffled.length) : 1;
        return applyAnswer(question, { answers: shuffled.slice(0, count).map(option => option.key) }, planOnly);
    }

    // ---------- 正确答案提取（考试记录页） ----------

    function extractCorrectAnswer(question) {
        if (question.adapter === 'ui-question') {
            if (!question.mappingValid || question.conflictingControls) return null;
            let answers = question.recordEvidence ? question.options.filter(o => o.element.matches('.ui-correct-answer')).map(o => o.key) : [];
            if (!answers.length && question.resultRecord && !question.container.querySelector('.ui-question-answer-error')) {
                // 只有明确“答对”的只读结果才能验证当时选择；错题高亮仍只是用户答案。
                answers = question.options.filter(o => o.element.classList.contains('ui-option-selected')
                    && /^[a-z]$/i.test(o.platformCode) && o.platformCode.toUpperCase() === o.key).map(o => o.key);
            }
            if (question.type === '未知题型' || !answers.length || (question.type !== '多选题' && answers.length !== 1)) return null;
            return { answers, answerTexts: [], explanation: '', source: '考试记录', confidence: 1 };
        }
        const scope = question.container;
        const marked = [...scope.querySelectorAll('.correct-answer, .right-answer, [class*="correct-answer" i], [class*="right-answer" i]')].filter(isVisible);
        const contents = [...new Set(marked.map(node => node.innerText.trim()).filter(Boolean))];
        if (!contents.length) {
            const label = [...scope.querySelectorAll('div, p, span')].find(node => isVisible(node)
                && !node.closest('.question-title, .question-stem, .question-stem-content-preview, .stem, .subject-title, .topic-title, .question-content, legend, label, .question-options')
                && /^\s*正确答案(?:(?:是|为)\s*[：:]?\s*|\s*[：:]\s*)\S/.test(node.innerText || ''));
            if (label) contents.push(label.innerText.trim());
        }
        const keys = new Set();
        const texts = new Set();
        for (const raw of contents) {
            const value = raw.replace(/^\s*正确答案(?:是|为)?\s*[：:]?\s*/, '').split('\n')[0].trim();
            const letters = value.toUpperCase().replace(/[Ａ-Ｚ]/g, c => String.fromCharCode(c.charCodeAt(0) - 65248));
            if (question.options.length && /^[A-Z](?:[\s,，、;；/]*[A-Z])*$/.test(letters)) {
                const wanted = letters.match(/[A-Z]/g) || [];
                if (wanted.some(key => !question.options.some(option => option.key === key))) return null;
                wanted.forEach(key => keys.add(key));
            } else if (question.options.length) {
                const exact = question.options.filter(option => normalizeText(option.text) === normalizeText(value));
                const parts = exact.length ? [value] : value.split(/[;；、]/).map(item => item.trim()).filter(Boolean);
                for (const part of parts) {
                    const matches = question.options.filter(option => normalizeText(option.text) === normalizeText(part));
                    if (matches.length !== 1) return null;
                    keys.add(matches[0].key);
                }
            } else if (value) texts.add(value);
        }
        // 高亮只在只读记录题目中采信；已选中的 UI 标记不属于正确答案证据。
        if (!contents.length && question.options.length && question.options.every(isOptionLocked)) {
            question.options.filter(option => option.element?.matches('.correct, .right, [data-correct="true"]')).forEach(option => keys.add(option.key));
        }
        if (!keys.size && !texts.size) return null;
        if (question.options.length && question.type !== '多选题' && keys.size !== 1) return null;
        return { answers: [...keys].sort(), answerTexts: [...texts], explanation: '', source: '考试记录', confidence: 1 };
    }

    // ---------- 本地答案记录 ----------

    function loadAnswers() {
        const data = gmGet(ANSWERS_KEY, {});
        return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    }

    function saveAnswers(data) {
        gmSet(ANSWERS_KEY, data);
    }

    function answerStoreKey(course, paperTitle) {
        return `${normalizeText(course)}::${normalizeText(paperTitle)}`;
    }

    // ---------- 平台反馈与有限候选枚举 ----------
    // 枚举由用户明确启动；试答只进入失败组合历史，不写入正确答案库。
    function selectedContentSet(question) {
        return question.options.filter(option => option.element.classList.contains('ui-option-selected'))
            .map(option => normalizeText(option.text)).sort();
    }

    function capturePlatformFeedback(questions, persist = true) {
        if (!card2AttemptToken('record') || !questions.length || questions.some(q => !q.resultRecord || !q.mappingValid)) return null;
        const course = questions[0].course, paper = currentPaperTitle(), key = answerStoreKey(course, paper);
        const all = gmGet(FEEDBACK_KEY, {}), previous = all[key];
        const items = {};
        for (const q of questions) {
            const layout = q.options.map(o => normalizeText(o.text)), selected = selectedContentSet(q);
            const old = previous?.questions?.[q.fingerprint];
            const validOld = old && JSON.stringify([...old.layout].sort()) === JSON.stringify([...layout].sort());
            const failedSets = validOld ? [...old.failedSets] : [];
            const wrong = Boolean(q.container.querySelector('.ui-question-answer-error'));
            if (wrong && selected.length && (q.type === '多选题' || selected.length === 1)
                && !failedSets.some(set => JSON.stringify(set) === JSON.stringify(selected))) failedSets.push(selected);
            items[q.fingerprint] = { stem: q.stem, type: q.type, layout, selected,
                status: wrong ? 'wrong' : extractCorrectAnswer(q) ? 'right' : 'unknown', failedSets };
        }
        const result = { course, paper, origin: root.location.origin, attemptToken: card2AttemptToken('record'),
            at: Date.now(), total: questions.length, questions: items };
        if (persist) { all[key] = result; gmSet(FEEDBACK_KEY, all); }
        return result;
    }

    function recordListContext() {
        if (root.location?.hostname !== 'em.edu-edu.com.cn'
            || !/^\/exam-admin\/student\/exam\/single\/view\/doresult\//.test(root.location.pathname)) return null;
        const heading = [...root.document.querySelectorAll('#ui-client-wrapper h2, .ui-client-wrapper h2')].find(isVisible);
        const title = heading?.innerText.match(/您参加《([^》]+)》的记录如下/ )?.[1]?.trim();
        if (!title) return null;
        const entries = [...root.document.querySelectorAll('table tr')].map(row => {
            const links = [...row.querySelectorAll('a[href]')].filter(isVisible);
            const restart = links.find(link => controlText(link) === '继续考试');
            const review = links.find(link => controlText(link) === '查看答卷');
            if (!restart || !review) return null;
            let url; try { url = new URL(restart.href); } catch (_) { return null; }
            const token = url.pathname.match(/^\/exam-admin\/student\/exam\/single\/restart\/[^/]+_(\d{10,})\/guokao$/)?.[1];
            return token && url.origin === root.location.origin ? { row, restart, review, attemptToken: token } : null;
        }).filter(Boolean);
        return { title, entries };
    }

    function enumerationState() {
        const state = gmGet(ENUM_KEY, null);
        return state?.running && state.expires > Date.now() ? state : null;
    }

    function nextEnumerationPlan(feedback) {
        const plan = {};
        for (const [fp, q] of Object.entries(feedback.questions)) {
            if (q.status === 'right') continue;
            if (q.status !== 'wrong' || !q.failedSets.length || !['单选题', '多选题', '判断题'].includes(q.type))
                return { error: '缺少可靠的逐题判错反馈，不能枚举' };
            const rejected = new Set(q.failedSets.map(set => JSON.stringify([...set].sort())));
            let choice;
            if (q.type !== '多选题') choice = q.layout.map(text => [text]).find(set => !rejected.has(JSON.stringify(set)));
            else {
                if (q.layout.length > 16) return { error: '多选题选项超过16个，请先人工核验题型' };
                for (let mask = 1; mask < 2 ** q.layout.length; mask++) {
                    const set = q.layout.filter((text, index) => mask & (2 ** index)).sort();
                    if (!rejected.has(JSON.stringify(set))) { choice = set; break; }
                }
            }
            if (!choice) return { error: `所有候选都被平台判错，需检查选项映射或评分反馈：${String(q.stem || '未识别题目').slice(0, 40)}` };
            plan[fp] = choice;
        }
        return { plan };
    }

    function enumerationPaperMatches(state) {
        const card = card2Context();
        if (!card || root.location.origin !== state.examOrigin || card2AttemptToken('paper') !== state.attemptToken
            || normalizeText(currentPaperTitle()) !== normalizeText(state.paper) || card.all.length !== state.total) return false;
        const course = extractCourseName(card.wrapper.ownerDocument);
        if (normalizeText(course) !== normalizeText(state.course)) return false;
        const fingerprints = card.all.map(node => questionFingerprint(course,
            node.querySelector(':scope > .ui-question-title > .ui-question-content-wrapper')?.textContent.trim(),
            [...node.querySelectorAll(':scope > .ui-question-options > li > .ui-question-content-wrapper')].map(e => e.textContent.trim()))).sort();
        return JSON.stringify(fingerprints) === JSON.stringify(state.fingerprints);
    }

    function haltEnumeration(reason) {
        const state = gmGet(ENUM_KEY, null);
        if (state?.running) { state.running = false; state.stage = 'STOPPED'; state.reason = reason; gmSet(ENUM_KEY, state); }
    }

    function openEnumerationPaper(state, context) {
        const targets = context.entries.filter(entry => entry.attemptToken === state.attemptToken);
        if (targets.length !== 1 || normalizeText(context.title) !== normalizeText(state.paper)) {
            pauseForBrowserTakeover('考试记录中未找到同一试卷与作答批次的唯一继续入口'); return;
        }
        state.stage = 'OPEN_PAPER'; state.navigationAt = Date.now(); state.round++;
        state.activeOwner = runtime.tabId; gmSet(ENUM_KEY, state);
        gmSet(RUN_KEY, { owner: runtime.tabId, origin: root.location.origin, at: Date.now() });
        log(`枚举第${state.round}轮：通过平台「继续考试」重新进入，仅更换 ${Object.keys(state.plan).length} 道未验证题。`);
        targets[0].restart.click();
    }

    function startEnumeration() {
        const context = recordListContext();
        if (!context || runtime.busy || runtime.pendingAction) { log('请在平台考试记录列表启动枚举，且先处理待确认动作。', 'warn'); return; }
        const feedback = Object.values(gmGet(FEEDBACK_KEY, {})).filter(item => normalizeText(item.paper) === normalizeText(context.title)
            && Date.now() - item.at < 4 * 60 * 60 * 1000 && context.entries.some(e => e.attemptToken === item.attemptToken));
        if (feedback.length !== 1) { log('请先打开这份答卷并读取答案，保存完整的逐题对错反馈。', 'warn'); return; }
        const f = feedback[0], result = nextEnumerationPlan(f);
        if (result.error || !Object.keys(result.plan).length) { log(result.error || '本卷所有题目已有平台正确反馈，无需枚举。', 'warn'); return; }
        const bank = loadAnswers()[answerStoreKey(f.course, f.paper)] || {};
        if (Object.entries(f.questions).some(([fp, q]) => q.status === 'right' && bank[fp]?.verifiedBy !== 'platform-record')) {
            log('平台答对题尚未完整保存，请先读取答案。', 'warn'); return;
        }
        if (Object.entries(f.questions).some(([fp, q]) => q.status === 'wrong' && bank[fp]?.verifiedBy === 'platform-record'
            && q.failedSets.some(set => JSON.stringify(set) === JSON.stringify([...(bank[fp].correctOptionTexts || [])].sort())))) {
            log('同一答案同时存在平台答对和判错记录，请先检查评分反馈，暂不枚举。', 'warn'); return;
        }
        stop();
        const state = { id: root.crypto.randomUUID(), running: true, stage: 'NAV_LIST', at: Date.now(), expires: Date.now() + 2 * 60 * 60 * 1000,
            activeOwner: runtime.tabId, listUrl: root.location.href, examOrigin: f.origin, course: f.course, paper: f.paper,
            attemptToken: f.attemptToken, total: f.total, fingerprints: Object.keys(f.questions).sort(),
            plan: result.plan, locked: Object.entries(f.questions).filter(([, q]) => q.status === 'right').map(([fp]) => fp), round: 0, history: [] };
        gmSet(ENUM_KEY, state); saveSettings({ enabled: true, fullAuto: true, autoAdvance: true });
        runtime.panel.querySelector('[data-role="full-auto"]').checked = true;
        runtime.panel.querySelector('[data-role="auto-advance"]').checked = true;
        openEnumerationPaper(state, context);
    }

    function finishEnumerationRecord(questions, feedback) {
        const state = enumerationState();
        if (!state || state.activeOwner !== runtime.tabId || state.stage !== 'OPEN_RECORD') return false;
        if (!feedback || feedback.total !== state.total || feedback.attemptToken !== state.attemptToken
            || JSON.stringify(Object.keys(feedback.questions).sort()) !== JSON.stringify(state.fingerprints)) {
            pauseForBrowserTakeover('枚举结果的试卷或逐题反馈不完整'); return true;
        }
        if (state.locked.some(fp => feedback.questions[fp]?.status !== 'right')
            || Object.entries(state.plan).some(([fp, set]) => JSON.stringify(feedback.questions[fp]?.selected) !== JSON.stringify([...set].sort()))) {
            pauseForBrowserTakeover('本轮记录与保存的候选不一致，或已验证题突然判错；不采信这次反馈'); return true;
        }
        state.locked = Object.entries(feedback.questions).filter(([, q]) => q.status === 'right').map(([fp]) => fp);
        state.history.push({ round: state.round, correct: state.locked.length, total: state.total, at: Date.now() });
        log(`枚举第${state.round}轮平台反馈：${state.locked.length}/${state.total} 道答对；已验证答案已保存。`);
        if (state.locked.length === state.total) {
            state.running = false; state.stage = 'DONE'; gmSet(ENUM_KEY, state);
            finishAutomaticRun('DONE', '枚举完成：整卷所有题目均获平台正确反馈，已停止，不再继续重考。'); return true;
        }
        const result = nextEnumerationPlan(feedback);
        if (result.error) { gmSet(ENUM_KEY, state); pauseForBrowserTakeover(result.error); return true; }
        state.plan = result.plan; state.stage = 'NAV_LIST'; state.navigationAt = Date.now(); gmSet(ENUM_KEY, state);
        runtime.pendingAction = null; root.sessionStorage.removeItem(PENDING_KEY);
        stop(false);
        // 只回到启动时从真实页面取得的考试记录地址；不拼接接口、不创建新考试。
        root.location.assign(state.listUrl);
        return true;
    }

    function tryEnumerationResume() {
        const state = enumerationState();
        if (!state || !runtime.settings.enabled || gmGet(RUN_KEY, {})?.owner !== state.activeOwner) return;
        const context = recordListContext();
        const paperRoute = card2AttemptToken('paper'), recordRoute = card2AttemptToken('record');
        const destination = state.stage === 'NAV_LIST' ? context && root.location.href === state.listUrl
            : state.stage === 'OPEN_PAPER' ? paperRoute === state.attemptToken && root.location.origin === state.examOrigin
                : state.stage === 'OPEN_RECORD' ? recordRoute === state.attemptToken && root.location.origin === state.examOrigin : false;
        if (!destination) return;
        if (Date.now() - state.navigationAt > 30000) { pauseForBrowserTakeover('枚举页面衔接超过30秒，请检查平台状态'); return; }
        if (identityBlocked(true)) { pauseForBrowserTakeover('枚举重入需要本人处理平台验证或提示'); return; }
        if (paperLoading()) { runtime.enumResumeTimer = root.setTimeout(tryEnumerationResume, 200); return; }
        if (state.stage === 'NAV_LIST') { openEnumerationPaper(state, context); return; }
        const questions = findQuestionNodes().map(parseQuestion);
        if (!questions.length) { runtime.enumResumeTimer = root.setTimeout(tryEnumerationResume, 200); return; }
        // 实站先显示题目，随后才设置答题卡当前项；未完成初始化不能视为试卷身份不匹配。
        if (state.stage === 'OPEN_PAPER' && !card2Context()) {
            runtime.enumResumeTimer = root.setTimeout(tryEnumerationResume, 200); return;
        }
        if (state.stage === 'OPEN_PAPER' && !enumerationPaperMatches(state)) {
            pauseForBrowserTakeover('重入的科目、试卷、题目集合或作答批次不匹配'); return;
        }
        if (state.stage === 'OPEN_RECORD' && (detectPhase(questions) !== 'RECORD'
            || normalizeText(questions[0].course) !== normalizeText(state.course)
            || normalizeText(currentPaperTitle()) !== normalizeText(state.paper))) {
            pauseForBrowserTakeover('新答卷与枚举目标不匹配'); return;
        }
        runtime.tabId = root.crypto.randomUUID(); root.sessionStorage.setItem('fzugk-exam-tab-v2', runtime.tabId);
        state.activeOwner = runtime.tabId;
        if (state.stage === 'OPEN_PAPER') state.stage = 'ANSWERING';
        gmSet(ENUM_KEY, state);
        runtime.pendingAction = null; root.sessionStorage.removeItem(PENDING_KEY);
        runtime.flow = { origin: root.location.origin, course: state.course, paper: state.paper, mode: 'enum',
            stage: state.stage === 'ANSWERING' ? 'answering' : 'submitted', attemptToken: state.attemptToken, expectedTotal: state.total, at: Date.now() };
        gmSet(FLOW_KEY, runtime.flow); start();
    }

    function recordAnswers(course, paperTitle, questions) {
        const data = loadAnswers();
        const key = answerStoreKey(course, paperTitle);
        const bucket = data[key] && typeof data[key] === 'object' && !Array.isArray(data[key]) ? data[key] : {};
        for (const question of questions) {
            const answer = extractCorrectAnswer(question);
            if (!answer) continue;
            bucket[question.fingerprint] = {
                ...answer, schema: 2, verifiedBy: 'platform-record', stem: question.stem,
                optionLayout: question.options.map(option => normalizeText(option.text)),
                correctOptionTexts: question.options.filter(option => answer.answers.includes(option.key)).map(option => normalizeText(option.text)),
                capturedAt: Date.now()
            };
        }
        data[key] = bucket;
        saveAnswers(data);
        return bucket;
    }

    function lookUpRecordedAnswer(course, paperTitle, question) {
        const bucket = loadAnswers()[answerStoreKey(course, paperTitle)] || {};
        const entry = bucket[question.fingerprint];
        if (!entry || normalizeText(entry.stem) !== normalizeText(question.stem)) return null;
        if (!question.options.length) return entry.answerTexts?.length ? entry : null;
        const layout = question.options.map(option => normalizeText(option.text)).sort();
        if (entry.schema !== 2 || JSON.stringify([...(entry.optionLayout || [])].sort()) !== JSON.stringify(layout) || !entry.correctOptionTexts?.length) return null;
        return { ...entry, answers: [], answerTexts: entry.correctOptionTexts };
    }

    // ---------- 本地答案表 ----------

    function matchAnswerBank(question, strict = false) {
        const bank = gmGet(ANSWER_BANK_KEY, gmGet('fzugk-answer-bank-v1', []));
        if (!Array.isArray(bank)) return null;
        const scoped = bank.filter(item => item && typeof item === 'object' && (!item.course || normalizeText(item.course) === normalizeText(question.course)));
        const stem = normalizeText(question.stem);
        const candidates = scoped.filter(item => item.fingerprint === question.fingerprint);
        const matches = candidates.length ? candidates : scoped.filter(item => normalizeText(item.stem) === stem || (item.stemIncludes && stem.includes(normalizeText(item.stemIncludes))));
        if (matches.length !== 1) return null;
        const entry = matches[0];
        if (strict) {
            const layout = entry.optionLayout || entry.options?.map(option => option.text ?? option);
            if (normalizeText(entry.stem) !== stem || !Array.isArray(layout)
                || JSON.stringify(layout.map(normalizeText).sort()) !== JSON.stringify(question.options.map(o => normalizeText(o.text)).sort())
                || !Array.isArray(entry.answerTexts) || !entry.answerTexts.length) return null;
        }
        return { answers: strict ? [] : (Array.isArray(entry.answers) ? entry.answers : [entry.answer].filter(Boolean)), answerTexts: entry.answerTexts || [], explanation: entry.explanation || '', source: entry.source || '本地答案表', confidence: Number(entry.confidence ?? 1) };
    }

    function solveArithmeticQuestion(question) {
        const source = String(question.stem || '').replace(/[＝]/g, '=').replace(/[×xX]/g, '*').replace(/[÷]/g, '/');
        const match = source.match(/(-?\d+)\s*([+\-*/])\s*(-?\d+)\s*=\s*\?/);
        if (!match) return null;
        const left = Number(match[1]);
        const right = Number(match[3]);
        const operation = match[2];
        let value;
        if (operation === '+') value = left + right;
        if (operation === '-') value = left - right;
        if (operation === '*') value = left * right;
        if (operation === '/' && right !== 0) value = left / right;
        if (!Number.isFinite(value)) return null;
        return { answers: [], answerTexts: [String(value)], explanation: `${left} ${operation} ${right} = ${value}`, source: '算术题自动计算', confidence: 1 };
    }

    // ---------- 本地 AI 服务 ----------

    function assistantServiceBaseUrl() {
        try {
            const url = new URL(runtime.settings.assistantServiceUrl || 'http://127.0.0.1:8766');
            if (!['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error('辅助服务必须位于本机');
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('辅助服务协议无效');
            if (url.username || url.password || url.search || url.hash) throw new Error('服务地址不能含登录信息、查询参数或片段');
            return url.toString().replace(/\/$/, '');
        } catch (error) {
            throw new Error(`辅助服务地址无效：${error.message}`);
        }
    }

    function serviceRequest(pathname, body = null, method = 'POST', timeoutMs = 5000) {
        const url = `${assistantServiceBaseUrl()}${pathname}`;
        const headers = { 'X-FZUGK-Token': runtime.settings.assistantServiceToken || '' };
        if (body != null) headers['Content-Type'] = 'application/json';
        const parse = (text, value) => {
            if (value && typeof value === 'object') return value;
            try { return JSON.parse(text || '{}'); } catch (_) { throw new Error('辅助服务返回了无效 JSON'); }
        };
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                let request;
                let finished = false;
                const finish = (error, data) => {
                    if (finished) return;
                    finished = true;
                    runtime.requests.delete(cancel);
                    error ? reject(error) : resolve(data);
                };
                const cancel = () => {
                    finish(new Error('操作已取消'));
                    try { request?.abort?.(); } catch (_) {}
                };
                runtime.requests.add(cancel);
                try {
                    request = GM_xmlhttpRequest({
                        method, url, headers, data: body == null ? undefined : JSON.stringify(body), responseType: 'json', timeout: timeoutMs,
                        onload: response => {
                            try {
                                const data = parse(response.responseText, response.response);
                                if (response.status < 200 || response.status >= 300 || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
                                finish(null, data);
                            } catch (error) { finish(error); }
                        },
                        ontimeout: () => finish(new Error('辅助服务请求超时')),
                        onerror: () => finish(new Error('无法连接本地辅助服务')),
                        onabort: () => finish(new Error('操作已取消'))
                    });
                } catch (error) { finish(error); }
            });
        }
        const controller = new AbortController();
        const cancel = () => controller.abort();
        runtime.requests.add(cancel);
        let timedOut = false;
        const timeout = root.setTimeout(() => { timedOut = true; cancel(); }, timeoutMs);
        return fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body), signal: controller.signal })
            .then(async response => {
                const data = parse(await response.text());
                if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
                return data;
            }).catch(error => { throw timedOut ? new Error('辅助服务请求超时') : error; })
            .finally(() => { root.clearTimeout(timeout); runtime.requests.delete(cancel); });
    }

    async function askAssistantService(question, deadline = Date.now() + EXAM_ANSWER_TIMEOUT_MS) {
        const settings = runtime.settings;
        if (!settings.assistantServiceEnabled || !settings.assistantServiceToken) return null;
        try {
            const data = await serviceRequest('/api/answer', {
                question: {
                    fingerprint: question.fingerprint,
                    course: question.course,
                    chapter: question.chapter,
                    type: question.type,
                    stem: question.stem,
                    options: question.options.map((item) => ({ key: item.key, text: item.text }))
                },
                materials: [],
                answerPolicy: 'ai-first',
                webSearchMode: 'bounded',
                deadlinePolicy: 'single-attempt'
            }, 'POST', Math.max(1, deadline - Date.now()));
            if (data.answerPolicy !== 'ai-first' || data.deadlinePolicy !== 'single-attempt') throw new Error('本地服务未确认限时 AI 优先策略，请更新服务');
            if (!data.resolved) return null;
            return {
                answers: Array.isArray(data.answers) ? data.answers : [],
                answerTexts: Array.isArray(data.answerTexts) ? data.answerTexts : [],
                explanation: data.explanation || '',
                source: data.source || 'AI 辅助',
                confidence: Number(data.confidence || 0)
            };
        } catch (error) {
            runtime.lastAiError = error.message;
            log(`AI 辅助请求失败：${error.message}`, 'warn');
            return null;
        }
    }

    function answerUsable(question, answer) {
        const confidence = Number(answer?.confidence);
        if (!answer || !Number.isFinite(confidence) || confidence < runtime.settings.minAnswerConfidence || confidence > 1) return false;
        if (question.options.length) return Boolean(applyAnswer(question, answer, true).planned);
        const values = answer.answerTexts?.length ? answer.answerTexts : answer.answers || [];
        return question.textInputs.length > 0 && values.length === question.textInputs.length && values.every(value => String(value).trim());
    }

    async function resolveAnswer(question, course, paperTitle, deadline) {
        runtime.lastAiError = '';
        const recorded = lookUpRecordedAnswer(course || question.course, paperTitle || currentPaperTitle(), question);
        if (recorded?.verifiedBy === 'platform-record' && answerUsable(question, recorded)) {
            return { ...recorded, source: '平台已验证答案' };
        }
        if (runtime.settings.useAiFallback) {
            const ai = await askAssistantService(question, deadline);
            if (answerUsable(question, ai)) return ai;
            if (runtime.lastAiError) return null;
        }
        for (const fallback of [recorded,
            solveArithmeticQuestion(question), matchAnswerBank(question, true)]) {
            if (answerUsable(question, fallback)) return fallback;
        }
        return null;
    }

    // ---------- 卷子与阶段识别 ----------

    const PAPER_CONTAINER = '[data-paper-id], [data-exam-id], .exam-paper, .paper-item, .exam-item, .paper, [class*="paper-item" i], [class*="exam-item" i]';

    function findPapers() {
        const list = recordListContext();
        if (list) return list.entries.map(entry => ({ container: entry.row, title: list.title, attemptToken: entry.attemptToken,
            key: answerStoreKey(list.title, list.title), startButton: null, continueButton: entry.restart, recordButton: entry.review }));
        // 以「开始考试 / 继续考试 / 考试记录」按钮为锚点，向上定位其所属卷子容器。
        const map = new Map();
        for (const doc of sameOriginDocuments()) {
            const controls = collectControls(doc);
            for (const control of controls) {
                const text = controlText(control);
                const kind = /开始考试|开始答题|进入考试|开始测验|开始测试|开始作答/.test(text) ? 'startButton'
                    : /继续考试|继续答题|继续作答|再次考试|重新考试/.test(text) ? 'continueButton'
                        : /考试记录|成绩查询|答题记录|考试历史|查看记录|考试成绩|查看成绩|查看答案|查看解析|查看详情/.test(text) ? 'recordButton'
                            : null;
                if (!kind) continue;
                const clickable = control.closest('button, a, [role="button"], input[type="button"], input[type="submit"]') || control;
                const container = control.closest(PAPER_CONTAINER) || control.closest('li') || control.parentElement;
                if (!container) continue;
                if (!map.has(container)) {
                    const titleEl = container.querySelector('.paper-title, .exam-title, [class*="title" i], h1, h2, h3, h4');
                    const title = String(titleEl?.innerText || container.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80);
                    map.set(container, { container, title, startButton: null, continueButton: null, recordButton: null });
                }
                const paper = map.get(container);
                if (!paper[kind]) paper[kind] = clickable;
            }
        }
        const papers = [...map.values()].filter((paper) => paper.title);
        papers.forEach((paper) => { paper.key = answerStoreKey(extractCourseName(), paper.title); });
        return papers;
    }

    function detectPhase(questions = findQuestionNodes().map(parseQuestion)) {
        const hasQuestions = questions.length > 0;
        if (!hasQuestions && finishedRecordControl()) return 'FINISHED';
        if (questions.some(q => !q.stem || (!q.options.length && !q.textInputs.length))) return 'UNKNOWN';
        const ui = questions.filter(q => q.adapter === 'ui-question');
        if (ui.length) {
            if (ui.length !== questions.length || ui.some(q => !q.mappingValid || q.conflictingControls)) return 'UNKNOWN';
            if (ui.some(q => q.liveContext && q.hasRecordMarker)) return 'UNKNOWN';
            if (ui.every(q => !q.readOnly)) return 'PAPER';
            if (ui.every(q => q.readOnly && q.resultRecord)) return 'RECORD';
            if (ui.every(q => q.recordEvidence && extractCorrectAnswer(q))) return 'RECORD';
            if (ui.some(q => q.recordEvidence || q.container.querySelector('.ui-question-hint, .ui-correct-answer'))) return 'UNKNOWN';
            return 'PREVIEW'; // 已识别题目，交互协议未验收，禁止自动填写及提交。
        }
        const correctAnswerShown = hasQuestions && questions.every(q => Boolean(extractCorrectAnswer(q)));
        if (hasQuestions && !correctAnswerShown && questions.some(q => Boolean(extractCorrectAnswer(q)))) return 'UNKNOWN';
        const hasEntryButton = Boolean(findStartExamButton() || findContinueExamButton() || findRecordButton());
        if (hasQuestions && correctAnswerShown) return 'RECORD';   // 有题目且显示正确答案 = 考试记录页
        if (hasQuestions) return 'PAPER';                          // 有题目 = 答题页（首轮或继续考试）
        if (hasEntryButton) return 'LIST';                         // 无题目但有考试入口 = 考试列表页
        return 'UNKNOWN';
    }

    function questionsShowCorrectAnswer() {
        return findQuestionNodes().some(node => [...node.querySelectorAll('.correct-answer, .right-answer, [class*="correct-answer" i], [class*="right-answer" i]')].some(isVisible)
            || Boolean(extractCorrectAnswer(parseQuestion(node))));
    }

    function paperHasRecordedAnswers(course, paperTitle) {
        const data = loadAnswers();
        const bucket = data[answerStoreKey(course, paperTitle)] || {};
        return Object.keys(bucket).length > 0;
    }

    // ---------- 流程动作 ----------

    function refreshQuestions() {
        runtime.questions = findQuestionNodes().map(parseQuestion).filter((question) => question.stem);
        return runtime.questions;
    }

    function currentPaperTitle() {
        const preferred = findQuestionNodes()[0]?.ownerDocument || root.document;
        for (const doc of uniqueElements([preferred, ...sameOriginDocuments()])) {
            for (const selector of ['.paper-title', '.exam-title', '.test-title', '.ui-paper-title', '[class*="paper-title" i]']) {
                const elements = [...doc.querySelectorAll(selector)].filter(item => isVisible(item) && !isInsidePanel(item));
                if (elements.length === 1 && elements[0].innerText.trim()) return elements[0].innerText.trim().slice(0, 80);
            }
        }
        if (!findQuestionNodes().length && runtime.currentPaper?.container?.isConnected) return runtime.currentPaper.title;
        const examContext = /exam|paper|kaoshi/i.test(root.location?.href || '') || /考试|试卷/.test(preferred.title || '');
        return examContext ? runtime.flow?.paper || '' : '';
    }

    function pageWindowFor(doc) {
        if (typeof unsafeWindow === 'undefined') return doc.defaultView;
        const seen = new Set();
        function visit(view) {
            try {
                if (seen.has(view)) return null;
                seen.add(view);
                if (view.document === doc) return view;
                for (const frame of view.document.querySelectorAll('iframe, frame')) {
                    const found = visit(frame.contentWindow);
                    if (found) return found;
                }
            } catch (_) {}
            return null;
        }
        return visit(unsafeWindow) || doc.defaultView;
    }

    function observeNativeSave(view, context, qid, psqId, replies) {
        const proto = view?.XMLHttpRequest?.prototype;
        if (!proto || typeof proto.open !== 'function' || typeof proto.send !== 'function') return () => {};
        const originalOpen = proto.open, originalSend = proto.send;
        const requests = new WeakMap(), listeners = new Map();
        function open(...args) {
            const result = Reflect.apply(originalOpen, this, args);
            requests.set(this, { method: String(args[0]), url: String(args[1]) });
            return result;
        }
        function send(...args) {
            try {
                const request = requests.get(this);
                const url = request && new URL(request.url, context.doc.location.href);
                const body = typeof args[0] === 'string' || args[0] instanceof view.URLSearchParams
                    ? new URLSearchParams(String(args[0])) : null;
                if (request && /^post$/i.test(request.method) && url.origin === context.doc.location.origin
                    && /\/myanswer\/newSave\/[^/]+\/\d+$/.test(url.pathname) && url.pathname.endsWith(`/${qid}`)
                    && body?.get('psqId') === psqId) {
                    const xhr = this, answer = [...String(body.get('answer') || '').toLowerCase()].sort().join('');
                    const finish = () => {
                        let data;
                        try { data = xhr.responseType === 'json' ? xhr.response : JSON.parse(xhr.responseText); } catch (_) {}
                        replies.push({ answer, ok: xhr.status >= 200 && xhr.status < 300 && data?.success === true });
                        listeners.delete(xhr); xhr.removeEventListener('loadend', finish);
                    };
                    listeners.set(xhr, finish); xhr.addEventListener('loadend', finish);
                }
            } catch (_) { /* 不采信无法对应当前题的请求。 */ }
            return Reflect.apply(originalSend, this, args);
        }
        proto.open = open; proto.send = send;
        return () => {
            if (proto.open === open) proto.open = originalOpen;
            if (proto.send === send) proto.send = originalSend;
            for (const [xhr, finish] of listeners) xhr.removeEventListener('loadend', finish);
            listeners.clear();
        };
    }

    async function performQuestionAction(question, action, operation) {
        if (question.adapter !== 'ui-question' || question.readOnly) return action();
        const context = card2Context();
        if (!context || context.current !== question.container || !operationCurrent(operation)) return { applied: false, reason: '操作已取消或题目已变化' };
        // SaveItem 的 $.post 在父页面执行；观察其正常 ajax 事件，不自行发送/重放保存请求。
        const jq = pageWindowFor(context.doc)?.jQuery;
        if (typeof jq !== 'function' || typeof jq(context.doc)?.on !== 'function') return { applied: false, reason: '无法观察平台保存结果，未填写；请刷新页面后重试' };
        if (jq.active > 0) return { applied: false, reason: '平台仍在处理请求，请稍后重新启动' };
        const namespace = `.fzugkCard2Save${Date.now()}${Math.random().toString(36).slice(2)}`;
        const started = new Map(), replies = [];
        const qid = question.container.id.slice(2), psqId = question.container.getAttribute('code').slice(4);
        // 重复加载 jQuery 会隔离旧 SaveItem 闭包的 ajax 事件；同时观察其正常原生请求响应。
        const restoreNative = observeNativeSave(pageWindowFor(context.doc), context, qid, psqId, replies);
        const normalizeCodes = text => [...String(text).toLowerCase()].sort().join('');
        const listener = (event, xhr, settings, data) => {
            try {
                if (event.type === 'ajaxSend') {
                    const url = new URL(settings.url, context.doc.location.href);
                    const body = typeof settings.data === 'string' ? new URLSearchParams(settings.data) : new URLSearchParams(settings.data || {});
                    if (url.origin === context.doc.location.origin && /\/myanswer\/newSave\/[^/]+\/\d+$/.test(url.pathname)
                        && url.pathname.endsWith(`/${qid}`) && body.get('psqId') === psqId && /^post$/i.test(settings.type || settings.method || '')) {
                        started.set(xhr, normalizeCodes(body.get('answer') || ''));
                    }
                } else if (started.has(xhr)) {
                    replies.push({ answer: started.get(xhr), ok: event.type === 'ajaxSuccess' && data?.success === true });
                    started.delete(xhr);
                }
            } catch (_) { /* 不将无关请求或不完整响应当作保存成功。 */ }
        };
        let cancelled = false;
        const cancel = () => { cancelled = true; };
        runtime.requests.add(cancel);
        try {
            jq(context.doc).on(`ajaxSend${namespace} ajaxSuccess${namespace} ajaxError${namespace}`, listener);
            const plan = action(true);
            if (!plan.planned) return plan;
            for (const option of plan.clicks) {
                if (operation.deadline && Date.now() >= operation.deadline) return { applied: false, reason: '单题作答超过总时限' };
                if (cancelled || !operationCurrent(operation) || !question.container.isConnected || !isVisible(question.container) || isOptionLocked(option)) return { applied: false, reason: '操作已取消或选项已锁定' };
                replies.length = 0;
                const savedBeforeClick = context.card.classList.contains('selected');
                option.clickTarget.click();
                const expected = normalizeCodes(question.options.filter(isOptionSelected).map(o => o.platformCode).join(''));
                runtime.state = 'WAITING_SAVE';
                updatePanel();
                const deadline = Math.min(Date.now() + 12000, operation.deadline || Infinity);
                let saved = false;
                while (Date.now() < deadline) {
                    if (cancelled || !question.container.isConnected || !isVisible(question.container) || !operationCurrent(operation)) return { applied: false, reason: '保存等待已取消，未继续下一题' };
                    const reply = replies.find(item => item.answer === expected);
                    if (reply) {
                        if (!reply.ok) return { applied: false, reason: '平台保存失败，已停止推进' };
                        saved = true;
                        break;
                    }
                    // 平台重复加载 jQuery 时，SaveItem 闭包与当前全局实例的 ajax 事件不相通。
                    // 仅接受本次点击后、该题答题卡由未保存变为已保存的确认；原有 selected 不算新确认。
                    if (!savedBeforeClick && context.card.classList.contains('selected')
                        && expected === normalizeCodes(question.options.filter(isOptionSelected).map(o => o.platformCode).join(''))) {
                        saved = true;
                        break;
                    }
                    await sleep(80);
                }
                if (!saved) return { applied: false, reason: '未确认平台保存成功，已停止推进；请检查平台提示' };
            }
            const verified = question.options.every(option => isOptionSelected(option) === plan.selected.includes(option.key));
            return verified && context.card.classList.contains('selected')
                ? { applied: true, saved: true, selected: plan.selected }
                : { applied: false, reason: '选项或答题卡保存状态未通过校验，已停止推进' };
        } finally {
            restoreNative();
            jq(context.doc).off(namespace);
            runtime.requests.delete(cancel);
        }
    }

    async function randomPass(operation = captureOperation()) {
        runtime.state = 'RANDOM_FILL';
        const questions = refreshQuestions();
        let filled = 0;
        for (const question of questions) {
            if (!operationCurrent(operation)) return { ok: false, cancelled: true };
            const result = await performQuestionAction(question, planOnly => randomFill(question, planOnly), operation);
            if (result.applied) filled++;
            else if (question.adapter === 'ui-question') { log(`题目未完成：${result.reason}`, 'warn'); break; }
        }
        if (operationCurrent(operation)) runtime.state = questions.length > 0 && filled === questions.length ? 'ANSWERED' : 'ACTION_REQUIRED';
        log(`手动随机作答完成：${filled}/${questions.length} 道题已随机勾选`);
        return { ok: questions.length > 0 && filled === questions.length, filled, total: questions.length };
    }

    async function fillCorrectAnswers(operation = captureOperation()) {
        runtime.state = 'FILL_CORRECT';
        const questions = refreshQuestions();
        const course = questions[0]?.course || extractCourseName();
        const paperTitle = currentPaperTitle();
        let filled = 0;
        let missed = 0;
        for (const question of questions) {
            if (!operationCurrent(operation)) break;
            if (question.readOnly) { missed++; continue; }
            let questionOperation = { ...operation, deadline: Date.now() + EXAM_ANSWER_TIMEOUT_MS };
            const firstPass = runtime.settings.fullAuto && operation.automatic && (!runtime.flow?.mode || runtime.flow.mode === 'first');
            const reviewPass = operation.automatic && runtime.flow?.mode === 'review';
            const enumPass = operation.automatic && runtime.flow?.mode === 'enum';
            const strictRedo = runtime.settings.fullAuto && operation.automatic && runtime.flow?.mode === 'redo';
            const existingSelection = question.options.filter(isOptionSelected);
            const existingCard = firstPass && question.adapter === 'ui-question' ? card2Context() : null;
            if (existingCard?.current === question.container && existingCard.card.classList.contains('selected') && existingSelection.length
                && (question.type === '多选题' || existingSelection.length === 1)) { filled++; continue; }
            const tentativeKey = `${answerStoreKey(course, paperTitle)}::${question.fingerprint}`;
            const savedTentative = runtime.tentative[tentativeKey];
            const session = enumPass ? enumerationState() : null;
            const recorded = enumPass ? lookUpRecordedAnswer(course, paperTitle, question) : null;
            const candidate = session?.activeOwner === runtime.tabId && session.stage === 'ANSWERING' ? session.plan[question.fingerprint] : null;
            let answer = enumPass ? recorded?.verifiedBy === 'platform-record' ? recorded
                : candidate ? { answers: [], answerTexts: candidate, confidence: 1, source: '枚举试答，待平台判定', candidateTrial: true } : null
                : strictRedo ? lookUpRecordedAnswer(course, paperTitle, question)
                : firstPass && savedTentative ? savedTentative
                    : await resolveAnswer(question, course, paperTitle, questionOperation.deadline);
            if (!operationCurrent(operation) || !question.container.isConnected) break;
            const confidence = Number(answer?.confidence);
            const verified = answer && (!strictRedo || answer.verifiedBy === 'platform-record')
                && Number.isFinite(confidence) && confidence >= runtime.settings.minAnswerConfidence && confidence <= 1;
            let tentative = Boolean(firstPass && savedTentative);
            if (!verified && !tentative && (firstPass || reviewPass) && ['单选题', '多选题', '判断题'].includes(question.type)
                && question.options.length && !question.options.some(isOptionLocked)) {
                const selected = question.options.filter(isOptionSelected);
                // 首轮暂选按内容记录。已有选择优先，兜底只生成一次，不写正确答案库。
                const candidates = selected.length && (question.type === '多选题' || selected.length === 1) ? selected
                    : [question.options[Math.floor(Math.random() * question.options.length)]];
                answer = { answerTexts: candidates.map(option => option.text), answers: [], confidence: 0, source: '首轮暂选，待平台核对' };
                runtime.tentative[tentativeKey] = answer;
                try { root.sessionStorage.setItem(TENTATIVE_KEY, JSON.stringify(runtime.tentative)); } catch (_) {}
                tentative = true;
                log(`${reviewPass ? '本题仍未核对，保留或暂选后继续' : '首轮暂选并继续，尚未核对'}：${question.stem.slice(0, 40)}`, 'warn');
            }
            if (!verified && !tentative) {
                missed++;
                log(`答案缺失或置信度不足：${question.stem.slice(0, 40)}`, 'warn');
                break;
            }
            // AI 已用尽预算时，暂选使用独立且有限的保存预算；不会反复请求 AI。
            if (tentative) questionOperation = { ...operation, deadline: Date.now() + 12000 };
            if (Date.now() >= questionOperation.deadline) { runtime.lastAiError = '单题作答超过总时限'; missed++; break; }
            const result = await performQuestionAction(question, planOnly => applyAnswer(question, answer, planOnly), questionOperation);
            if (enumPass && answer?.candidateTrial && result.applied) log(`已保存枚举候选（待平台判定）：${question.stem.slice(0, 32)} → ${answer.answerTexts.join(' / ')}`);
            if (result.applied) filled++;
            else { missed++; log(`题目填写失败：${result.reason}`, 'warn'); break; }
        }
        const cancelled = !operationCurrent(operation);
        if (!cancelled) {
            if (questions.length > 0 && filled === questions.length) runtime.state = 'ANSWERED';
            else pauseForBrowserTakeover(runtime.lastAiError || '当前题目未完成或平台保存未确认');
        }
        log(cancelled ? '正确答案填写完成：操作已取消，未继续填写或提交' : `${runtime.flow?.mode === 'enum' ? '枚举核对填写' : '正确答案填写'}完成：${filled}/${questions.length} 道${missed ? `，${missed} 道待处理` : ''}`);
        return { ok: !cancelled && questions.length > 0 && filled === questions.length, filled, total: questions.length, missed, cancelled };
    }

    async function readRecordedAnswers() {
        runtime.state = 'READ_ANSWERS';
        const questions = refreshQuestions();
        const course = questions[0]?.course || extractCourseName();
        const paperTitle = currentPaperTitle();
        if (!questions.length || !paperTitle || detectPhase() !== 'RECORD') {
            runtime.state = 'ACTION_REQUIRED';
            log('需要可识别卷子标题的考试记录页才能读取正确答案', 'warn');
            return { ok: false, count: 0 };
        }
        const captured = questions.filter(question => extractCorrectAnswer(question));
        const enumSession = enumerationState();
        const feedback = capturePlatformFeedback(questions, false);
        if (enumSession?.activeOwner === runtime.tabId && enumSession.stage === 'OPEN_RECORD'
            && (!feedback || feedback.total !== enumSession.total || feedback.attemptToken !== enumSession.attemptToken
                || JSON.stringify(Object.keys(feedback.questions).sort()) !== JSON.stringify(enumSession.fingerprints)
                || enumSession.locked.some(fp => feedback.questions[fp]?.status !== 'right')
                || Object.entries(enumSession.plan).some(([fp, set]) => JSON.stringify(feedback.questions[fp]?.selected) !== JSON.stringify([...set].sort())))) {
            pauseForBrowserTakeover('枚举反馈与实际候选不一致或已验证题判错，不更新答案库');
            return { ok: false, done: true };
        }
        recordAnswers(course, paperTitle, questions);
        if (feedback) capturePlatformFeedback(questions);
        if (finishEnumerationRecord(questions, feedback)) return { ok: true, done: true };
        const total = knownQuestionTotal();
        const previous = runtime.flow?.course === course && runtime.flow?.paper === paperTitle ? runtime.flow.recordFingerprints || [] : [];
        const fingerprints = [...new Set([...previous, ...captured.map(question => question.fingerprint)])];
        const complete = total > 0 && fingerprints.length === total && !findNextButton();
        if (runtime.settings.fullAuto && runtime.flow?.stage === 'submitted' && ['redo', 'review'].includes(runtime.flow?.mode)) {
            finishAutomaticRun(complete ? 'DONE' : 'ACTION_REQUIRED', complete
                ? '重做后的平台记录已完整读取；本轮结束，不再重复重考。' : '重做已提交，但平台记录未完整；本轮停止，不再重复重考。');
            return { ok: captured.length === questions.length, complete, done: true, count: captured.length, total: questions.length };
        }
        if (runtime.settings.fullAuto) {
            rememberFlow('reading');
            runtime.flow.recordFingerprints = fingerprints;
            runtime.flow.recordTotal = total;
            gmSet(FLOW_KEY, runtime.flow);
        }
        if (complete) rememberFlow('recorded', 'redo');
        runtime.state = captured.length === questions.length ? 'ANSWERS_READ' : 'ACTION_REQUIRED';
        log(`已从考试记录读取 ${captured.length}/${questions.length} 道题的正确答案并保存${captured.length < questions.length ? `；${questions.length - captured.length} 道未公开正确答案，禁止按已核对答案自动重做` : ''}`);
        return { ok: captured.length === questions.length, complete, count: captured.length, total: questions.length };
    }

    async function clickAction(action, suppliedButton = null, automatic = false) {
        runtime.lastActionAt = Date.now();
        const phase = detectPhase();
        if (identityBlocked()) { log('请本人先完成身份验证', 'warn'); return { ok: false }; }
        if (action === 'read') return readRecordedAnswers();
        if (action === 'random' || action === 'fill') {
            if (runtime.pendingAction?.view === viewSignature()) { log('请先等待平台响应，再修改答案', 'warn'); return { ok: false }; }
            if (phase !== 'PAPER') { log('当前页不是可填写的试卷页', 'warn'); return { ok: false }; }
            runtime.processedView = '';
            return action === 'random' ? randomPass() : fillCorrectAnswers();
        }
        const view = viewSignature();
        if (runtime.pendingAction?.view === view) { log('上一次动作仍在等待平台响应，请检查页面', 'warn'); return { ok: false }; }
        const finders = { start: findStartExamButton, continue: findContinueExamButton, submit: findSubmitPaperButton, return: findReturnButton, next: findNextButton, record: findRecordButton };
        const labels = { start: '开始考试', continue: '继续考试', submit: '交卷', return: '返回', next: '下一题', record: '考试记录' };
        if (!finders[action]) return { ok: false };
        let button = suppliedButton;
        if (!button && phase === 'LIST' && ['start', 'continue', 'record'].includes(action)) {
            const papers = findPapers();
            const choice = runtime.panel?.querySelector('[data-role="paper-choice"]')?.value;
            const candidates = choice ? papers.filter(paper => paper.key === choice) : runtime.flow ? papers.filter(paper => normalizeText(paper.title) === normalizeText(runtime.flow.paper)) : papers;
            if (candidates.length !== 1) { log('请先在卷子选择框中选择唯一目标卷子', 'warn'); return { ok: false }; }
            runtime.currentPaper = candidates[0];
            button = candidates[0][{ start: 'startButton', continue: 'continueButton', record: 'recordButton' }[action]];
        } else if (!button) button = finders[action]();
        if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') { log(`未找到可用的「${labels[action]}」按钮`, 'warn'); return { ok: false }; }
        if (action === 'submit') {
            const questions = refreshQuestions();
            const answered = questions.length > 0 && questions.length === findQuestionNodes().length && questions.every(question => question.options.length
                ? question.options.filter(isOptionSelected).length >= 1 && (question.type === '多选题' || question.options.filter(isOptionSelected).length === 1)
                : question.textInputs.length > 0 && question.textInputs.every(input => input.value.trim()));
            const key = answerStoreKey(questions[0]?.course || extractCourseName(), currentPaperTitle());
            const completed = new Set(runtime.progress.get(key) || []);
            questions.forEach(question => completed.add(question.fingerprint));
            const card = card2Context();
            const incomplete = card ? !card.cards.every(item => item.classList.contains('selected')) : knownQuestionTotal() > completed.size;
            if (phase !== 'PAPER' || !answered || findNextButton() || incomplete || (automatic && !knownQuestionTotal())) {
                log('交卷已阻止：存在未填写题目、未访问分页或未确认的试卷状态', 'warn');
                return { ok: false };
            }
            const mode = runtime.settings.fullAuto ? runtime.flow?.mode || 'first'
                : paperHasRecordedAnswers(questions[0].course, currentPaperTitle()) ? 'redo' : 'first';
            rememberFlow(automatic ? 'submitting' : 'submitted', mode);
            runtime.submittedAt = Date.now();
        }
        if (action === 'continue') {
            if (!paperHasRecordedAnswers(extractCourseName(), currentPaperTitle())) { log('请先读取目标卷子的考试记录答案', 'warn'); return { ok: false }; }
            const bucket = loadAnswers()[answerStoreKey(extractCourseName(), currentPaperTitle())] || {};
            if (knownQuestionTotal() > Object.values(bucket).filter(entry => entry.schema === 2).length) { log('考试记录分页尚未读取完整', 'warn'); return { ok: false }; }
            if (automatic && (!runtime.flow?.recordTotal || runtime.flow.recordFingerprints?.length !== runtime.flow.recordTotal
                || (runtime.flow.redoCount || 0) >= 1)) { log('自动重做已阻止：记录未完整或已达到一轮重做上限', 'warn'); return { ok: false }; }
            runtime.progress.clear();
            saveProgress();
            rememberFlow('answering', 'redo');
            if (automatic) { runtime.flow.redoCount = (runtime.flow.redoCount || 0) + 1; gmSet(FLOW_KEY, runtime.flow); }
        }
        if (action === 'start') {
            if (phase !== 'LIST') { log('请在考试列表选择目标卷子', 'warn'); return { ok: false }; }
            runtime.flow = null;
            runtime.progress.clear();
            saveProgress();
            rememberFlow('answering', 'first');
        }
        if (action === 'record') rememberFlow('reading');
        // 在 click 前记录锁，覆盖同步事件、确认弹窗、慢请求与失败页面。
        runtime.pendingAction = { view, kind: action, at: Date.now(), automatic,
            course: runtime.flow?.course, paper: runtime.flow?.paper, mode: runtime.flow?.mode,
            origin: root.location.origin, attemptToken: card2AttemptToken('paper') };
        if (action === 'submit' && runtime.flow) {
            runtime.flow.attemptToken = runtime.pendingAction.attemptToken;
            runtime.flow.expectedTotal = knownQuestionTotal();
            gmSet(FLOW_KEY, runtime.flow);
        }
        try { root.sessionStorage.setItem(PENDING_KEY, JSON.stringify(runtime.pendingAction)); } catch (_) {}
        runtime.state = 'WAITING';
        button.click();
        log(`已点击「${labels[action]}」，等待平台响应`);
        return { ok: true };
    }

    // ---------- 自动推进 ----------

    function finishAutomaticRun(state, message) {
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.timer = null;
        runtime.answerGeneration++;
        for (const cancel of [...runtime.requests]) cancel();
        saveSettings({ enabled: false });
        runtime.state = state;
        log(message);
    }

    function synchronizeAutomaticTarget(phase) {
        if (!runtime.settings.fullAuto || phase !== 'PAPER') return true;
        const course = refreshQuestions()[0]?.course || extractCourseName();
        const paper = currentPaperTitle();
        const liveTitles = sameOriginDocuments().flatMap(doc => [...doc.querySelectorAll('.paper-title, .exam-title, .test-title, .ui-paper-title')])
            .filter(node => isVisible(node) && !isInsidePanel(node)).map(node => node.innerText.trim()).filter(Boolean);
        if (!paper || !course || course === '未识别课程' || !liveTitles.includes(paper)) {
            runtime.state = 'SCANNING';
            return false;
        }
        if (runtime.flow && normalizeText(runtime.flow.course) === normalizeText(course) && normalizeText(runtime.flow.paper) === normalizeText(paper)) return true;
        const signature = answerStoreKey(course, paper);
        if (runtime.flow) {
            if (runtime.targetCandidate?.signature !== signature) { runtime.targetCandidate = { signature, at: Date.now() }; runtime.state = 'SCANNING'; return false; }
            if (Date.now() - runtime.targetCandidate.at < 750) return false;
        }
        runtime.answerGeneration++;
        for (const cancel of [...runtime.requests]) cancel();
        runtime.flow = null;
        runtime.currentPaper = null;
        runtime.processedView = '';
        runtime.targetCandidate = null;
        rememberFlow('answering', 'first');
        log(`已绑定当前科目与试卷：${course} / ${paper}`);
        return true;
    }

    function automaticSubmissionConfirmed(phase, pending) {
        if (phase === 'FINISHED') return Boolean(pending.attemptToken && pending.origin === root.location.origin
            && pending.attemptToken === card2AttemptToken('finished') && finishedRecordControl());
        if (!['LIST', 'RECORD'].includes(phase)) return false;
        if (normalizeText(findQuestionNodes().map(parseQuestion)[0]?.course || extractCourseName()) !== normalizeText(pending.course)) return false;
        if (phase === 'RECORD') return normalizeText(currentPaperTitle()) === normalizeText(pending.paper);
        // 列表出现同卷的记录入口，才认为页面已离开本次作答；普通 URL/题目变化不解除提交锁。
        return findPapers().some(paper => normalizeText(paper.title) === normalizeText(pending.paper) && paper.recordButton);
    }

    function submissionConfirmationControl() {
        const dialogs = uniqueElements(sameOriginDocuments().flatMap(doc => [...doc.querySelectorAll('[role="dialog"], .ivu-modal-wrap, .layui-layer, .modal, .ui-dialog, .ui-popup-tip')]))
            .filter(node => isVisible(node) && !isInsidePanel(node) && /交卷|提交试卷|提交答卷/.test(node.innerText || ''));
        const choices = uniqueElements(dialogs.flatMap(dialog => {
            if (/未作答|未答题|保存失败|提交失败|错误|异常|诚信|协议|人脸|身份验证/.test(dialog.innerText || '')) return [];
            return collectControls(dialog).filter(button => /^(确认交卷|确认提交|确定|确认|提交试卷)$/.test(controlText(button))
                && !button.disabled && button.getAttribute('aria-disabled') !== 'true');
        }));
        return choices.length === 1 ? choices[0] : null;
    }

    function confirmAutomaticSubmission(pending) {
        if (pending.confirmed || identityBlocked()) return;
        const button = submissionConfirmationControl();
        if (!button) return;
        if (!runtime.settings.enabled || !runtime.settings.fullAuto || gmGet(RUN_KEY, {})?.owner !== runtime.tabId) return;
        pending.confirmed = true;
        try { root.sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending)); } catch (_) {}
        button.click();
        log('已确认本次交卷，等待平台结果。');
    }

    async function completePaper() {
        if (!runtime.settings.fullAuto) {
            finishAutomaticRun('READY_TO_SUBMIT', '当前卷已完成填写。请本人检查后交卷。');
            return;
        }
        const result = await clickAction('submit', null, true);
        if (!result.ok) pauseForBrowserTakeover('整卷交卷条件未满足');
    }

    async function autoStep() {
        const phase = detectPhase();
        runtime.phase = phase;
        if (phase === 'PREVIEW') { runtime.state = 'ACTION_REQUIRED'; return; }
        if (identityBlocked()) {
            if (runtime.settings.fullAuto && runtime.pendingAction?.kind === 'submit' && Date.now() - runtime.pendingAction.at > 30000)
                pauseForBrowserTakeover('交卷确认或页面遮罩未恢复，请检查平台状态');
            else runtime.state = 'IDENTITY_REQUIRED';
            return;
        }
        const view = viewSignature();
        if (runtime.pendingAction) {
            const pending = runtime.pendingAction;
            if (pending.kind === 'submit' && pending.automatic) {
                if (!automaticSubmissionConfirmed(phase, pending)) {
                    if (Date.now() - pending.at > 30000) runtime.state = 'ACTION_REQUIRED';
                    else { confirmAutomaticSubmission(pending); runtime.state = 'WAITING'; }
                    return;
                }
                if (phase === 'FINISHED') {
                    if (!runtime.flow || runtime.flow.course !== pending.course || runtime.flow.paper !== pending.paper) {
                        pauseForBrowserTakeover('提交结果与当前流程目标不一致'); return;
                    }
                    runtime.flow.stage = 'submitted'; runtime.flow.mode = pending.mode; runtime.flow.at = Date.now();
                    gmSet(FLOW_KEY, runtime.flow);
                } else rememberFlow('submitted', pending.mode);
            }
            else if (runtime.pendingAction.view === view) {
                runtime.state = Date.now() - runtime.pendingAction.at > 30000 ? 'ACTION_REQUIRED' : 'WAITING';
                return;
            }
            runtime.pendingAction = null;
            try { root.sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
            runtime.processedView = '';
        }
        if (!synchronizeAutomaticTarget(phase)) return;
        if (phase === 'FINISHED') {
            if (!runtime.settings.fullAuto || runtime.flow?.attemptToken !== card2AttemptToken('finished')
                || runtime.flow?.stage !== 'submitted') { runtime.state = 'ACTION_REQUIRED'; return; }
            if (['redo', 'review'].includes(runtime.flow.mode)) {
                finishAutomaticRun('DONE', '平台确认本轮订正试卷已提交；本轮结束，不再重复重考。'); return;
            }
            const enumeration = enumerationState();
            if (runtime.flow.mode === 'enum') {
                if (enumeration?.activeOwner === runtime.tabId && enumeration.stage === 'OPEN_RECORD') {
                    if (Date.now() - enumeration.navigationAt > 30000) pauseForBrowserTakeover('枚举答卷窗口未及时接续，请检查弹窗拦截');
                    else runtime.state = 'WAITING';
                    return;
                }
                if (!enumeration || enumeration.activeOwner !== runtime.tabId || enumeration.stage !== 'ANSWERING') {
                    pauseForBrowserTakeover('枚举运行权或提交阶段不一致'); return;
                }
                enumeration.stage = 'OPEN_RECORD'; enumeration.navigationAt = Date.now(); gmSet(ENUM_KEY, enumeration);
                finishedRecordControl().click(); runtime.state = 'WAITING';
                log('枚举试卷已提交，已打开本轮答卷等待平台逐题反馈。'); return;
            }
            const awaiting = gmGet(RECORD_HANDOFF_KEY, null);
            if (awaiting?.source === runtime.tabId) {
                if (awaiting.expires <= Date.now()) pauseForBrowserTakeover('答卷窗口未在30秒内接续，请检查弹窗是否被浏览器阻止');
                else runtime.state = 'WAITING';
                return;
            }
            const button = finishedRecordControl();
            if (!button) { runtime.state = 'ACTION_REQUIRED'; return; }
            gmSet(RECORD_HANDOFF_KEY, { source: runtime.tabId, origin: root.location.origin,
                course: runtime.flow.course, paper: runtime.flow.paper, attemptToken: runtime.flow.attemptToken,
                at: Date.now(), expires: Date.now() + 30000 });
            button.click();
            runtime.state = 'WAITING';
            log('已打开本次答卷，等待同一科目、试卷与作答批次的页面接续。');
            return;
        }
        const operation = captureOperation(true);
        if (phase === 'PAPER') {
            if (runtime.flow?.mode === 'enum' && !enumerationPaperMatches(enumerationState() || {})) {
                pauseForBrowserTakeover('枚举作答页目标或题目集合发生变化'); return;
            }
            const course = refreshQuestions()[0]?.course || extractCourseName();
            const paper = currentPaperTitle();
            if (!paper) { runtime.state = 'ACTION_REQUIRED'; return; }
            if (runtime.flow && normalizeText(runtime.flow.course) !== normalizeText(course)) { runtime.state = 'ACTION_REQUIRED'; log('当前课程与运行目标不同，请重新选择卷子', 'warn'); return; }
            const key = answerStoreKey(course, paper);
            if (runtime.processedView === view) return;
            const result = await fillCorrectAnswers(operation);
            if (!operationCurrent(operation)) return;
            runtime.processedView = view;
            if (!result.ok) { runtime.state = 'ACTION_REQUIRED'; return; }
            const progress = runtime.progress.get(key) || new Set();
            refreshQuestions().forEach(question => progress.add(question.fingerprint));
            runtime.progress.set(key, progress);
            saveProgress();
            if (runtime.settings.autoAdvance) {
                if (findNextButton()) await clickAction('next');
                else if (card2Context()) {
                    const card = card2Context();
                    if (card.cards.every(item => item.classList.contains('selected'))) await completePaper();
                    else { runtime.state = 'ACTION_REQUIRED'; log('已到最后一题，但答题卡仍有未完成项。', 'warn'); }
                }
                else if (!knownQuestionTotal()) {
                    runtime.state = 'ACTION_REQUIRED';
                    log('缺少可确认的总题数，请检查整卷后手动交卷', 'warn');
                }
                else if (knownQuestionTotal() > progress.size) {
                    runtime.state = 'ACTION_REQUIRED';
                    log('已识别总题数多于已完成题数，请手动检查答题分页', 'warn');
                } else {
                    await completePaper();
                }
            }
            return;
        }
        if (phase === 'RECORD') {
            if (runtime.processedView === view) return;
            const result = await readRecordedAnswers();
            if (result.done) return;
            if (!operationCurrent(operation)) return;
            runtime.processedView = view;
            if (!result.ok) { runtime.state = 'ACTION_REQUIRED'; return; }
            if (runtime.settings.autoAdvance) {
                if (findNextButton()) await clickAction('next');
                else if (!result.complete) { runtime.state = 'ACTION_REQUIRED'; log('当前页读取完成；缺少整卷完整性证据，请手动核验总题数与分页', 'warn'); }
                else if (findContinueExamButton()) {
                    const result = await clickAction('continue', null, runtime.settings.fullAuto);
                    if (!result.ok) runtime.state = 'ACTION_REQUIRED';
                } else {
                    const result = await clickAction('return');
                    if (!result.ok) runtime.state = 'ACTION_REQUIRED';
                }
            }
            return;
        }
        if (phase === 'LIST') {
            runtime.papers = findPapers();
            if (!runtime.settings.autoAdvance) return;
            const choice = runtime.panel?.querySelector('[data-role="paper-choice"]')?.value;
            const papers = choice ? runtime.papers.filter(paper => paper.key === choice) : runtime.flow ? runtime.papers.filter(paper => normalizeText(paper.title) === normalizeText(runtime.flow.paper)) : runtime.papers;
            if (papers.length !== 1) { runtime.state = 'SELECT_PAPER'; return; }
            const paper = papers[0];
            runtime.currentPaper = paper;
            // 先读取记录；重做结束后留在列表，避免无限重考。
            if (runtime.flow?.stage === 'submitted' && ['redo', 'review'].includes(runtime.flow?.mode)) {
                if (runtime.settings.fullAuto) finishAutomaticRun('DONE', '已完成首轮交卷、记录读取和一轮重做交卷；不再重复重考。');
                else runtime.state = 'DONE';
                return;
            }
            if (paper.recordButton && runtime.flow?.stage !== 'recorded') await clickAction('record', paper.recordButton);
            else if (paper.continueButton && paperHasRecordedAnswers(extractCourseName(), paper.title)) {
                const result = await clickAction('continue', paper.continueButton, runtime.settings.fullAuto);
                if (!result.ok) runtime.state = 'ACTION_REQUIRED';
            }
            else runtime.state = 'ACTION_REQUIRED';
        }
    }

    async function tick() {
        if (runtime.busy || !runtime.settings.enabled) return;
        if (gmGet(RUN_KEY, {})?.owner !== runtime.tabId) { stop(false); log('运行已转移到另一个标签页'); return; }
        runtime.busy = true;
        try {
            if (runtime.lastUrl !== root.location.href) {
                runtime.lastUrl = root.location.href;
                runtime.answerGeneration += 1;
                runtime.questions = [];
                runtime.state = 'SCANNING';
            }
            runtime.course = extractCourseName();
            runtime.papers = findPapers();
            await autoStep();
            if (runtime.state === 'ACTION_REQUIRED' && runtime.settings.enabled) pauseForBrowserTakeover('当前流程需要人工处理');
            updatePanel();
        } finally {
            runtime.busy = false;
        }
    }

    function start() {
        if (runtime.timer) root.clearInterval(runtime.timer);
        saveSettings({ enabled: true });
        gmSet(RUN_KEY, { owner: runtime.tabId, origin: root.location.origin, at: Date.now() });
        runtime.processedView = '';
        runtime.state = 'SCANNING';
        runtime.timer = root.setInterval(() => tick().catch((error) => {
            runtime.busy = false;
            pauseForBrowserTakeover(`主循环异常：${error.message}`, 'ERROR');
        }), runtime.settings.loopIntervalMs);
        tick().catch((error) => pauseForBrowserTakeover(`启动失败：${error.message}`, 'ERROR'));
        log(`考试刷分助手已启动（${VERSION}）。人脸识别请由本人完成。`);
    }

    function startReview() {
        if (runtime.busy || detectPhase() !== 'PAPER' || identityBlocked() || runtime.pendingAction) {
            log('请在已进入的作答页、没有待确认动作时启动核对订正。', 'warn'); return;
        }
        stop();
        const course = refreshQuestions()[0]?.course || extractCourseName(), paper = currentPaperTitle();
        const bucket = loadAnswers()[answerStoreKey(course, paper)] || {};
        const count = Object.values(bucket).filter(entry => entry.schema === 2 && entry.verifiedBy === 'platform-record').length;
        if (!paper || !count) { log('当前科目与试卷没有平台已验证答案，请先打开答卷页读取答案。', 'warn'); return; }
        runtime.progress.delete(answerStoreKey(course, paper)); saveProgress();
        rememberFlow('answering', 'review');
        saveSettings({ autoAdvance: true });
        runtime.panel.querySelector('[data-role="auto-advance"]').checked = true;
        log(`开始逐题核对与订正：本卷已保存 ${count} 道平台验证答案；其余题目仍需判断，不会跳过已有选择。`);
        start();
    }

    function pauseForBrowserTakeover(reason, state = 'ACTION_REQUIRED') {
        haltEnumeration(reason);
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.timer = null;
        runtime.answerGeneration++;
        for (const cancel of [...runtime.requests]) cancel();
        saveSettings({ enabled: false });
        runtime.state = state;
        log(`${reason}；自动运行已关闭，请由浏览器接管当前卷，最终由本人交卷。`, 'warn');
        updatePanel();
    }

    function stop(persist = true) {
        if (runtime.enumResumeTimer) root.clearTimeout(runtime.enumResumeTimer);
        runtime.enumResumeTimer = null;
        if (persist) haltEnumeration('用户停止');
        if (runtime.handoffTimer) root.clearTimeout(runtime.handoffTimer);
        runtime.handoffTimer = null;
        if (persist && gmGet(RECORD_HANDOFF_KEY, null)?.source === runtime.tabId) gmSet(RECORD_HANDOFF_KEY, null);
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.timer = null;
        runtime.answerGeneration++;
        for (const cancel of [...runtime.requests]) cancel();
        runtime.state = 'IDLE';
        if (persist) saveSettings({ enabled: false });
        else runtime.settings.enabled = false;
        log('考试刷分助手已停止');
        scheduleReadOnlyScan('停止后扫描');
    }

    // 诊断通道仅更新内存与助手面板，不调用动作、AI、答案保存或运行权写入。
    function readOnlyScan(reason = '手动重新扫描') {
        syncScanObservers();
        const docs = sameOriginDocuments();
        const candidates = uniqueElements(docs.flatMap(doc => QUESTION_SELECTORS.flatMap(selector => [...doc.querySelectorAll(selector)])))
            .filter(node => !isInsidePanel(node));
        const visible = candidates.filter(isVisible);
        const questions = findQuestionNodes().map(parseQuestion);
        const parsed = questions.filter(q => q.stem && (q.adapter === 'ui-question' ? q.mappingValid : q.options.length || q.textInputs.length));
        const phase = detectPhase(questions);
        const inaccessible = docs.flatMap(doc => [...doc.querySelectorAll('iframe, frame')]).filter(frame => {
            if (!isVisible(frame)) return false;
            try { return !frame.contentDocument; } catch (_) { return true; }
        }).length;
        let detail = parsed.length ? `当前可见结构 ${parsed.length} 题；不代表整卷完成` : visible.length ? '未支持的选项结构或题目尚未加载完整' : '等待题目加载';
        if (phase === 'PREVIEW') detail += '；仅预览，缺少已验证的作答路由、答题卡或选项编码';
        if (phase === 'FINISHED') detail = '平台已确认交卷；全自动流程将进入本次答卷核对';
        if (phase === 'RECORD') detail += `；可验证答案 ${questions.filter(q => extractCorrectAnswer(q)).length}/${questions.length}`;
        if (phase === 'PAPER' && questions.some(q => q.adapter === 'ui-question')) detail += runtime.settings.fullAuto
            ? '；逐题保存后自动推进，整卷完成后自动交卷' : '；可逐题作答，保存成功后推进，最后由本人交卷';
        if (phase === 'UNKNOWN' && parsed.length) detail += '；结构或记录标记冲突，停止操作';
        if (inaccessible) detail += `；${inaccessible} 个跨域或不可访问框架，由子页实例负责`;
        runtime.diagnostic = { at: new Date().toLocaleTimeString(), reason, candidates: candidates.length,
            visible: visible.length, parsed: parsed.length, documents: docs.length, inaccessible, detail, count: ++runtime.scanCount };
        updatePanel(questions);
        return { ...runtime.diagnostic, phase };
    }

    function scheduleReadOnlyScan(reason) {
        if (runtime.scanTimer || runtime.settings.enabled || runtime.busy) return;
        runtime.scanTimer = root.setTimeout(() => {
            runtime.scanTimer = null;
            if (!runtime.settings.enabled && !runtime.busy) readOnlyScan(reason);
        }, 200);
    }

    function syncScanObservers() {
        const docs = sameOriginDocuments();
        for (const [doc, observer] of runtime.observers) {
            if (!docs.includes(doc)) { observer.disconnect(); runtime.observers.delete(doc); }
        }
        const frames = docs.flatMap(doc => [...doc.querySelectorAll('iframe, frame')]);
        for (const [frame, listener] of runtime.frameListeners) {
            if (!frames.includes(frame)) { frame.removeEventListener('load', listener); runtime.frameListeners.delete(frame); }
        }
        for (const frame of frames) {
            if (runtime.frameListeners.has(frame)) continue;
            const listener = () => scheduleReadOnlyScan('框架加载');
            frame.addEventListener('load', listener);
            runtime.frameListeners.set(frame, listener);
        }
        for (const doc of docs) {
            if (runtime.observers.has(doc)) continue;
            const observer = new root.MutationObserver(changes => {
                if (changes.some(change => !isInsidePanel(change.target.nodeType === 1 ? change.target : change.target.parentElement))) {
                    scheduleReadOnlyScan('页面内容变化');
                }
            });
            observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true, attributes: true,
                attributeFilter: ['class', 'style', 'hidden', 'disabled', 'checked', 'aria-checked', 'aria-disabled', 'src'] });
            runtime.observers.set(doc, observer);
        }
    }


    function viewSignature() {
        const questions = findQuestionNodes().map(parseQuestion);
        return fnv1a(JSON.stringify([root.location?.href, currentPaperTitle(), questions.map(question => [question.fingerprint, question.adapter === 'ui-question' ? question.container.id : '', question.options.map(option => normalizeText(option.text)), /正确答案/.test(question.container.innerText || '')]), findPapers().map(paper => [paper.title, Boolean(paper.startButton), Boolean(paper.continueButton), Boolean(paper.recordButton)])]));
    }

    function captureOperation(automatic = false) {
        return { generation: runtime.answerGeneration, url: root.location?.href, view: viewSignature(), automatic };
    }

    function operationCurrent(operation) {
        return operation.generation === runtime.answerGeneration && operation.url === root.location?.href && operation.view === viewSignature()
            && (!operation.automatic || (runtime.settings.enabled && gmGet(RUN_KEY, {})?.owner === runtime.tabId)) && !identityBlocked();
    }

    function paperLoading() {
        return sameOriginDocuments().some(doc => [...doc.querySelectorAll('.ui-paper-loading')].some(isVisible));
    }

    function identityBlocked(waitForLoading = false) {
        const docs = sameOriginDocuments();
        if (docs.some(doc => [...doc.querySelectorAll('[role="dialog"], .ivu-modal-wrap, .face-verification, .ui-popup-tip, [data-identity-required="true"]')]
            .some(node => isVisible(node) && !isInsidePanel(node) && /人脸|身份验证|身份认证|刷脸|诚信|协议/.test(node.innerText || '')))) return true;
        // 重入衔接可等待加载；真实身份提示仍在上方优先拦截。加载时不执行任何答题动作。
        if (paperLoading()) return !waitForLoading;
        const overlays = docs.flatMap(doc => [...doc.querySelectorAll('.ui-global-overlay')]).filter(isVisible);
        if (!overlays.length) return false;
        const pending = runtime.pendingAction;
        // 实站交卷确认使用空的全屏遮罩。仅允许当前、未过期、自动提交对应的唯一普通确认。
        return !(runtime.settings.fullAuto && runtime.settings.enabled && pending?.kind === 'submit' && pending.automatic
            && Date.now() - pending.at <= 30000 && submissionConfirmationControl());
    }

    function knownQuestionTotal() {
        const card = card2Context();
        if (card) return card.cards.length;
        if (card2AttemptToken('record') && runtime.flow?.attemptToken === card2AttemptToken('record')
            && Number(runtime.flow.expectedTotal) > 0) return Number(runtime.flow.expectedTotal);
        for (const doc of sameOriginDocuments()) {
            const count = [...doc.querySelectorAll('[data-question-total], .question-count, .question-total')].filter(isVisible)
                .map(node => Number(node.getAttribute('data-question-total') || (node.innerText || '').match(/共\s*(\d+)\s*题/)?.[1])).find(value => value > 0);
            if (count) return count;
        }
        return 0;
    }

    function rememberFlow(stage, mode = runtime.flow?.mode || 'first') {
        const course = refreshQuestions()[0]?.course || extractCourseName();
        const paper = currentPaperTitle();
        if (!paper) return;
        const previous = runtime.flow && normalizeText(runtime.flow.course) === normalizeText(course)
            && normalizeText(runtime.flow.paper) === normalizeText(paper) ? runtime.flow : {};
        runtime.flow = { ...previous, origin: root.location.origin, course, paper, stage, mode, at: Date.now() };
        gmSet(FLOW_KEY, runtime.flow);
    }

    function saveProgress() {
        try { root.sessionStorage.setItem(PROGRESS_KEY, JSON.stringify([...runtime.progress].map(([key, values]) => [key, [...values]]))); } catch (_) {}
    }

    function importConfiguration(input) {
        const data = typeof input === 'string' ? JSON.parse(input) : input;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('配置必须是 JSON 对象');
        const settings = data.settings || data;
        const patch = {};
        for (const key of ['assistantServiceEnabled', 'useAiFallback']) {
            if (Object.hasOwn(settings, key)) {
                if (typeof settings[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
                patch[key] = settings[key];
            }
        }
        if (Object.hasOwn(settings, 'minAnswerConfidence')) {
            const value = Number(settings.minAnswerConfidence);
            if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error('置信度必须在 0 到 1 之间');
            patch.minAnswerConfidence = value;
        }
        if (Object.hasOwn(settings, 'assistantServiceUrl')) {
            const url = new URL(String(settings.assistantServiceUrl));
            if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error('只支持本机服务地址');
            patch.assistantServiceUrl = url.toString().replace(/\/$/, '');
        }
        if (Object.hasOwn(settings, 'assistantServiceToken')) patch.assistantServiceToken = String(settings.assistantServiceToken).trim();
        if (data.answerBank !== undefined && (!Array.isArray(data.answerBank) || data.answerBank.some(item => !item || typeof item !== 'object' || (!item.stem && !item.stemIncludes && !item.fingerprint)
            || (item.answers !== undefined && !Array.isArray(item.answers)) || (item.answerTexts !== undefined && !Array.isArray(item.answerTexts))))) throw new Error('答案表必须是包含题干或指纹以及数组答案的记录数组');
        if (patch.assistantServiceEnabled && !(patch.assistantServiceToken ?? runtime.settings.assistantServiceToken)) throw new Error('启用本地 AI 需要访问令牌');
        saveSettings(patch);
        if (data.answerBank !== undefined) gmSet(ANSWER_BANK_KEY, data.answerBank);
        runtime.processedView = '';
        log(`配置已导入${data.answerBank ? `，答案表 ${data.answerBank.length} 条` : ''}`);
        return { imported: true, answerCount: data.answerBank?.length || 0 };
    }

    function importAnswerBackup(input) {
        const data = typeof input === 'string' ? JSON.parse(input) : input;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('答案备份必须是 JSON 对象');
        const merged = loadAnswers();
        let count = 0;
        for (const [key, bucket] of Object.entries(data)) {
            if (!key.includes('::') || !bucket || typeof bucket !== 'object' || Array.isArray(bucket)) throw new Error('卷子记录格式错误');
            for (const [fingerprint, entry] of Object.entries(bucket)) {
                if (!/^[0-9a-f]{8}$/i.test(fingerprint) || entry?.schema !== 2 || typeof entry.stem !== 'string' || !Array.isArray(entry.optionLayout) || !Array.isArray(entry.correctOptionTexts) || !Array.isArray(entry.answerTexts)) throw new Error('仅支持 1.1.0 起保存完整选项内容的答案备份');
                count++;
            }
        }
        for (const [key, bucket] of Object.entries(data)) merged[key] = { ...merged[key], ...bucket };
        saveAnswers(merged);
        runtime.processedView = '';
        log(`考试答案备份已导入：${count} 道`);
        return { imported: true, count };
    }

    async function manualAction(action) {
        if (runtime.busy) { log('当前操作尚未结束，请先停止或等待', 'warn'); return; }
        runtime.busy = true;
        runtime.answerGeneration++;
        try { return await clickAction(action); }
        catch (error) { log(`操作失败：${error.message}`, 'error'); }
        finally { runtime.busy = false; updatePanel(); }
    }

    // ---------- 面板 ----------

    function createPanel() {
        if (!root.document?.body || root.document.getElementById(`${SCRIPT_ID}-panel`)) return;
        const panel = root.document.createElement('section');
        panel.id = `${SCRIPT_ID}-panel`;
        panel.innerHTML = `
            <div class="fze-head"><strong>考试刷分助手</strong><span data-role="version">${VERSION}</span><button data-action="collapse" title="收起">−</button></div>
            <div class="fze-body">
                <div class="fze-status"><span data-role="state">IDLE</span><span data-role="phase">UNKNOWN</span></div>
                <div class="fze-actions">
                    <button data-action="start">启动</button>
                    <button data-action="stop">停止</button>
                    <button data-action="rescan">只读重新扫描</button>
                    <label class="fze-check"><input type="checkbox" data-role="auto-advance">自动推进（当前卷）</label>
                    <label class="fze-check"><input type="checkbox" data-role="full-auto">全自动：首轮暂选、交卷、核对、重做一次</label>
                    <label class="fze-check"><input type="checkbox" data-role="use-ai">新题 AI 优先</label>
                </div>
                <label class="fze-choice">目标卷子 <select data-role="paper-choice"><option value="">请选择</option></select></label>
                <div class="fze-papers" data-role="papers"></div>
                <div class="fze-step">
                    <button data-action="start-exam">开始考试</button>
                    <button data-action="random">手动随机</button>
                    <button data-action="read">读取答案</button>
                    <button data-action="continue-exam">继续考试</button>
                    <button data-action="fill">填正确答案</button>
                    <button data-action="review">核对并订正当前卷</button>
                    <button data-action="enumerate">枚举错题（自动重试）</button>
                    <button data-action="submit">交卷</button>
                    <button data-action="return">返回</button>
                    <button data-action="settings">配置 / 导入</button>
                    <button data-action="reset-wait">失败后重新检查</button>
                </div>
                <details data-role="settings" hidden><summary>本机配置</summary>
                    <label>服务地址 <input data-role="service-url" type="url" autocomplete="off"></label>
                    <label>本地访问令牌 <input data-role="service-token" type="password" autocomplete="off"></label>
                    <label>最低置信度 <input data-role="confidence" type="number" min="0" max="1" step="0.05"></label>
                    <label class="fze-check"><input data-role="service-enabled" type="checkbox">启用本地 AI 服务</label>
                    <button data-action="save-config">保存配置</button><button data-action="test-service">测试连接</button>
                    <button data-action="import-config">导入主脚本配置 / 答案表</button>
                    <button data-action="import-answers">导入考试答案备份</button>
                </details>
                <div class="fze-source" data-role="diagnostic"></div>
                <div class="fze-questions" data-role="questions"></div>
                <div class="fze-log" data-role="log"></div>
            </div>`;
        const style = root.document.createElement('style');
        style.textContent = `
            #${SCRIPT_ID}-panel{position:fixed;left:18px;bottom:18px;width:min(360px,calc(100vw - 36px));max-height:calc(100vh - 36px);overflow:auto;z-index:2147483645;background:#fff;color:#111;border:1px solid #999;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.22);font:14px/1.45 "Microsoft YaHei",sans-serif}
            #${SCRIPT_ID}-panel .fze-head{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#1f5c3d;color:#fff;border-radius:9px 9px 0 0}
            #${SCRIPT_ID}-panel .fze-head span{margin-left:auto;font-size:12px;opacity:.85}
            #${SCRIPT_ID}-panel .fze-head button{margin-left:0;min-height:26px;padding:0 8px;border-color:#fff;background:transparent;color:#fff}
            #${SCRIPT_ID}-panel button{min-height:34px;padding:6px 10px;border:1px solid #777;border-radius:6px;background:#f7f7f7;color:#111;cursor:pointer}
            #${SCRIPT_ID}-panel .fze-body{padding:11px}
            #${SCRIPT_ID}-panel .fze-status{display:flex;gap:8px;margin-bottom:8px;font-weight:700}
            #${SCRIPT_ID}-panel .fze-actions{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-bottom:8px}
            #${SCRIPT_ID}-panel .fze-actions button:first-child{background:#e2f0d9;border-color:#70ad47}
            #${SCRIPT_ID}-panel .fze-check{display:inline-flex;align-items:center;gap:4px;font-size:12px}
            #${SCRIPT_ID}-panel .fze-step{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;padding:7px;background:#f2f7f2;border-radius:6px}
            #${SCRIPT_ID}-panel .fze-step button{min-height:30px;font-size:12px}
            #${SCRIPT_ID}-panel .fze-papers,#${SCRIPT_ID}-panel .fze-questions{max-height:150px;overflow:auto;margin-bottom:8px}
            #${SCRIPT_ID}-panel details label{display:block;margin:7px 0}#${SCRIPT_ID}-panel details input:not([type=checkbox]){box-sizing:border-box;width:100%;padding:5px}#${SCRIPT_ID}-panel select{max-width:250px}#${SCRIPT_ID}-panel .fze-choice{display:block;margin-bottom:8px}
            #${SCRIPT_ID}-panel .fze-paper,.fze-question{padding:6px 8px;border:1px solid #e0e0e0;border-radius:6px;margin-bottom:6px;background:#fafafa}
            #${SCRIPT_ID}-panel .fze-question .fze-answer{color:#1f5c3d;font-weight:700}
            #${SCRIPT_ID}-panel .fze-question .fze-source{color:#777;font-size:12px}
            #${SCRIPT_ID}-panel .fze-log{max-height:110px;overflow:auto;padding:7px;background:#f6f7f8;border-radius:5px;font-size:12px;white-space:pre-wrap}
            #${SCRIPT_ID}-panel.fze-collapsed .fze-body{display:none}`;
        style.textContent += `#${SCRIPT_ID}-panel [hidden]{display:none!important}`;
        root.document.head.appendChild(style);
        root.document.body.appendChild(panel);
        runtime.panel = panel;

        panel.querySelector('[data-role="auto-advance"]').checked = runtime.settings.autoAdvance;
        panel.querySelector('[data-role="full-auto"]').checked = runtime.settings.fullAuto;
        panel.querySelector('[data-role="use-ai"]').checked = runtime.settings.useAiFallback;
        panel.querySelector('[data-role="service-url"]').value = runtime.settings.assistantServiceUrl;
        panel.querySelector('[data-role="service-token"]').value = runtime.settings.assistantServiceToken;
        panel.querySelector('[data-role="service-enabled"]').checked = runtime.settings.assistantServiceEnabled;
        panel.querySelector('[data-role="confidence"]').value = runtime.settings.minAnswerConfidence;

        panel.addEventListener('change', (event) => {
            runtime.processedView = '';
            if (event.target.dataset.role === 'auto-advance') {
                saveSettings({ autoAdvance: event.target.checked, ...(!event.target.checked ? { fullAuto: false } : {}) });
                if (!event.target.checked) panel.querySelector('[data-role="full-auto"]').checked = false;
            }
            if (event.target.dataset.role === 'full-auto') {
                stop();
                saveSettings({ fullAuto: event.target.checked, ...(event.target.checked ? { autoAdvance: true } : {}) });
                panel.querySelector('[data-role="auto-advance"]').checked = runtime.settings.autoAdvance;
                log(event.target.checked ? '全自动流程已选择，点击启动后生效；最多重做一次。' : '已关闭全自动交卷。');
            }
            if (event.target.dataset.role === 'use-ai') saveSettings({ useAiFallback: event.target.checked });
            if (event.target.dataset.role === 'paper-choice') { runtime.flow = null; gmSet(FLOW_KEY, null); }
        });

        panel.addEventListener('click', async (event) => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (!action) return;
            if (action === 'collapse') { panel.classList.toggle('fze-collapsed'); return; }
            if (action === 'start') return start();
            if (action === 'stop') return stop();
            if (action === 'rescan') return readOnlyScan();
            if (action === 'review') return startReview();
            if (action === 'enumerate') return startEnumeration();
            if (action === 'reset-wait') {
                if (!root.confirm('确认平台未成功执行上一动作后重新检查？脚本会先停止，需要再次启动才能推进。')) return;
                stop();
                runtime.pendingAction = null;
                runtime.processedView = '';
                try { root.sessionStorage.removeItem(PENDING_KEY); } catch (_) {}
                return;
            }
            if (action === 'settings') { const box = panel.querySelector('[data-role="settings"]'); box.hidden = !box.hidden; box.open = !box.hidden; return; }
            if (['save-config', 'import-config', 'test-service', 'import-answers'].includes(action)) {
                if (runtime.busy) { log('请先停止当前操作，再修改配置', 'warn'); return; }
                try {
                    if (action === 'save-config') importConfiguration({ assistantServiceEnabled: panel.querySelector('[data-role="service-enabled"]').checked, assistantServiceUrl: panel.querySelector('[data-role="service-url"]').value, assistantServiceToken: panel.querySelector('[data-role="service-token"]').value, minAnswerConfidence: panel.querySelector('[data-role="confidence"]').value });
                    if (action === 'import-config') {
                        const text = root.prompt('粘贴主脚本导出的配置 JSON，或答案表 JSON 数组。配置含本地访问令牌，请仅在本机使用。');
                        if (text) { const data = JSON.parse(text); importConfiguration(Array.isArray(data) ? { answerBank: data } : data); }
                    }
                    if (action === 'import-answers') {
                        const text = root.prompt('粘贴本脚本导出的考试答案 JSON（1.1.0 起保存选项内容）');
                        if (text) importAnswerBackup(text);
                    }
                    if (action === 'test-service') {
                        const health = await serviceRequest('/health', null, 'GET');
                        await serviceRequest('/api/auth/check', {});
                        log(`本地服务与令牌有效；AI ${health.aiConfigured ? '已配置' : '未配置'}`);
                    }
                } catch (error) { log(`配置操作失败：${error.message}`, 'error'); }
                panel.querySelector('[data-role="service-url"]').value = runtime.settings.assistantServiceUrl;
                panel.querySelector('[data-role="service-token"]').value = runtime.settings.assistantServiceToken;
                panel.querySelector('[data-role="service-enabled"]').checked = runtime.settings.assistantServiceEnabled;
                panel.querySelector('[data-role="confidence"]').value = runtime.settings.minAnswerConfidence;
                return;
            }
            const map = {
                'start-exam': 'start', 'random': 'random', 'read': 'read',
                'continue-exam': 'continue', 'fill': 'fill', 'submit': 'submit', 'return': 'return'
            };
            await manualAction(map[action]);
            updatePanel();
        });
        updatePanel();
    }

    function updatePanel(scannedQuestions = null) {
        const panel = runtime.panel;
        if (!panel) return;
        const questions = scannedQuestions || refreshQuestions();
        runtime.phase = detectPhase(questions);
        const state = panel.querySelector('[data-role="state"]');
        const phase = panel.querySelector('[data-role="phase"]');
        const logBox = panel.querySelector('[data-role="log"]');
        const papersBox = panel.querySelector('[data-role="papers"]');
        const questionsBox = panel.querySelector('[data-role="questions"]');
        if (state) state.textContent = runtime.state;
        if (phase) phase.textContent = runtime.phase;
        const diagnostic = panel.querySelector('[data-role="diagnostic"]');
        if (diagnostic && runtime.diagnostic) {
            const d = runtime.diagnostic;
            diagnostic.textContent = `${d.at} · ${d.reason} · 候选 ${d.candidates} / 可见 ${d.visible} / 可解析 ${d.parsed} · ${d.detail}`;
            diagnostic.dataset.scanCount = String(d.count);
        }
        if (logBox) logBox.textContent = runtime.logLines.slice(-8).map((line) => `[${line.at}] ${line.message}`).join('\n');

        if (papersBox) {
            const papers = findPapers();
            const selection = panel.querySelector('[data-role="paper-choice"]');
            const signature = JSON.stringify(papers.map(paper => [paper.key, paper.title]));
            if (selection && selection.dataset.signature !== signature) {
                const previous = selection.value;
                selection.innerHTML = '<option value="">请选择目标卷子</option>' + papers.map(paper => `<option value="${escapeHtml(paper.key)}">${escapeHtml(paper.title)}</option>`).join('');
                if (papers.some(paper => paper.key === previous)) selection.value = previous;
                selection.dataset.signature = signature;
            }
            if (selection) selection.parentElement.hidden = !papers.length || runtime.phase !== 'LIST';
            papersBox.innerHTML = papers.length
                ? papers.map((paper) => `<div class="fze-paper"><strong>${escapeHtml(paper.title)}</strong><br><span class="fze-source">开始/继续/记录按钮：${paper.startButton ? '有开始' : ''}${paper.continueButton ? '有继续' : ''}${paper.recordButton ? '有记录' : ''}</span></div>`).join('')
                : '<div class="fze-paper">未识别到卷子列表（在考试列表页自动扫描）</div>';
        }
        if (questionsBox) {
            const paperTitle = currentPaperTitle();
            questionsBox.innerHTML = questions.slice(0, 30).map((question) => {
                const answer = extractCorrectAnswer(question) || lookUpRecordedAnswer(question.course, paperTitle, question) || matchAnswerBank(question);
                const ansText = answer && (answer.answers.length || answer.answerTexts.length)
                    ? (answer.answers.join('、') || answer.answerTexts.join('；'))
                    : '—';
                return `<div class="fze-question">[${question.type}] ${escapeHtml(question.stem.slice(0, 40))}<br><span class="fze-answer">答案：${escapeHtml(ansText)}</span> <span class="fze-source">来源：${escapeHtml(answer?.source || '未知')}</span></div>`;
            }).join('') || '<div class="fze-question">当前页未识别到题目</div>';
        }
    }

    // ---------- 菜单与启动 ----------

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('启动考试刷分助手', start);
        GM_registerMenuCommand('停止考试刷分助手', stop);
        GM_registerMenuCommand('只读重新扫描', () => readOnlyScan());
        GM_registerMenuCommand('导出已保存的考试答案 JSON', () => {
            const data = loadAnswers();
            try {
                root.prompt('复制以下考试答案 JSON（仅含课程、卷子、题目、选项与答案）：', JSON.stringify(data, null, 2));
            } catch (_) {}
        });
        GM_registerMenuCommand('清除已保存的考试答案', () => {
            if (!root.confirm('确定清除所有已保存的考试正确答案记录吗？')) return;
            saveAnswers({});
            notify('已清除', '考试正确答案记录已清空。');
        });
    }

    function shouldBootHere() {
        const view = root.document.defaultView;
        if (view.parent === view) return true;
        try {
            const parent = view.parent;
            if (parent.document && ['fzugk.edu-xl.com', 'resgk.edu-xl.com', 'cws.edu-edu.com', 'em.edu-edu.com.cn', 'e13.edu-edu.com.cn', 'e14.edu-edu.com.cn'].includes(parent.location.hostname)) return false;
        } catch (_) { /* 跨域考试由自身实例处理，父页不能读取其 DOM。 */ }
        return true;
    }

    function boot() {
        if (!shouldBootHere()) return;
        if (root.document.getElementById(`${SCRIPT_ID}-panel`)) return;
        loadSettings();
        createPanel();
        registerMenus();
        root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && event.shiftKey) stop();
        });
        runtime.course = extractCourseName();
        runtime.papers = findPapers();
        const handoff = gmGet(RECORD_HANDOFF_KEY, null);
        const receivingRecord = handoff?.origin === root.location.origin && handoff.attemptToken === card2AttemptToken('record')
            && handoff.expires > Date.now();
        const enumeration = enumerationState();
        const receivingEnum = enumeration && ['NAV_LIST', 'OPEN_PAPER', 'OPEN_RECORD'].includes(enumeration.stage);
        if (runtime.settings.enabled && !runtime.timer && gmGet(RUN_KEY, {})?.owner === runtime.tabId && !receivingRecord && !receivingEnum) start();
        else log('考试刷分助手就绪。可使用「只读重新扫描」检查识别；启动会进入操作流程。');
        readOnlyScan('初始扫描');
        tryRecordHandoff();
        tryEnumerationResume();
    }

    function tryRecordHandoff() {
        const handoff = gmGet(RECORD_HANDOFF_KEY, null);
        if (!handoff || !runtime.settings.enabled || !runtime.settings.fullAuto
            || handoff.origin !== root.location.origin || handoff.expires < Date.now()
            || handoff.at > Date.now() || handoff.expires - handoff.at > 30000
            || !handoff.attemptToken || handoff.attemptToken !== card2AttemptToken('record')
            || gmGet(RUN_KEY, {})?.owner !== handoff.source) return;
        const questions = findQuestionNodes().map(parseQuestion);
        if (!questions.length || detectPhase(questions) !== 'RECORD') {
            runtime.handoffTimer = root.setTimeout(tryRecordHandoff, 200); return;
        }
        if (normalizeText(questions[0].course) !== normalizeText(handoff.course)
            || normalizeText(currentPaperTitle()) !== normalizeText(handoff.paper)
            || runtime.flow?.attemptToken !== handoff.attemptToken || runtime.flow?.stage !== 'submitted') return;
        // 浏览器新窗口可能复制 sessionStorage；接续实例领取新的运行权，只消费一次。
        runtime.tabId = root.crypto.randomUUID();
        root.sessionStorage.setItem('fzugk-exam-tab-v2', runtime.tabId);
        runtime.pendingAction = null;
        root.sessionStorage.removeItem(PENDING_KEY);
        gmSet(RECORD_HANDOFF_KEY, null);
        log('已接续本次交卷的答卷页；只读取平台可验证的正确答案。');
        start();
    }

    const exported = {
        VERSION,
        normalizeText,
        questionFingerprint,
        parseQuestion,
        findQuestionNodes,
        extractCorrectAnswer,
        applyAnswer,
        randomFill,
        findPapers,
        detectPhase,
        findStartExamButton,
        findContinueExamButton,
        findSubmitPaperButton,
        findRecordButton,
        recordAnswers,
        lookUpRecordedAnswer,
        loadAnswers,
        importConfiguration,
        identityBlocked,
        readOnlyScan,
        importAnswerBackup,
        nextEnumerationPlan
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    if (root.document && root.location) {
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
        else boot();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
