// ==UserScript==
// @name         福州大学自考学习无障碍助手
// @namespace    local.codex.fzugk
// @version      0.5.1
// @description  在授权的刷课阶段自动播放、处理随堂练习、归档题目并导出 Word；正式考试自动停机。
// @match        https://fzugk.edu-xl.com/*
// @match        https://resgk.edu-xl.com/*
// @match        https://cws.edu-edu.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_addValueChangeListener
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @connect      localhost
// @updateURL    http://127.0.0.1:8766/install/fzugk-study-assistant.meta.js
// @downloadURL  http://127.0.0.1:8766/install/fzugk-study-assistant.user.js
// ==/UserScript==

(function (root) {
    'use strict';

    const SCRIPT_ID = 'fzugk-study-assistant';
    const VERSION = '0.5.1';
    const DB_NAME = 'fzugk-study-assistant';
    const DB_VERSION = 1;
    const STORE_QUESTIONS = 'questions';
    const STORE_META = 'meta';
    const SETTINGS_KEY = 'fzugk-settings-v1';
    const ANSWER_BANK_KEY = 'fzugk-answer-bank-v1';

    const DEFAULT_SETTINGS = Object.freeze({
        enabled: true,
        autoplay: true,
        muted: true,
        playbackRate: 1,
        autoAdvance: true,
        autoAdvanceNoMedia: false,
        autoResumeDialogs: true,
        courseAutoAnswer: true,
        courseAutoSubmit: true,
        minAnswerConfidence: 0.85,
        unresolvedPolicy: 'pause',
        archiveQuestions: true,
        autoExportDocx: true,
        exportOnCourseComplete: true,
        assistantServiceEnabled: false,
        assistantServiceUrl: 'http://127.0.0.1:8766',
        assistantServiceToken: '',
        courseMaterialRetrieval: true,
        webSearchMode: 'always',
        requireEvidence: true,
        audioTranscription: false,
        visualRecognition: false,
        audioChunkSeconds: 20,
        loopIntervalMs: 1500,
        postVideoGraceMs: 3000,
        maxRetries: 3,
        debug: false
    });

    const runtime = {
        state: 'IDLE',
        settings: { ...DEFAULT_SETTINGS },
        timer: null,
        busy: false,
        stoppedByExam: false,
        lastUrl: '',
        lastProgressAt: Date.now(),
        currentCourse: '',
        currentChapter: '',
        processedQuestions: new Set(),
        videoHandlers: new WeakMap(),
        retries: new Map(),
        logLines: [],
        panel: null,
        lastExportKey: '',
        pendingDownload: null,
        scanMisses: 0,
        lastMediaSignature: '',
        answerGeneration: 0,
        lastMaterialSyncKey: '',
        materialSyncAt: 0,
        activeServiceRequest: null,
        audioCapture: null,
        transcriptItems: [],
        handledQuizFollowups: new WeakSet(),
        correctionAttempts: new Map(),
        pendingCorrection: null,
        studyContextKey: '',
        studyGeneration: 0,
        completedMediaKey: '',
        completedMediaAt: 0,
        advancedMediaKey: '',
        progressWarningKey: '',
        platformMediaState: null,
        currentLesson: null,
        expectedLessonId: '',
        lastReplayAt: 0,
        mode: 'STUDY',
        assessment: null
    };

    function normalizeText(value) {
        return String(value ?? '')
            .replace(/[\u200B-\u200D\uFEFF]/g, '')
            .replace(/\s+/g, ' ')
            .replace(/^\s*[（(]?[A-DＡ-Ｄ1-9一二三四五六七八九][）).、．]\s*/i, '')
            .trim()
            .toLowerCase();
    }

    function escapeXml(value) {
        return String(value ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&apos;');
    }

    function safeFileName(value) {
        const cleaned = String(value || '课程')
            .replace(/[\\/:*?"<>|\x00-\x1F]/g, '_')
            .replace(/\s+/g, ' ')
            .trim();
        return (cleaned || '课程').slice(0, 80);
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
        const style = root.getComputedStyle ? root.getComputedStyle(element) : null;
        if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0)) return false;
        const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { width: 1, height: 1 };
        return rect.width > 0 && rect.height > 0;
    }

    function uniqueElements(elements) {
        return [...new Set(elements.filter(Boolean))];
    }

    function nowIso() {
        return new Date().toISOString();
    }

    function dateStamp(date = new Date()) {
        const pad = (value) => String(value).padStart(2, '0');
        return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
    }

    function log(message, level = 'info') {
        const line = { at: new Date().toLocaleTimeString(), level, message: String(message) };
        runtime.logLines.push(line);
        if (runtime.logLines.length > 100) runtime.logLines.shift();
        if (runtime.settings.debug || level !== 'debug') {
            const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log';
            console[method](`[${SCRIPT_ID}] ${line.message}`);
        }
        updatePanel();
    }

    function notify(title, text) {
        try {
            if (typeof GM_notification === 'function') {
                GM_notification({ title, text, timeout: 10000 });
            }
        } catch (error) {
            log(`系统通知失败：${error.message}`, 'warn');
        }
        try {
            const context = new (root.AudioContext || root.webkitAudioContext)();
            const oscillator = context.createOscillator();
            const gain = context.createGain();
            oscillator.frequency.value = 740;
            gain.gain.value = 0.08;
            oscillator.connect(gain).connect(context.destination);
            oscillator.start();
            oscillator.stop(context.currentTime + 0.25);
        } catch (_) {}
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

    function loadSettings() {
        const saved = gmGet(SETTINGS_KEY, {});
        runtime.settings = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === 'object' ? saved : {}) };
        runtime.settings.playbackRate = Math.min(2, Math.max(0.5, Number(runtime.settings.playbackRate) || 1));
        runtime.settings.loopIntervalMs = Math.max(750, Number(runtime.settings.loopIntervalMs) || 1500);
        return runtime.settings;
    }

    function saveSettings(patch) {
        runtime.settings = { ...runtime.settings, ...patch };
        gmSet(SETTINGS_KEY, runtime.settings);
        updatePanel();
    }

    function pageText(selector = 'body') {
        return normalizeText(root.document?.querySelector(selector)?.innerText || '');
    }

    function prominentText() {
        const selectors = ['h1', 'h2', '.page-title', '.exam-title', '.test-title', '.paper-title', '[role="heading"]'];
        return normalizeText(selectors.flatMap((selector) => [...root.document.querySelectorAll(selector)])
            .filter(isVisible)
            .map((element) => element.innerText)
            .join(' '));
    }

    function detectLoginPage() {
        const path = root.location?.pathname?.toLowerCase() || '';
        return Boolean(root.document.querySelector('#txtUserName, #txtPwd, #login_container')) || /\/index\/(login|portalnew)/.test(path);
    }

    function detectExamPage() {
        const path = `${root.location?.pathname || ''}${(root.location?.hash || '').split('?')[0]}`.toLowerCase();
        const title = normalizeText(root.document?.title || '');
        const heading = prominentText();
        const strongUrl = /\/[^/?]*(exam|examination|examcenter|testcenter|kaoshi|paper)[^/?]*(\/|\?|$)/i.test(path);
        const strongTitle = /(正式考试|期末考试|结业考试|在线考试|考试中心|监考|准考证|提交试卷|开始考试)/.test(`${title} ${heading}`)
            || /(^|\s)考试($|\s)/.test(title)
            || /考试$/.test(heading);
        // Aliplayer generates UUIDs that can contain FACE. A random ID is not an identity or exam signal.
        const proctor = [...root.document.querySelectorAll('[class*="proctor" i], [id*="proctor" i], [class*="invigil" i], [id*="invigil" i], video[data-proctor]')]
            .filter(isVisible)
            .some((element) => {
                if (element.hasAttribute('data-proctor')) return !/^(?:false|0|off)$/i.test(element.getAttribute('data-proctor') || '');
                return !element.id.startsWith('J_prismPlayer_component_');
            });
        const countdown = uniqueElements([...root.document.querySelectorAll('[class*="countdown" i], [id*="countdown" i], .exam-time, .paper-time')]).some(isVisible);
        const submitPaper = [...root.document.querySelectorAll('button, a, input[type="button"], input[type="submit"]')]
            .filter(isVisible)
            .some((element) => /(提交试卷|交卷|结束考试)/.test(element.innerText || element.value || ''));
        const examMatched = strongUrl || strongTitle || proctor || (countdown && submitPaper);
        const identityPrompt = !examMatched && [...root.document.querySelectorAll('[data-face-verification], #faceVerification, #face-verification, .face-verification, .face-recognition, .identity-verification, .ivu-modal-wrap, [role="dialog"], .modal, .dialog')]
            .filter(isVisible)
            .some((element) => {
                const text = String(element.innerText || '');
                return /(人脸识别|人脸验证|身份验证|拍照验证|实名认证)/.test(text)
                    && /(请|需要|开始|进行|拍照|验证)/.test(text);
            });
        return {
            matched: examMatched || identityPrompt,
            reasons: examMatched
                ? [strongUrl && '考试路由', strongTitle && '考试标题', proctor && '监考组件（可见且明确标记）', countdown && submitPaper && '倒计时及交卷按钮'].filter(Boolean)
                : identityPrompt ? ['身份验证提示'] : []
        };
    }

    function courseContext() {
        const path = `${root.location?.pathname || ''}${root.location?.search || ''}`.toLowerCase();
        const host = root.location?.hostname?.toLowerCase() || '';
        const positiveUrl = /(course|learn|study|chapter|video|studentzksite|studentcourse|knowledge|task|page\/client)/i.test(path)
            || /^(?:resgk\.edu-xl\.com|cws\.edu-edu\.com)$/.test(host);
        const positiveDom = Boolean(root.document.querySelector('video, #J_prismPlayer, .prism-player, .course-tree, #coursetree, [class*="chapter" i], [class*="course" i], [class*="learning" i]'));
        return positiveUrl || positiveDom;
    }

    function cwsCatalogRows(doc = root.document) {
        return [...doc.querySelectorAll('.videoNavBox li.videoBox[id^="video_"]')];
    }

    function cwsActiveLesson() {
        for (const doc of sameOriginDocuments()) {
            const rows = cwsCatalogRows(doc).filter((row) => row.classList.contains('active') && isVisible(row));
            if (rows.length === 1) return rows[0];
        }
        return null;
    }

    function progressFromText(element) {
        const text = String(element?.innerText || '').trim();
        if (/^(?:已完成|100(?:\.0+)?\s*%)$/.test(text)) return 100;
        const match = text.match(/^(\d+(?:\.\d+)?)\s*%$/);
        const percent = match ? Number(match[1]) : NaN;
        return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null;
    }

    function cwsLessonTitle(row) {
        const title = String(row?.querySelector('.videoTitme')?.innerText || '').trim();
        // The parent chapter distinguishes repeated titles such as 本章考点 and 真题讲解.
        const group = row?.parentElement?.closest('li.conBox');
        const heading = group && [...group.children].find((child) => child.tagName !== 'UL');
        return [String(heading?.innerText || '').trim(), title].filter(Boolean).join(' / ');
    }

    function extractCourseInfo() {
        const courseSelectors = [
            '.bigTitle > h3', '[data-course-name]', '.course-name', '.course-title', '#courseName', '.subject-name', '.kc-name', '.courseInfo + .title', 'h1'
        ];
        const chapterSelectors = [
            '.chapter-name.active', '.chapter-title.active', '.current-chapter', '.active .chapter-name', '.catalog_active', '.posCatalog_active .posCatalog_name', '.ivu-tree-title-selected', '.ivu-tree-title.ivu-tree-title-selected', 'h2'
        ];
        const firstText = (selectors, fallback) => {
            for (const selector of selectors) {
                const element = [...root.document.querySelectorAll(selector)].find((item) => isVisible(item) && normalizeText(item.innerText));
                if (element) return String(element.getAttribute('data-course-name') || element.innerText).trim();
            }
            return fallback;
        };
        runtime.currentCourse = firstText(courseSelectors, root.document.title || '未命名课程');
        const lesson = cwsActiveLesson();
        runtime.currentChapter = lesson ? cwsLessonTitle(lesson) : firstText(chapterSelectors, '未识别章节');
        return { course: runtime.currentCourse, chapter: runtime.currentChapter };
    }

    function syncStudyContext() {
        const { course, chapter } = extractCourseInfo();
        const row = cwsActiveLesson();
        const lesson = row ? { id: row.id, title: chapter, progress: progressFromText(row.querySelector('.videoProgress')) } : null;
        const key = `${root.location.href}::${normalizeText(course)}::${row?.id || normalizeText(chapter.replace(/\d+(?:\.\d+)?\s*%/g, ''))}`;
        const previousLesson = runtime.currentLesson;
        runtime.currentLesson = lesson;
        if (key === runtime.studyContextKey) return;
        const hadContext = Boolean(runtime.studyContextKey);
        const expected = lesson && runtime.expectedLessonId === lesson.id;
        runtime.expectedLessonId = '';
        runtime.studyContextKey = key;
        runtime.studyGeneration += 1;
        runtime.completedMediaKey = '';
        runtime.completedMediaAt = 0;
        runtime.advancedMediaKey = '';
        runtime.progressWarningKey = '';
        runtime.lastMediaSignature = '';
        runtime.platformMediaState = null;
        runtime.lastReplayAt = 0;
        if (runtime.mode !== 'ASSESSMENT') runtime.processedQuestions.clear();
        runtime.correctionAttempts.clear();
        runtime.pendingCorrection = null;
        runtime.answerGeneration += 1;
        runtime.lastMaterialSyncKey = '';
        runtime.materialSyncAt = 0;
        runtime.retries.clear();
        runtime.lastProgressAt = Date.now();
        if (hadContext) {
            const origin = expected ? '助手切换已生效' : '检测到页面切换（非助手发起）';
            const previous = previousLesson ? `；上一节 ${previousLesson.title}，平台进度 ${previousLesson.progress === null ? '未知' : `${previousLesson.progress}%`}` : '';
            log(`${origin}：${course} / ${chapter}${previous}`, !expected && previousLesson?.progress !== null && previousLesson?.progress < 100 ? 'warn' : 'info');
        }
    }

    function activeLessonProgress() {
        const lesson = cwsActiveLesson();
        if (lesson) return progressFromText(lesson.querySelector('.videoProgress'));
        const selectors = '.catalog_active, .posCatalog_active, .ivu-tree-title-selected, .course-tree .active, #coursetree .active, .chapter-name.active, .chapter-title.active, [aria-current="page"], [aria-current="true"]';
        for (const doc of sameOriginDocuments()) {
            for (const active of [...doc.querySelectorAll(selectors)].filter(isVisible)) {
                let scope = active;
                for (let depth = 0; scope && depth < 4 && scope !== doc.body; depth += 1, scope = scope.parentElement) {
                    if (/^已完成$/.test(String(scope.innerText || '').trim())) return 100;
                    const matches = [...String(scope.innerText || '').matchAll(/(\d+(?:\.\d+)?)\s*%/g)];
                    if (matches.length > 1) break;
                    if (matches.length === 1) {
                        const percent = Number(matches[0][1]);
                        if (percent >= 0 && percent <= 100) return percent;
                    }
                }
            }
        }
        return null;
    }

    function holdPlatformContinuousPlayback() {
        if (!runtime.settings.autoAdvance) return;
        for (const doc of sameOriginDocuments()) {
            const control = [...doc.querySelectorAll('.chain-broadcast .ivu-switch.ivu-switch-checked')].find(isVisible);
            if (!control || isDisabledControl(control)) continue;
            control.click();
            log('已关闭平台连续播放，由助手在本节进度完成后切换');
        }
    }

    function sameOriginDocuments(doc = root.document, depth = 0) {
        const documents = [doc];
        if (depth >= 3) return documents;
        for (const frame of doc.querySelectorAll('iframe')) {
            try {
                if (frame.contentDocument) documents.push(...sameOriginDocuments(frame.contentDocument, depth + 1));
            } catch (_) {}
        }
        return uniqueElements(documents);
    }

    function findVideos() {
        return uniqueElements(sameOriginDocuments().flatMap((doc) => [...doc.querySelectorAll('video')]))
            .filter((video) => !/^(?:snapVideo|cameraVideo|previewVideo)$/i.test(video.id || ''))
            .filter((video) => isVisible(video) || isVisible(video.closest('#J_prismPlayer, .prism-player, .video-box')));
    }

    function getPlatformPlayer() {
        try {
            const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : root;
            const player = page?.player;
            if (player && typeof player.play === 'function') return player;
        } catch (_) {}
        return null;
    }

    function getPlaybackContext(video) {
        try {
            const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : root;
            let element = page.document?.getElementById('J_prismPlayer') || video.closest('#J_prismPlayer');
            if (element?.contains(video)) {
                for (; element; element = element.parentElement) {
                    const owner = element.__vue__;
                    if (owner?.player && typeof owner.player.play === 'function' && typeof owner.player.seek === 'function') {
                        return { owner, player: owner.player };
                    }
                }
            }
        } catch (_) {}
        return { owner: null, player: getPlatformPlayer() };
    }

    function playbackBlocker(owner) {
        if (root.document.visibilityState === 'hidden') return '课程页面不在前台';
        if (owner && ['isModalOpen', 'questionModal', 'faceInfoModal', 'SpeedTimeModal', 'screenSwitchingModal', 'alertModals', 'seeModal']
            .some((name) => owner[name])) return '平台仍有待处理提示或验证';
        const dialog = sameOriginDocuments().flatMap((doc) => [...doc.querySelectorAll('.ivu-modal-wrap, [role="dialog"], .modal, .dialog')])
            .find((element) => isVisible(element) && String(element.innerText || '').trim());
        return dialog ? '页面仍有待处理弹窗' : '';
    }

    function bindVideo(video) {
        if (runtime.videoHandlers.has(video)) return runtime.videoHandlers.get(video);
        const state = {
            source: video.currentSrc || video.src || '',
            generation: runtime.studyGeneration,
            fresh: true,
            endedLogged: false,
            replayPending: false
        };
        const onEnded = () => {
            if (!video.isConnected || state.generation !== runtime.studyGeneration || !state.fresh
                || !Number.isFinite(video.duration) || video.duration <= 0 || video.currentTime < video.duration - 0.25) return;
            runtime.lastProgressAt = Date.now();
            if (!state.endedLogged) {
                state.endedLogged = true;
                log(`视频已到结尾（${Math.round(video.currentTime)}/${Math.round(video.duration)} 秒），等待平台确认章节进度`);
            }
        };
        const onReset = () => { state.fresh = false; state.endedLogged = false; state.replayPending = false; };
        const onMetadata = () => {
            state.source = video.currentSrc || video.src || '';
            state.generation = runtime.studyGeneration;
            state.fresh = true;
            state.endedLogged = false;
            state.replayPending = false;
        };
        const onError = () => log(`视频播放错误：${video.error?.message || video.error?.code || '未知错误'}`, 'warn');
        video.addEventListener('ended', onEnded);
        video.addEventListener('error', onError);
        video.addEventListener('emptied', onReset);
        video.addEventListener('loadstart', onReset);
        video.addEventListener('loadedmetadata', onMetadata);
        Object.assign(state, { onEnded, onError, onReset, onMetadata });
        runtime.videoHandlers.set(video, state);
        return state;
    }

    async function playVideos() {
        const videos = findVideos();
        const platformPlayer = getPlatformPlayer();
        if (!videos.length && !platformPlayer) {
            runtime.scanMisses += 1;
            if (runtime.scanMisses === 8) log(`尚未发现课件播放器（当前域名：${root.location.hostname}）`, 'warn');
            return { found: false, complete: false };
        }
        runtime.scanMisses = 0;
        runtime.state = 'PLAYING';
        if (!videos.length && platformPlayer) {
            try {
                const status = typeof platformPlayer.getStatus === 'function' ? platformPlayer.getStatus() : '';
                const duration = typeof platformPlayer.getDuration === 'function' ? Number(platformPlayer.getDuration()) : NaN;
                const currentTime = typeof platformPlayer.getCurrentTime === 'function' ? Number(platformPlayer.getCurrentTime()) : NaN;
                if (!runtime.platformMediaState) runtime.platformMediaState = { fresh: runtime.studyGeneration === 1 };
                if (/playing/i.test(status)) runtime.platformMediaState.fresh = true;
                const complete = runtime.platformMediaState.fresh && /^ended$/i.test(status)
                    && Number.isFinite(duration) && duration > 0 && currentTime >= duration - 0.25;
                if (runtime.settings.autoplay && !complete && !/^ended$/i.test(status) && !/playing/i.test(status)) platformPlayer.play();
                return { found: true, complete, key: `${runtime.studyContextKey}::platform:${duration}` };
            } catch (error) {
                log(`课件播放器启动失败：${error.message}`, 'warn');
                return { found: true, complete: false };
            }
        }
        let allComplete = true;
        let replayNeeded = false;
        const mediaKeys = [];
        for (const video of videos) {
            const state = bindVideo(video);
            const source = video.currentSrc || video.src || '';
            if (state.generation !== runtime.studyGeneration || state.source !== source) {
                state.generation = runtime.studyGeneration;
                state.source = source;
                state.fresh = false;
                state.endedLogged = false;
                state.replayPending = false;
            }
            if (!video.ended && Number.isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.25) state.fresh = true;
            const key = `${runtime.studyContextKey}::${source || 'video'}:${Math.round(video.duration || 0)}`;
            mediaKeys.push(key);
            if (state.fresh && Number.isFinite(video.duration) && video.duration > 0
                && video.ended && video.currentTime >= video.duration - 0.25) continue;
            allComplete = false;
            const progress = cwsActiveLesson() ? activeLessonProgress() : null;
            const stoppedTail = video.paused && Number.isFinite(video.duration) && video.duration > 0 && video.currentTime >= video.duration - 0.75;
            if (progress !== null && progress < 100 && video.closest('#J_prismPlayer')
                && (state.replayPending || stoppedTail)) {
                replayNeeded = true;
                continue;
            }
            video.muted = Boolean(runtime.settings.muted);
            try {
                video.playbackRate = runtime.settings.playbackRate;
                if (video.paused && runtime.settings.autoplay && !video.ended) {
                    if (platformPlayer && videos.length === 1) await Promise.resolve(platformPlayer.play());
                    else await video.play();
                }
                startAudioCapture(video);
                const signature = key;
                if (runtime.lastMediaSignature !== signature) {
                    runtime.lastMediaSignature = signature;
                    log(`已接管课件播放器，当前时长 ${Number.isFinite(video.duration) ? Math.round(video.duration) : 0} 秒`);
                }
            } catch (error) {
                const key = video.currentSrc || 'video';
                const retry = (runtime.retries.get(key) || 0) + 1;
                runtime.retries.set(key, retry);
                log(`视频自动播放失败（${retry}/${runtime.settings.maxRetries}）：${error.message}`, retry >= runtime.settings.maxRetries ? 'error' : 'warn');
                if (retry >= runtime.settings.maxRetries) runtime.state = 'ERROR';
            }
        }
        return { found: true, complete: allComplete, replayNeeded, key: mediaKeys.join('|') };
    }

    function canAdvanceLesson(videoState) {
        if (!videoState.complete || !videoState.key) {
            runtime.completedMediaKey = '';
            runtime.completedMediaAt = 0;
            return false;
        }
        if (runtime.completedMediaKey !== videoState.key) {
            runtime.completedMediaKey = videoState.key;
            runtime.completedMediaAt = Date.now();
        }
        if (runtime.advancedMediaKey === videoState.key) return false;
        const progress = activeLessonProgress();
        const hasCatalog = sameOriginDocuments().some((doc) => doc.querySelector('.videoNavBox, .course-tree, #coursetree, [class*="posCatalog"], [class*="catalog" i]'));
        if ((progress !== null && progress < 100) || (progress === null && hasCatalog)) {
            const warningKey = `${videoState.key}:${progress}`;
            if (runtime.progressWarningKey !== warningKey) {
                runtime.progressWarningKey = warningKey;
                log(progress === null ? '视频已结束，但尚未读到当前章节的完成进度，保留本章等待平台确认'
                    : `视频已结束，但平台当前章节进度为 ${progress}%，保留本章等待记录完成`, 'warn');
            }
            return false;
        }
        return Date.now() - runtime.completedMediaAt >= runtime.settings.postVideoGraceMs;
    }

    async function replayIncompleteLesson(videoState) {
        const row = cwsActiveLesson();
        const progress = activeLessonProgress();
        if (!row || !runtime.settings.autoplay || (!videoState.complete && !videoState.replayNeeded) || progress === null || progress >= 100) return false;
        if (runtime.completedMediaKey !== videoState.key) {
            runtime.completedMediaKey = videoState.key;
            runtime.completedMediaAt = Date.now();
        }
        // Give the final platform record time to arrive before starting a real replay.
        const grace = Math.max(10000, runtime.settings.postVideoGraceMs);
        if (Date.now() - runtime.completedMediaAt < grace || Date.now() - runtime.lastReplayAt < grace) return false;
        const video = findVideos().find((item) => item.closest('#J_prismPlayer'));
        if (!video) return false;
        const context = getPlaybackContext(video);
        const blocker = playbackBlocker(context.owner);
        if (blocker) {
            const warningKey = `${videoState.key}:replay:${blocker}`;
            if (runtime.progressWarningKey !== warningKey) {
                runtime.progressWarningKey = warningKey;
                log(`本节重播等待：${blocker}`, 'warn');
            }
            return false;
        }
        if (detectExamPage().matched) return false;
        runtime.lastReplayAt = Date.now();
        const contextKey = runtime.studyContextKey;
        const state = bindVideo(video);
        state.replayPending = true;
        try {
            // The site's play callback seeks to owner.seekTime. Reset that playback anchor first.
            // Accumulated learning records and all platform verification flags remain untouched.
            if (context.owner && typeof context.owner.seekTime === 'number') {
                context.owner.seekTime = 0;
                if ('chartStartTime' in context.owner) context.owner.chartStartTime = null;
            }
            if (context.player && typeof context.player.seek === 'function') context.player.seek(0);
            video.currentTime = 0;
            let playError = null;
            const request = context.player ? context.player.play() : video.play();
            Promise.resolve(request).catch((error) => { playError = error; });
            // Also accommodate simple native players whose play callback restores a saved time.
            if (!context.owner) video.currentTime = 0;
            let playingSamples = 0;
            for (let attempt = 0; attempt < 24; attempt += 1) {
                if (runtime.studyContextKey !== contextKey || !video.isConnected || cwsActiveLesson()?.id !== row.id || detectExamPage().matched || !runtime.settings.enabled) return false;
                if (playError) throw playError;
                if (!video.paused && !video.ended && video.currentTime < video.duration - 0.75) playingSamples += 1;
                else playingSamples = 0;
                if (playingSamples >= 2) break;
                await new Promise((resolve) => root.setTimeout(resolve, 125));
            }
            if (playingSamples < 2) throw new Error('播放器尚未确认恢复播放');
            state.fresh = true;
            state.endedLogged = false;
            state.replayPending = false;
            runtime.completedMediaKey = '';
            runtime.completedMediaAt = 0;
            runtime.progressWarningKey = '';
            runtime.state = 'PLAYING';
            log(`本节到结尾但平台进度仅 ${progress}%，已从头重播：${cwsLessonTitle(row)}`);
            return true;
        } catch (error) {
            log(`本节重播暂未恢复，将保留当前章节并重试：${error.message}`, 'warn');
            return false;
        }
    }

    const ALLOWED_DIALOG_TEXT = [
        '继续学习', '继续播放', '我知道了', '确定继续', '确认继续', '关闭提示', '稍后再说'
    ];

    function clickAllowedDialog() {
        if (!runtime.settings.autoResumeDialogs) return false;
        const candidates = sameOriginDocuments().flatMap((doc) => [...doc.querySelectorAll('button, a, [role="button"], input[type="button"]')]).filter(isVisible);
        for (const candidate of candidates) {
            const text = String(candidate.innerText || candidate.value || '').replace(/\s+/g, '').trim();
            if (candidate.closest('.playNext-modal, [class*="playNext" i]')) continue;
            const dialog = candidate.closest('.ivu-modal-wrap, .ivu-modal, [role="dialog"], .modal, .dialog');
            if (dialog && /(当前章节.*播放完毕|播放下一章节)/.test(dialog.innerText || '')) continue;
            if (['继续学习', '继续播放'].includes(text) && (!dialog || findVideos().some((video) => video.ended))) continue;
            if (ALLOWED_DIALOG_TEXT.some((allowed) => text === allowed.replace(/\s+/g, ''))) {
                candidate.click();
                log(`已处理普通提示：${text}`);
                runtime.lastProgressAt = Date.now();
                return true;
            }
        }
        return false;
    }

    const QUIZ_CONTINUE_TEXT = [
        '继续看课', '继续观看', '继续课程', '返回课程', '返回学习', '继续播放', '关闭练习', '下一题'
    ];
    const QUIZ_EXPLANATION_TEXT = ['查看解析', '查看答案解析'];

    function compactControlText(element) {
        return String(element?.innerText || element?.value || element?.getAttribute?.('title') || '')
            .replace(/\s+/g, '')
            .trim();
    }

    function isDisabledControl(element) {
        return Boolean(element?.disabled || element?.getAttribute?.('aria-disabled') === 'true' || element?.classList?.contains('disabled'));
    }

    function quizFollowupScope(element) {
        return element.closest('.preview-modal, .recording-modal-box, .ivu-modal-wrap, .ivu-modal, [role="dialog"], .modal, .dialog, .question-item, .questionBox, .quiz-question');
    }

    function hasAnsweredQuizSignal(scope) {
        if (!scope) return false;
        const text = String(scope.innerText || '').replace(/\s+/g, '');
        if (/(回答正确|回答错误|答案正确|答案错误|回答对了|答对|答错|正确答案|本题解析)/.test(text)) return true;
        if (scope.querySelector('.pass, .fail, .correct-answer, .right-answer, .analysis, .explanation, [class*="correct-answer" i], [class*="right-answer" i], [class*="analysis" i], [class*="explain" i]')) return true;
        const choices = [...scope.querySelectorAll('input[type="radio"], input[type="checkbox"]')];
        return choices.length > 0 && choices.every((choice) => choice.disabled || choice.getAttribute('aria-disabled') === 'true');
    }

    function clickCourseQuizFollowup() {
        if (!runtime.settings.autoResumeDialogs) return false;
        const candidates = sameOriginDocuments()
            .flatMap((doc) => [...doc.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"], .ivu-btn')])
            .filter((element) => isVisible(element) && !isDisabledControl(element) && !runtime.handledQuizFollowups.has(element));
        const actions = candidates.map((element) => ({ element, text: compactControlText(element), scope: quizFollowupScope(element) }));

        const continuation = actions.find(({ text, scope }) => scope && QUIZ_CONTINUE_TEXT.includes(text) && (text === '继续看课' || hasAnsweredQuizSignal(scope)));
        const explanation = actions.find(({ text, scope }) => scope && QUIZ_EXPLANATION_TEXT.includes(text) && hasAnsweredQuizSignal(scope));
        const action = continuation || explanation;
        if (!action) return false;

        runtime.handledQuizFollowups.add(action.element);
        action.element.click();
        runtime.state = action === explanation ? 'VERIFYING' : 'PLAYING';
        runtime.lastProgressAt = Date.now();
        log(action === explanation ? `已打开随堂题解析：${action.text}` : `已完成随堂题并恢复课程：${action.text}`);
        return true;
    }

    function clickPlatformNextDialog(videoState) {
        if (runtime.mode === 'ASSESSMENT') return false;
        if (!runtime.settings.autoAdvance || !canAdvanceLesson(videoState)) return false;
        for (const doc of sameOriginDocuments()) {
            const prompts = [...doc.querySelectorAll('.playNext-modal, [class*="playNext" i]')].filter(isVisible);
            for (const prompt of prompts) {
                const scope = prompt.closest('.ivu-modal-wrap, .ivu-modal, [role="dialog"], .modal, .dialog') || prompt.parentElement;
                if (!scope || !/(当前章节.*播放完毕|播放下一章节)/.test(scope.innerText || '')) continue;
                const button = [...scope.querySelectorAll('button, [role="button"]')]
                    .find((item) => isVisible(item) && /^播放$/.test(String(item.innerText || '').trim()));
                if (!button) continue;
                button.click();
                runtime.advancedMediaKey = videoState.key;
                runtime.state = 'ADVANCING';
                runtime.lastProgressAt = Date.now();
                runtime.processedQuestions.clear();
                log('已确认播放下一章节');
                return true;
            }
        }
        return false;
    }

    const QUESTION_SELECTORS = [
        '.question-item', '.question', '.subject-item', '.test-question', '.topic-item', '.quiz-question',
        '.recording-modal-box', '.preview-modal .ivu-modal-body', '.questionBox',
        '[data-question-id]', '[data-subject-id]', '[class*="question-item" i]', '[class*="subject-item" i]'
    ];

    function usableChoiceInput(input) {
        if (!input?.isConnected) return false;
        const label = input.closest('label') || input.parentElement;
        return isVisible(input) || isVisible(label);
    }

    function findQuestionNodes() {
        const explicit = uniqueElements(QUESTION_SELECTORS.flatMap((selector) => [...root.document.querySelectorAll(selector)]))
            .filter((node) => isVisible(node) && node.querySelector('input[type="radio"], input[type="checkbox"], textarea, input[type="text"], .question-options .question-option'));
        if (explicit.length) {
            return explicit.filter((node, index, all) => !all.some((other, otherIndex) => otherIndex !== index && node.contains(other)));
        }
        const groups = [];
        const seenNames = new Set();
        for (const input of root.document.querySelectorAll('input[type="radio"], input[type="checkbox"]')) {
            if (!usableChoiceInput(input)) continue;
            const name = input.name || input.getAttribute('data-name') || input.id;
            if (seenNames.has(name)) continue;
            seenNames.add(name);
            const node = input.closest('li, .form-group, .topic, .question, .subject, fieldset, [role="group"]');
            if (node) groups.push(node);
        }
        return uniqueElements(groups);
    }

    function labelForInput(input, container) {
        if (input.id) {
            try {
                const label = container.querySelector(`label[for="${CSS.escape(input.id)}"]`);
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
        const inputs = [...container.querySelectorAll('input[type="radio"], input[type="checkbox"]')].filter(usableChoiceInput);
        const textInputs = [...container.querySelectorAll('textarea, input[type="text"]')].filter(isVisible);
        const inputOptions = inputs.map((input, index) => {
            const label = labelForInput(input, container);
            const text = String(label?.innerText || input.getAttribute('data-text') || input.value || '').trim();
            return { key: String.fromCharCode(65 + index), text, value: input.value, input, clickTarget: input, controlType: 'input' };
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
            : options.length ? (/判断/.test(typeLabel) || /正确|错误|对|错/.test(options.map((item) => item.text).join('')) ? '判断题' : '单选题')
                : textInputs.length ? '填空题' : '未知题型';
        const { course, chapter } = extractCourseInfo();
        return {
            container,
            course,
            chapter,
            unit: chapter,
            type,
            stem,
            options,
            textInputs,
            fingerprint: questionFingerprint(course, stem, options),
            pageUrl: `${root.location.origin}${root.location.pathname}`
        };
    }

    function isOptionSelected(option) {
        if (option.input) return Boolean(option.input.checked);
        const element = option.element || option.clickTarget;
        return Boolean(element?.classList.contains('correct') || element?.classList.contains('selected')
            || element?.querySelector('.correct, .selected, .ivu-radio-checked, .ivu-checkbox-checked'));
    }

    function isOptionLocked(option) {
        if (option.input) return Boolean(option.input.disabled);
        const element = option.element || option.clickTarget;
        return Boolean(element?.classList.contains('disabled') || element?.getAttribute('aria-disabled') === 'true');
    }

    function loadAnswerBank() {
        const bank = gmGet(ANSWER_BANK_KEY, []);
        return Array.isArray(bank) ? bank : [];
    }

    function matchAnswerBank(question) {
        const bank = loadAnswerBank();
        const normalizedStem = normalizeText(question.stem);
        const entry = bank.find((item) => item.fingerprint === question.fingerprint)
            || bank.find((item) => normalizeText(item.stem) === normalizedStem)
            || bank.find((item) => item.stemIncludes && normalizedStem.includes(normalizeText(item.stemIncludes)));
        if (!entry) return null;
        return {
            answers: Array.isArray(entry.answers) ? entry.answers : [entry.answer].filter(Boolean),
            answerTexts: Array.isArray(entry.answerTexts) ? entry.answerTexts : [],
            explanation: entry.explanation || '',
            source: entry.source || '本地答案表',
            confidence: Number(entry.confidence ?? 1)
        };
    }

    function extractJsonObject(text) {
        const source = String(text || '').replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
        const start = source.indexOf('{');
        const end = source.lastIndexOf('}');
        if (start < 0 || end <= start) return null;
        try { return JSON.parse(source.slice(start, end + 1)); } catch (_) { return null; }
    }

    function assistantServiceBaseUrl() {
        try {
            const url = new URL(runtime.settings.assistantServiceUrl || 'http://127.0.0.1:8766');
            if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) throw new Error('辅助服务必须位于本机');
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('辅助服务协议无效');
            return url.toString().replace(/\/$/, '');
        } catch (error) {
            throw new Error(`辅助服务地址无效：${error.message}`);
        }
    }

    function serviceRequest(pathname, body = null, method = 'POST') {
        const url = `${assistantServiceBaseUrl()}${pathname}`;
        const headers = { 'X-FZUGK-Token': runtime.settings.assistantServiceToken || '' };
        if (body != null) headers['Content-Type'] = 'application/json';
        const parse = (text, value) => {
            if (value && typeof value === 'object') return value;
            try { return JSON.parse(text || '{}'); } catch (_) { throw new Error('辅助服务返回了无效 JSON'); }
        };
        if (typeof GM_xmlhttpRequest === 'function') {
            return new Promise((resolve, reject) => {
                const request = GM_xmlhttpRequest({
                    method,
                    url,
                    headers,
                    data: body == null ? undefined : JSON.stringify(body),
                    responseType: 'json',
                    timeout: 35000,
                    onload: (response) => {
                        runtime.activeServiceRequest = null;
                        try {
                            const data = parse(response.responseText, response.response);
                            if (response.status < 200 || response.status >= 300 || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
                            resolve(data);
                        } catch (error) { reject(error); }
                    },
                    ontimeout: () => { runtime.activeServiceRequest = null; reject(new Error('辅助服务请求超时')); },
                    onerror: () => { runtime.activeServiceRequest = null; reject(new Error('无法连接本地辅助服务')); },
                    onabort: () => { runtime.activeServiceRequest = null; reject(new Error('辅助服务请求已取消')); }
                });
                runtime.activeServiceRequest = request;
            });
        }
        return fetch(url, { method, headers, body: body == null ? undefined : JSON.stringify(body) })
            .then(async (response) => {
                const data = parse(await response.text());
                if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
                return data;
            });
    }

    function currentVideoTime() {
        const video = findVideos()[0];
        return Number.isFinite(video?.currentTime) ? Math.round(video.currentTime) : null;
    }

    function collectMaterialSnippets() {
        if (!runtime.settings.courseMaterialRetrieval) return [];
        const { course, chapter } = extractCourseInfo();
        const selectors = [
            '.brief.handout', '.handout', '[class*="handout" i]', '.knowledge-points', '.knowledge-points-list li',
            '[class*="knowledge-point" i]', '.subtitle', '.caption', '[class*="subtitle" i]', '[class*="caption" i]'
        ];
        const items = [];
        const seen = new Set();
        for (const doc of sameOriginDocuments()) {
            for (const selector of selectors) {
                for (const element of doc.querySelectorAll(selector)) {
                    if (!isVisible(element)) continue;
                    const text = String(element.innerText || element.textContent || '').replace(/\s+/g, ' ').trim();
                    if (text.length < 12 || seen.has(normalizeText(text))) continue;
                    seen.add(normalizeText(text));
                    const title = String(element.querySelector?.('.title, h1, h2, h3, h4')?.innerText || selector).trim();
                    const timeText = String(element.innerText || '').match(/(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\s*[-~至]\s*(\d{1,2}):([0-5]\d)(?::([0-5]\d))?/);
                    const toSeconds = (h, m, s) => s == null ? Number(h) * 60 + Number(m) : Number(h) * 3600 + Number(m) * 60 + Number(s);
                    items.push({
                        course,
                        chapter,
                        type: /subtitle|caption/i.test(selector) ? '字幕' : /handout/i.test(selector) ? '讲义' : '知识点',
                        title: title.slice(0, 300),
                        text: text.slice(0, 12000),
                        startTime: timeText ? toSeconds(timeText[1], timeText[2], timeText[3]) : null,
                        endTime: timeText ? toSeconds(timeText[4], timeText[5], timeText[6]) : null,
                        url: `${root.location.origin}${root.location.pathname}`
                    });
                }
            }
            for (const video of doc.querySelectorAll('video')) {
                try {
                    for (const track of video.textTracks || []) {
                        for (const cue of track.cues || []) {
                            const text = String(cue.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                            if (!text || seen.has(normalizeText(text))) continue;
                            seen.add(normalizeText(text));
                            items.push({ course, chapter, type: '字幕', title: track.label || '视频字幕', text, startTime: cue.startTime, endTime: cue.endTime, url: `${root.location.origin}${root.location.pathname}` });
                        }
                    }
                } catch (_) {}
            }
        }
        items.push(...runtime.transcriptItems.slice(-30));
        return items.slice(0, 100);
    }

    async function syncCourseMaterials(force = false) {
        if (!runtime.settings.assistantServiceEnabled || !runtime.settings.assistantServiceToken || !runtime.settings.courseMaterialRetrieval) return;
        const items = collectMaterialSnippets();
        if (!items.length) return;
        const key = fnv1a(items.map((item) => `${item.chapter}|${item.type}|${normalizeText(item.text)}`).join('\n'));
        if (!force && (key === runtime.lastMaterialSyncKey || Date.now() - runtime.materialSyncAt < 30000)) return;
        await serviceRequest('/api/materials/upsert', { items });
        runtime.lastMaterialSyncKey = key;
        runtime.materialSyncAt = Date.now();
        log(`已同步 ${items.length} 条课程资料`);
    }

    function captureCurrentVideoFrame() {
        if (!runtime.settings.visualRecognition) return '';
        const video = findVideos()[0];
        if (!video || !video.videoWidth || !video.videoHeight) return '';
        try {
            const scale = Math.min(1, 960 / video.videoWidth);
            const canvas = root.document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
            canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
            canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
            return canvas.toDataURL('image/jpeg', 0.72);
        } catch (error) {
            log(`课件画面读取失败：${error.message}`, 'warn');
            return '';
        }
    }

    function bytesToBase64(bytes) {
        let binary = '';
        const chunkSize = 0x8000;
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return root.btoa(binary);
    }

    function stopAudioCapture() {
        const capture = runtime.audioCapture;
        runtime.audioCapture = null;
        if (!capture) return;
        try { if (capture.recorder?.state !== 'inactive') capture.recorder.stop(); } catch (_) {}
        try { capture.stream?.getTracks().forEach((track) => track.stop()); } catch (_) {}
    }

    function cancelPendingAssistantWork() {
        runtime.answerGeneration += 1;
        try { runtime.activeServiceRequest?.abort?.(); } catch (_) {}
        runtime.activeServiceRequest = null;
        stopAudioCapture();
    }

    function startAudioCapture(video) {
        if (!runtime.settings.audioTranscription || !runtime.settings.assistantServiceEnabled || !runtime.settings.assistantServiceToken) return;
        if (runtime.audioCapture?.video === video && runtime.audioCapture.recorder?.state !== 'inactive') return;
        stopAudioCapture();
        try {
            const captureStream = video.captureStream || video.mozCaptureStream;
            if (typeof captureStream !== 'function' || typeof root.MediaRecorder !== 'function') throw new Error('浏览器或播放器不支持媒体流捕获');
            const sourceStream = captureStream.call(video);
            const tracks = sourceStream.getAudioTracks().map((track) => track.clone());
            if (!tracks.length) throw new Error('课件媒体流中没有可捕获的音轨');
            const stream = new root.MediaStream(tracks);
            const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((type) => root.MediaRecorder.isTypeSupported?.(type));
            const recorder = new root.MediaRecorder(stream, preferred ? { mimeType: preferred } : undefined);
            const { course, chapter } = extractCourseInfo();
            recorder.addEventListener('dataavailable', async (event) => {
                if (!event.data || event.data.size < 1024 || runtime.audioTranscribing) return;
                runtime.audioTranscribing = true;
                const endTime = Number.isFinite(video.currentTime) ? video.currentTime : null;
                const startTime = endTime == null ? null : Math.max(0, endTime - runtime.settings.audioChunkSeconds);
                try {
                    const bytes = new Uint8Array(await event.data.arrayBuffer());
                    const data = await serviceRequest('/api/transcribe', {
                        audioBase64: bytesToBase64(bytes),
                        mimeType: event.data.type || preferred || 'audio/webm',
                        fileName: `course-${Date.now()}.webm`
                    });
                    const text = String(data.text || '').replace(/\s+/g, ' ').trim();
                    if (text) {
                        runtime.transcriptItems.push({ course, chapter, type: '音频转录', title: '课件音频', text, startTime, endTime, url: `${root.location.origin}${root.location.pathname}` });
                        runtime.transcriptItems = runtime.transcriptItems.slice(-200);
                        await syncCourseMaterials(true);
                        log(`已转录课件片段：${text.slice(0, 24)}${text.length > 24 ? '…' : ''}`);
                    }
                } catch (error) {
                    log(`课件音频转录失败：${error.message}`, 'warn');
                } finally { runtime.audioTranscribing = false; }
            });
            recorder.addEventListener('error', (event) => log(`音频捕获错误：${event.error?.message || '未知错误'}`, 'warn'));
            recorder.start(Math.max(5000, Number(runtime.settings.audioChunkSeconds) * 1000 || 20000));
            runtime.audioCapture = { video, recorder, stream };
            log('已启动课件音频分段转录');
        } catch (error) {
            runtime.settings.audioTranscription = false;
            gmSet(SETTINGS_KEY, runtime.settings);
            log(`音频转录不可用，已关闭：${error.message}`, 'warn');
        }
    }

    async function matchVerifiedArchive(question) {
        try {
            const records = await getArchivedQuestions(question.course);
            const record = records.find((item) => item.fingerprint === question.fingerprint && item.result === '正确' && !item.conflict);
            if (!record) return null;
            return {
                answers: record.submittedAnswer || [],
                answerTexts: record.submittedAnswerTexts || [],
                explanation: record.explanation || '',
                source: '本机平台已验证题库',
                confidence: 1,
                evidence: ['平台历史正确判定'],
                citations: []
            };
        } catch (_) { return null; }
    }

    async function askAssistantService(question) {
        const settings = runtime.settings;
        if (!settings.assistantServiceEnabled || !settings.assistantServiceToken) return null;
        try {
            await syncCourseMaterials(true);
            const data = await serviceRequest('/api/answer', {
                question: {
                    fingerprint: question.fingerprint,
                    course: question.course,
                    chapter: question.chapter,
                    type: question.type,
                    stem: question.stem,
                    options: question.options.map((item) => ({ key: item.key, text: item.text })),
                    videoTime: currentVideoTime()
                },
                materials: collectMaterialSnippets(),
                imageDataUrl: captureCurrentVideoFrame(),
                webSearchMode: settings.webSearchMode
            });
            if (!data.resolved) {
                log(`辅助服务未能解答：${data.reason || '证据不足'}`, 'warn');
                return null;
            }
            if (settings.requireEvidence && !data.evidence?.length && !data.citations?.length && !/已验证/.test(data.source || '')) {
                log('辅助服务答案缺少可核验证据', 'warn');
                return null;
            }
            return {
                answers: Array.isArray(data.answers) ? data.answers : [],
                answerTexts: Array.isArray(data.answerTexts) ? data.answerTexts : [],
                explanation: data.explanation || '',
                source: data.source || 'AI + 课程资料',
                confidence: Number(data.confidence || 0),
                evidence: Array.isArray(data.evidence) ? data.evidence : [],
                citations: Array.isArray(data.citations) ? data.citations : []
            };
        } catch (error) {
            log(`辅助服务请求失败：${error.message}`, 'warn');
            return null;
        }
    }

    async function resolveAnswer(question) {
        return solveArithmeticQuestion(question)
            || matchAnswerBank(question)
            || await matchVerifiedArchive(question)
            || await askAssistantService(question);
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
        return {
            answers: [],
            answerTexts: [String(value)],
            correctAnswer: String(value),
            explanation: `${left} ${operation} ${right} = ${value}`,
            source: '页面算术题自动计算',
            confidence: 1
        };
    }

    function applyAnswer(question, answer) {
        if (question.options.length) {
            const wantedKeys = new Set((answer.answers || []).map((value) => String(value).trim().toUpperCase()));
            const wantedTexts = new Set((answer.answerTexts || []).map(normalizeText));
            const matches = question.options.filter((option) => wantedKeys.has(option.key)
                || wantedKeys.has(String(option.value).trim().toUpperCase())
                || wantedTexts.has(normalizeText(option.text)));
            if (!matches.length) return { applied: false, reason: '答案无法匹配页面选项' };
            if (question.type !== '多选题' && matches.length !== 1) return { applied: false, reason: '单选题答案数量异常' };
            for (const option of question.options) {
                const shouldSelect = matches.includes(option);
                const selected = isOptionSelected(option);
                if (selected !== shouldSelect) {
                    if (!shouldSelect && question.type !== '多选题') continue;
                    option.clickTarget?.click();
                }
            }
            const verified = matches.every(isOptionSelected)
                && question.options.filter((option) => !matches.includes(option)).every((option) => !isOptionSelected(option) || option.input?.type === 'radio');
            return { applied: verified, selected: matches.map((option) => option.key), selectedTexts: matches.map((option) => option.text), reason: verified ? '' : '页面选择状态校验失败' };
        }
        const textAnswers = (answer.answerTexts?.length ? answer.answerTexts : answer.answers || []).map((item) => String(item).trim()).filter(Boolean);
        if (question.textInputs.length && textAnswers.length) {
            const values = question.textInputs.length === 1 ? [textAnswers.join('；')] : textAnswers;
            if (values.length < question.textInputs.length) return { applied: false, reason: '文字答案数量少于输入框数量' };
            for (let index = 0; index < question.textInputs.length; index += 1) {
                const input = question.textInputs[index];
                const value = values[index];
                const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
                if (setter) setter.call(input, value); else input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const verified = question.textInputs.every((input, index) => input.value === values[index]);
            return { applied: verified, selected: values, selectedTexts: values, reason: verified ? '' : '文字答案写入校验失败' };
        }
        return { applied: false, reason: '题型暂不支持自动填写' };
    }

    function findSubmitButton(question) {
        const scopes = [question.container, question.container.closest('.ivu-modal-wrap, .ivu-modal, .modal, .dialog, .task, .quiz, form'), root.document].filter(Boolean);
        for (const scope of scopes) {
            const candidates = [...scope.querySelectorAll('button, a[role="button"], input[type="button"], input[type="submit"]')].filter(isVisible);
            const button = candidates.find((item) => {
                const text = String(item.innerText || item.value || '').replace(/\s+/g, '');
                if (/(提交试卷|交卷|结束考试)/.test(text)) return false;
                return /^(提交|确定|确认|完成|提交答案|确认答案|下一题)$/.test(text);
            });
            if (button) return button;
        }
        return null;
    }

    function extractResult(question) {
        const connectedScope = question.container.isConnected
            ? question.container.closest('.ivu-modal-wrap, .ivu-modal, .modal, .dialog, .task, .quiz, form') || question.container
            : null;
        const scopes = [connectedScope, root.document.querySelector('.ivu-message, .ivu-notice, .message, .toast')]
            .filter((scope) => scope && !scope.closest?.(`#${SCRIPT_ID}-panel`));
        const text = scopes.map((scope) => String(scope.innerText || '')).join(' ');
        let result = '未知';
        if (/(回答正确|答案正确|回答对了|恭喜.*正确)/.test(text) && !/(回答错误|答案错误)/.test(text)) result = '正确';
        if (/(回答错误|答案错误|回答有误|答案有误|作答有误|回答不对|回答错了|答错|不正确)/.test(text)) result = '错误';
        if (scopes.some((scope) => scope.querySelector?.('.pass')) && !scopes.some((scope) => scope.querySelector?.('.fail'))) result = '正确';
        if (scopes.some((scope) => scope.querySelector?.('.fail'))) result = '错误';
        const findInScopes = (selector) => scopes.map((scope) => scope.querySelector?.(selector)).find(Boolean);
        const correctElement = findInScopes('.correct-answer, .right-answer, [class*="correct-answer" i], [class*="right-answer" i]');
        const analysisElement = findInScopes('.analysis, .explanation, .question-analysis-content-preview, [class*="analysis" i], [class*="explain" i]');
        const inlineCorrectAnswer = text.match(/正确答案(?:是|为)?\s*[：:]?\s*([A-ZＡ-Ｚ](?:\s*[,，、;；/]?\s*[A-ZＡ-Ｚ])*)/i)?.[1] || '';
        return {
            result,
            correctAnswer: String(correctElement?.innerText || inlineCorrectAnswer).replace(/^.*?[：:]/, '').trim(),
            platformExplanation: String(analysisElement?.innerText || '').trim()
        };
    }

    function platformAnswerKeys(question, correctAnswer) {
        const available = new Set(question.options.map((option) => option.key.toUpperCase()));
        const raw = String(correctAnswer || '').replace(/[Ａ-Ｚ]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 65248)).trim();
        const answerPart = raw.replace(/^.*?正确答案(?:是|为)?\s*[：:]?\s*/i, '').split(/(?:答案解析|本题解析|解析[：:]|\n)/)[0].trim();
        const keysOnly = answerPart.match(/^([A-Z](?:\s*[,，、;；/\s]?\s*[A-Z])*)\s*[。.!！]?$/i);
        if (keysOnly) return [...new Set(keysOnly[1].toUpperCase().match(/[A-Z]/g) || [])].filter((key) => available.has(key));
        const normalized = normalizeText(answerPart);
        const textMatches = question.options.filter((option) => normalizeText(option.text) === normalized);
        return textMatches.length === 1 ? [textMatches[0].key] : [];
    }

    function findRetryButton(question) {
        const retryText = /^(重新作答|重新答题|再答一次|重新选择|重做)$/;
        const preferredScope = question.container.isConnected
            ? question.container.closest('.preview-modal, .recording-modal-box, .ivu-modal-wrap, .ivu-modal, [role="dialog"], .modal, .dialog, .task, .quiz, form')
            : null;
        const scopes = [preferredScope, ...sameOriginDocuments()].filter(Boolean);
        for (const scope of scopes) {
            const standardControls = [...scope.querySelectorAll('button, a, [role="button"], input[type="button"], .ivu-btn')];
            const textControls = [...scope.querySelectorAll('span, div')];
            const matched = [...standardControls, ...textControls]
                .find((element) => isVisible(element) && !isDisabledControl(element) && retryText.test(compactControlText(element)));
            if (!matched) continue;
            return matched.closest('button, a, [role="button"], .ivu-btn') || matched;
        }
        return null;
    }

    function skipPlatformCorrection(question, reason) {
        runtime.processedQuestions.add(question.fingerprint);
        runtime.lastProgressAt = Date.now();
        log(`${reason}，已记录错题并继续课程`, 'warn');
    }

    function findActiveQuestion(original) {
        const candidates = findQuestionNodes().map(parseQuestion).filter((candidate) => candidate.options.length);
        const stem = normalizeText(original.stem);
        const matching = candidates.filter((candidate) => candidate.fingerprint === original.fingerprint
            || (stem && normalizeText(candidate.stem) === stem));
        const relevant = matching.length ? matching
            : candidates.filter((candidate) => candidate.container === original.container);
        return relevant.find((candidate) => candidate.options.every((option) => !isOptionLocked(option))
            && findSubmitButton(candidate)) || relevant[0] || null;
    }

    function readyForPlatformCorrection(question) {
        return Boolean(question?.options.length && question.options.every((option) => !isOptionLocked(option))
            && findSubmitButton(question));
    }

    function selectedKeys(question) {
        return question.options.filter(isOptionSelected).map((option) => option.key).sort();
    }

    function correctionKey(question) {
        return `${normalizeText(question.course)}::${normalizeText(question.stem)}`;
    }

    async function selectPlatformChoices(original, keys) {
        const wanted = [...keys].sort().join(',');
        for (let pass = 0; pass < 3; pass += 1) {
            let current = findActiveQuestion(original);
            if (!readyForPlatformCorrection(current)) return { applied: false, reason: '重做题目尚未进入可选状态' };
            for (const key of current.options.map((option) => option.key)) {
                current = findActiveQuestion(original);
                const option = current?.options.find((item) => item.key === key);
                if (!option) return { applied: false, reason: `重做页面选项 ${key} 已变化` };
                const shouldSelect = keys.includes(key);
                if (isOptionSelected(option) === shouldSelect) continue;
                const label = option.input ? labelForInput(option.input, current.container) : null;
                const target = label?.tagName === 'LABEL' ? label : option.clickTarget;
                target?.click();
                await new Promise((resolve) => root.setTimeout(resolve, 250));
                current = findActiveQuestion(original);
                const refreshed = current?.options.find((item) => item.key === key);
                if (refreshed && isOptionSelected(refreshed) !== shouldSelect && option.input && target !== option.input) {
                    refreshed.input?.click();
                    await new Promise((resolve) => root.setTimeout(resolve, 250));
                }
            }
            await new Promise((resolve) => root.setTimeout(resolve, 500));
            current = findActiveQuestion(original);
            if (current && selectedKeys(current).join(',') === wanted) {
                const matches = current.options.filter((option) => keys.includes(option.key));
                return { applied: true, question: current, selected: keys, selectedTexts: matches.map((option) => option.text), reason: '' };
            }
        }
        const current = findActiveQuestion(original);
        return { applied: false, reason: `页面最终仅选中 ${current ? selectedKeys(current).join('、') || '无' : '未知'}` };
    }

    function correctionContinueButton(question) {
        const scope = question.container.closest('.preview-modal, .recording-modal-box, .ivu-modal-wrap, .ivu-modal, .modal, .dialog') || question.container;
        const candidates = [scope, ...sameOriginDocuments()];
        for (const candidate of candidates) {
            const button = [...candidate.querySelectorAll('button, a, [role="button"], input[type="button"]')]
                .find((element) => isVisible(element) && !isDisabledControl(element)
                    && QUIZ_CONTINUE_TEXT.includes(compactControlText(element)));
            if (button) return button;
        }
        return null;
    }

    async function correctFromPlatformAnswer(question, result) {
        if (result.result !== '错误' || !result.correctAnswer || detectExamPage().matched) return null;
        const keys = platformAnswerKeys(question, result.correctAnswer);
        if (!keys.length || (question.type !== '多选题' && keys.length !== 1)) {
            skipPlatformCorrection(question, `平台答案无法明确对应选项：${result.correctAnswer.slice(0, 100)}`);
            return null;
        }
        const signature = keys.slice().sort().join(',');
        const previousAttempt = runtime.correctionAttempts.get(correctionKey(question));
        if (previousAttempt?.signature === signature) {
            const retained = selectedKeys(question).join(',');
            if (retained === signature) {
                skipPlatformCorrection(question, `平台仍判定已实际选中的 ${keys.join('、')} 为错误`);
                return null;
            }
            if ((previousAttempt.count || 1) >= 3) {
                skipPlatformCorrection(question, `页面连续 3 次未保留平台答案，最后实际选中 ${retained || '无'}`);
                return null;
            }
            log(`平台公布 ${keys.join('、')}，但错误页实际保留 ${retained.replace(/,/g, '、') || '无'}；重新逐项作答`, 'warn');
        }
        let retry = null;
        for (let attempt = 0; attempt < 16; attempt += 1) {
            retry = findRetryButton(question);
            if (retry) break;
            await new Promise((resolve) => root.setTimeout(resolve, 250));
        }
        if (!retry) {
            skipPlatformCorrection(question, '已读到平台正确答案，但未找到“重新作答”控件');
            return null;
        }

        retry.click();
        runtime.pendingCorrection = { question, result, keys, signature, createdAt: Date.now() };
        let current = null;
        for (let attempt = 0; attempt < 16; attempt += 1) {
            await new Promise((resolve) => root.setTimeout(resolve, 250));
            current = findActiveQuestion(question);
            if (readyForPlatformCorrection(current)) break;
        }
        if (!readyForPlatformCorrection(current) || detectExamPage().matched) {
            if (!detectExamPage().matched) log('已点击“重新作答”，等待可作答弹窗完成重绘', 'warn');
            return null;
        }

        runtime.pendingCorrection = null;
        return await submitPlatformCorrection(question, result, keys, signature, current);
    }

    async function submitPlatformCorrection(question, result, keys, signature, current) {
        if (!assessmentMayAnswer(question)) return null;
        const platformAnswer = {
            answers: keys,
            answerTexts: [],
            explanation: result.platformExplanation,
            source: '平台公布正确答案',
            confidence: 1,
            evidence: ['平台错误反馈公布正确答案'],
            citations: []
        };
        const applied = await selectPlatformChoices(question, keys);
        if (!applied.applied) {
            log(`平台答案重新选择失败：${applied.reason}`, 'warn');
            runtime.pendingCorrection = { question, result, keys, signature, createdAt: Date.now() };
            return null;
        }
        current = applied.question;
        log(`已在重做题目中选中平台答案：${keys.join('、')}`);
        const submit = findSubmitButton(current);
        if (!submit || detectExamPage().matched) {
            if (!detectExamPage().matched) {
                log('重新选择平台答案后未找到提交按钮，等待页面更新', 'warn');
                runtime.pendingCorrection = { question, result, keys, signature, createdAt: Date.now() };
            }
            return null;
        }

        const feedbackScope = current.container.closest('.ivu-modal-wrap, .ivu-modal, .modal, .dialog, .task, .quiz, form') || current.container;
        const feedbackBeforeSubmit = String(feedbackScope.innerText || '');
        const continueBeforeSubmit = correctionContinueButton(current);
        const previousAttempt = runtime.correctionAttempts.get(correctionKey(question));
        runtime.correctionAttempts.set(correctionKey(question), { signature, count: (previousAttempt?.count || 0) + 1 });
        log(`已点击随堂题${compactControlText(submit) || '提交'}按钮，等待结果`);
        if (!assessmentMayAnswer(question)) return null;
        assessmentNoteSubmission();
        submit.click();
        let correctedResult = { result: '未知', correctAnswer: result.correctAnswer, platformExplanation: result.platformExplanation };
        let continued = false;
        for (let attempt = 0; attempt < 24; attempt += 1) {
            await new Promise((resolve) => root.setTimeout(resolve, 250));
            const continueButton = correctionContinueButton(current);
            if (String(feedbackScope.innerText || '') === feedbackBeforeSubmit
                && (!continueButton || continueButton === continueBeforeSubmit)) continue;
            const candidate = extractResult(current);
            if (continueButton) {
                correctedResult = candidate.result === '错误' ? { ...candidate, result: '未知' } : candidate;
                continueButton.click();
                log('已点击“继续看课”');
                continued = true;
                break;
            }
            if (candidate.result === '未知') continue;
            correctedResult = candidate;
            break;
        }
        if (correctedResult.result === '未知' && !continued) {
            runtime.pendingCorrection = { question, result, keys, signature, phase: 'submitted', current, applied, answer: platformAnswer, feedbackScope, feedbackBeforeSubmit, continueBeforeSubmit, createdAt: Date.now() };
            log('平台答案已提交，等待新的结果或“继续看课”按钮', 'warn');
        }
        if (correctedResult.result === '正确' || continued) runtime.correctionAttempts.delete(correctionKey(question));
        if (correctedResult.result === '错误') {
            const observed = findActiveQuestion(question) || current;
            const retained = selectedKeys(observed);
            log(`重新提交后的错误页实际保留选项：${retained.join('、') || '无'}`, 'warn');
            applied.selected = retained;
            applied.selectedTexts = observed.options.filter((option) => retained.includes(option.key)).map((option) => option.text);
        }
        log(`已按平台公布答案自动纠正并重新提交：${keys.join('、')}，结果：${correctedResult.result}`);
        return { question: current, answer: platformAnswer, applied, result: correctedResult, continued };
    }

    async function resumePendingCorrection() {
        const pending = runtime.pendingCorrection;
        if (!pending) return false;
        if (pending.phase === 'submitted') {
            const continueButton = correctionContinueButton(pending.current);
            if (String(pending.feedbackScope.innerText || '') === pending.feedbackBeforeSubmit
                && (!continueButton || continueButton === pending.continueBeforeSubmit)) return true;
            const candidate = extractResult(pending.current);
            if (candidate.result === '未知' && !continueButton) return true;
            runtime.pendingCorrection = null;
            const finalResult = continueButton && candidate.result === '错误' ? { ...candidate, result: '未知' } : candidate;
            if (continueButton) {
                continueButton.click();
                log('已点击“继续看课”');
            }
            await archiveQuestion(pending.current, pending.answer, pending.applied, finalResult)
                .catch((error) => log(`延迟纠错归档失败：${error.message}`, 'error'));
            if (finalResult.result === '正确' || continueButton) {
                runtime.processedQuestions.add(pending.question.fingerprint);
                runtime.processedQuestions.add(pending.current.fingerprint);
                runtime.correctionAttempts.delete(correctionKey(pending.question));
            }
            runtime.lastProgressAt = Date.now();
            return true;
        }
        const current = findActiveQuestion(pending.question);
        if (!readyForPlatformCorrection(current)) {
            if (!findQuestionNodes().length && Date.now() - pending.createdAt > 10000) {
                runtime.pendingCorrection = null;
                log('纠错弹窗已关闭，继续课程', 'warn');
                return false;
            }
            return true;
        }
        runtime.pendingCorrection = null;
        const correction = await submitPlatformCorrection(pending.question, pending.result, pending.keys, pending.signature, current);
        if (correction) {
            await archiveQuestion(correction.question, correction.answer, correction.applied, correction.result)
                .catch((error) => log(`延迟纠错归档失败：${error.message}`, 'error'));
            if (correction.result.result === '正确' || correction.continued) {
                runtime.processedQuestions.add(pending.question.fingerprint);
                runtime.processedQuestions.add(correction.question.fingerprint);
            }
            runtime.lastProgressAt = Date.now();
        }
        return true;
    }

    async function repairVisibleWrongQuestion() {
        if (!assessmentMayAnswer()) return false;
        for (const node of findQuestionNodes()) {
            const question = parseQuestion(node);
            if (runtime.processedQuestions.has(question.fingerprint)) continue;
            const result = extractResult(question);
            if (result.result !== '错误' || !result.correctAnswer) continue;
            const correction = await correctFromPlatformAnswer(question, result);
            if (correction) {
                await archiveQuestion(correction.question, correction.answer, correction.applied, correction.result)
                    .catch((error) => log(`可见错题纠错归档失败：${error.message}`, 'error'));
                if (correction.result.result === '正确' || correction.continued) {
                    runtime.processedQuestions.add(question.fingerprint);
                    runtime.processedQuestions.add(correction.question.fingerprint);
                }
                runtime.lastProgressAt = Date.now();
            }
            return true;
        }
        return false;
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            if (!root.indexedDB) return reject(new Error('浏览器不支持 IndexedDB'));
            const request = root.indexedDB.open(DB_NAME, DB_VERSION);
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(STORE_QUESTIONS)) {
                    const store = db.createObjectStore(STORE_QUESTIONS, { keyPath: 'id' });
                    store.createIndex('course', 'course', { unique: false });
                    store.createIndex('fingerprint', 'fingerprint', { unique: false });
                    store.createIndex('result', 'result', { unique: false });
                }
                if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META, { keyPath: 'key' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    function requestPromise(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function archiveQuestion(question, answer, applied, result) {
        if (!runtime.settings.archiveQuestions) return;
        const db = await openDatabase();
        const transaction = db.transaction(STORE_QUESTIONS, 'readwrite');
        const store = transaction.objectStore(STORE_QUESTIONS);
        const id = `${fnv1a(normalizeText(question.course))}-${question.fingerprint}`;
        const existing = await requestPromise(store.get(id));
        const historyEntry = {
            at: nowIso(),
            submittedAnswer: applied.selected || answer.answers || [],
            result: result.result,
            correctAnswer: result.correctAnswer || '',
            source: answer.source,
            confidence: answer.confidence
        };
        const record = {
            id,
            fingerprint: question.fingerprint,
            course: question.course,
            chapter: question.chapter,
            unit: question.unit,
            type: question.type,
            stem: question.stem,
            options: question.options.map((option) => ({ key: option.key, text: option.text })),
            submittedAnswer: applied.selected || answer.answers || [],
            submittedAnswerTexts: applied.selectedTexts || [],
            correctAnswer: result.correctAnswer || existing?.correctAnswer || '',
            result: result.result,
            explanation: result.platformExplanation || answer.explanation || existing?.explanation || '',
            answerSource: answer.source,
            confidence: answer.confidence,
            firstSeenAt: existing?.firstSeenAt || nowIso(),
            lastSeenAt: nowIso(),
            occurrences: (existing?.occurrences || 0) + 1,
            conflict: Boolean(existing && normalizeText(existing.correctAnswer) && normalizeText(result.correctAnswer) && normalizeText(existing.correctAnswer) !== normalizeText(result.correctAnswer)),
            history: [...(existing?.history || []), historyEntry].slice(-20),
            evidence: Array.isArray(answer.evidence) ? answer.evidence.slice(0, 20) : existing?.evidence || [],
            citations: Array.isArray(answer.citations) ? answer.citations.slice(0, 20).map((item) => ({
                title: String(item.title || item.id || '来源').slice(0, 300),
                url: String(item.url || '').split('?')[0].slice(0, 1000),
                page: String(item.page || '').slice(0, 50),
                startTime: Number.isFinite(Number(item.startTime)) ? Number(item.startTime) : null,
                endTime: Number.isFinite(Number(item.endTime)) ? Number(item.endTime) : null
            })) : existing?.citations || [],
            pageUrl: question.pageUrl,
            scriptVersion: VERSION
        };
        await requestPromise(store.put(record));
        await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        db.close();
        log(`已归档题目：${question.stem.slice(0, 30)}${question.stem.length > 30 ? '…' : ''}`);
        if (record.result === '正确' && !record.conflict) syncVerifiedAnswer(record).catch((error) => log(`已验证题库同步失败：${error.message}`, 'warn'));
    }

    async function syncVerifiedAnswer(record) {
        if (!runtime.settings.assistantServiceEnabled || !runtime.settings.assistantServiceToken) return;
        await serviceRequest('/api/verified/upsert', {
            fingerprint: record.fingerprint,
            course: record.course,
            chapter: record.chapter,
            stem: record.stem,
            type: record.type,
            answers: record.submittedAnswer,
            answerTexts: record.submittedAnswerTexts,
            result: record.result,
            conflict: record.conflict,
            explanation: record.explanation
        });
    }

    async function getArchivedQuestions(course = '') {
        const db = await openDatabase();
        const transaction = db.transaction(STORE_QUESTIONS, 'readonly');
        const store = transaction.objectStore(STORE_QUESTIONS);
        const request = course ? store.index('course').getAll(course) : store.getAll();
        const records = await requestPromise(request);
        db.close();
        return records.sort((a, b) => `${a.course}\u0000${a.chapter}\u0000${a.firstSeenAt}`.localeCompare(`${b.course}\u0000${b.chapter}\u0000${b.firstSeenAt}`, 'zh-CN'));
    }

    async function clearCourseArchive(course) {
        const records = await getArchivedQuestions(course);
        const db = await openDatabase();
        const transaction = db.transaction(STORE_QUESTIONS, 'readwrite');
        const store = transaction.objectStore(STORE_QUESTIONS);
        records.forEach((record) => store.delete(record.id));
        await new Promise((resolve, reject) => {
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        db.close();
        return records.length;
    }

    async function handleQuestion(question) {
        if (!assessmentMayAnswer(question)) return false;
        if (runtime.processedQuestions.has(question.fingerprint)) return false;
        const exam = detectExamPage();
        if (exam.matched || !courseContext()) {
            stopForExam(exam.reasons.length ? exam.reasons : ['无法确认是课程随堂练习']);
            return false;
        }
        runtime.state = 'ANSWERING';
        const generation = ++runtime.answerGeneration;
        const pageUrl = root.location.href;
        const answer = await resolveAnswer(question);
        if (generation !== runtime.answerGeneration || pageUrl !== root.location.href || !runtime.settings.enabled || !question.container.isConnected || !assessmentMayAnswer(question)) {
            log('题目已变化，已丢弃过期答案', 'warn');
            return false;
        }
        const current = parseQuestion(question.container);
        if (current.fingerprint !== question.fingerprint || detectExamPage().matched) {
            log('提交前题目或页面性质发生变化，已取消本次作答', 'warn');
            return false;
        }
        if (!answer || !Array.isArray(answer.answers) || answer.confidence < runtime.settings.minAnswerConfidence) {
            const reason = !answer ? '没有可用答案来源' : `答案置信度 ${answer.confidence} 低于阈值`;
            log(`题目未自动作答：${reason}`, 'warn');
            if (runtime.settings.unresolvedPolicy === 'pause') pause(`存在未解决题目：${reason}`);
            return false;
        }
        const applied = applyAnswer(question, answer);
        if (!applied.applied) {
            log(`题目填写失败：${applied.reason}`, 'warn');
            if (runtime.settings.unresolvedPolicy === 'pause') pause(applied.reason);
            return false;
        }
        let result = { result: '未知', correctAnswer: '', platformExplanation: '' };
        if (runtime.settings.courseAutoSubmit) {
            const submit = findSubmitButton(question);
            if (!submit) {
                log('已填写答案，但未找到安全的随堂题提交按钮', 'warn');
                if (runtime.settings.unresolvedPolicy === 'pause') pause('未找到随堂题提交按钮');
                return false;
            }
            const finalExamCheck = detectExamPage();
            if (finalExamCheck.matched) {
                stopForExam(finalExamCheck.reasons);
                return false;
            }
            if (!assessmentMayAnswer(question)) return false;
            assessmentNoteSubmission();
            submit.click();
            for (let attempt = 0; attempt < 12; attempt += 1) {
                await new Promise((resolve) => root.setTimeout(resolve, 250));
                result = extractResult(question);
                if (result.result !== '未知' || result.correctAnswer) break;
            }
        }
        await archiveQuestion(question, answer, applied, result).catch((error) => log(`题目归档失败：${error.message}`, 'error'));
        const correction = await correctFromPlatformAnswer(question, result);
        if (correction) {
            await archiveQuestion(correction.question, correction.answer, correction.applied, correction.result)
                .catch((error) => log(`自动纠错归档失败：${error.message}`, 'error'));
            result = correction.result;
            if (correction.continued) {
                runtime.processedQuestions.add(question.fingerprint);
                runtime.processedQuestions.add(correction.question.fingerprint);
                runtime.lastProgressAt = Date.now();
                return true;
            }
            if (result.result !== '正确') {
                runtime.lastProgressAt = Date.now();
                log('平台答案重新提交后尚未确认正确，保留页面等待下一轮纠错', 'warn');
                return true;
            }
        } else if (result.result === '错误' && result.correctAnswer) {
            runtime.lastProgressAt = Date.now();
            if (!runtime.processedQuestions.has(question.fingerprint)) log('已取得平台正确答案，保留当前错题页面并等待下一轮纠错', 'warn');
            return true;
        }
        runtime.processedQuestions.add(question.fingerprint);
        if (correction) runtime.processedQuestions.add(correction.question.fingerprint);
        runtime.lastProgressAt = Date.now();
        log(`随堂题处理完成，结果：${result.result}`);
        clickCourseQuizFollowup();
        return true;
    }

    async function handleQuestions() {
        if (!assessmentMayAnswer()) return false;
        if (!runtime.settings.courseAutoAnswer) return false;
        const nodes = findQuestionNodes();
        if (!nodes.length) return false;
        for (const node of nodes) {
            const question = parseQuestion(node);
            if (!question.stem || runtime.processedQuestions.has(question.fingerprint)) continue;
            const selected = question.options.filter(isOptionSelected);
            const existingResult = extractResult(question);
            const locked = question.options.length > 0 && question.options.every(isOptionLocked);
            if (selected.length && (locked || existingResult.result !== '未知' || existingResult.correctAnswer)) {
                const answer = {
                    answers: selected.map((option) => option.key),
                    answerTexts: selected.map((option) => option.text),
                    explanation: existingResult.platformExplanation,
                    source: '页面已有答案',
                    confidence: existingResult.correctAnswer ? 1 : 0.9
                };
                const applied = {
                    applied: true,
                    selected: selected.map((option) => option.key),
                    selectedTexts: selected.map((option) => option.text)
                };
                await archiveQuestion(question, answer, applied, existingResult).catch((error) => log(`已有题目归档失败：${error.message}`, 'error'));
                runtime.processedQuestions.add(question.fingerprint);
                log('已记录页面中已作答的随堂题');
                return true;
            }
            return await handleQuestion(question);
        }
        return false;
    }

    // Assessment metadata is shared through GM storage. No credentials, answers or
    // full responses are copied here. A new run always starts with a fresh overview.
    const ASSESSMENT_KEYS = Object.freeze({ run: 'fzugk-assessment-run-v1', request: 'fzugk-assessment-request-v1', response: 'fzugk-assessment-response-v1', snapshots: 'fzugk-assessment-snapshots-v1', navigation: 'fzugk-assessment-navigation-v1', navigationResponse: 'fzugk-assessment-navigation-response-v1' });
    const ASSESSMENT_LIMITS = Object.freeze({ navigationMs: 30000, scanMs: 600000, idleMs: 30000, attempts: 3, rounds: 2, leaseMs: 12000, snapshotMs: 120000, verificationMs: [2000, 5000, 10000, 20000, 20000] });

    function assessmentText(value) {
        return String(value ?? '').replace(/[\s\u200B-\u200D\uFEFF]/g, '').replace(/，/g, ',').replace(/：/g, ':').replace(/（/g, '(').replace(/）/g, ')');
    }

    function assessmentStatus(value) {
        if (value === 1 || assessmentText(value) === '已通过') return 'PASSED';
        if (value === 0 || assessmentText(value) === '未通过') return 'FAILED';
        if (value === -1 || assessmentText(value) === '未做') return 'NOT_STARTED';
        return 'UNKNOWN';
    }

    function assessmentId(value) {
        // 64-bit numeric IDs lose precision in JavaScript. Never invent their digits.
        return typeof value === 'number' && !Number.isSafeInteger(value) ? '' : String(value ?? '');
    }

    function assessmentState() {
        if (!runtime.assessment) runtime.assessment = {
            ownerId: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
            generation: 0, context: null, snapshot: null, queue: [], index: [], target: null,
            phase: 'IDLE', error: '', runId: '', opened: null, requestId: '', handledRequest: '',
            visited: new Set(), nav: null, verifyStep: 0, verifyAt: 0, submissionAt: 0,
            leaseReady: false, round: 1, finalRequested: false, stopped: false
        };
        return runtime.assessment;
    }

    function assessmentVm(doc = root.document, kind = 'portal') {
        let pageDoc = doc;
        try { if (doc === root.document && typeof unsafeWindow !== 'undefined') pageDoc = unsafeWindow.document; } catch (_) {}
        const mount = pageDoc?.querySelector('#app');
        if (kind === 'portal') {
            const component = mount?._vnode?.component;
            const data = component?.data;
            return data && Array.isArray(data.listCourse) && Array.isArray(data.enterTheEvaluationData) ? data : null;
        }
        const pending = [...(mount?.__vue__?.$children || [])];
        for (let i = 0; i < pending.length && i < 100; i += 1) {
            const vm = pending[i];
            if (Array.isArray(vm.chapters) && Array.isArray(vm.questionList) && vm.nodeData) return vm;
            pending.push(...(vm.$children || []));
        }
        return null;
    }

    function assessmentContexts() {
        const contexts = [];
        for (const doc of sameOriginDocuments()) {
            const data = assessmentVm(doc);
            for (const title of doc.querySelectorAll('.one-top-text1, .course-card [data-course-name]')) {
                if (!isVisible(title)) continue;
                const name = String(title.getAttribute('data-course-name') || title.innerText).trim();
                const card = title.closest('li[class*="one-item-skin"], .course-card');
                if (!card || card.querySelectorAll('.one-top-text1, [data-course-name]').length !== 1) continue;
                const courses = (data?.listCourse || []).filter((row) => assessmentText(row.courseName) === assessmentText(name));
                const row = courses.length === 1 ? courses[0] : null;
                const guid = assessmentId(row?.courseGUID || card.getAttribute('data-course-key'));
                const term = String(row?.ExamDate || card.getAttribute('data-term') || '');
                contexts.push({ courseTitle: name, courseKey: guid ? `${guid}:${term}` : `title:${assessmentText(name)}`, courseGuid: guid, term, coursewareCode: String(row?.coursecode || card.getAttribute('data-courseware-code') || ''), accountScope: null, card, doc });
            }
        }
        return contexts;
    }

    function assessmentContextData(context) {
        const { courseTitle, courseKey, courseGuid, term, coursewareCode, accountScope } = context;
        return { courseTitle, courseKey, courseGuid, term, coursewareCode, accountScope: accountScope || null };
    }

    function assessmentControls(scope, names) {
        const wanted = names.map(assessmentText);
        return [...scope.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')]
            .filter((el) => isVisible(el) && [el.innerText, el.getAttribute('aria-label'), el.getAttribute('title'), el.value].some((name) => wanted.includes(assessmentText(name))));
    }

    function assessmentClickable(element) {
        if (!element || !isVisible(element) || isDisabledControl(element)) return false;
        element.scrollIntoView?.({ block: 'center', inline: 'nearest' });
        const rect = element.getBoundingClientRect();
        const hit = element.ownerDocument.elementFromPoint?.(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !hit || hit === element || element.contains(hit);
    }

    function assessmentDetail(context, binding = null) {
        for (const doc of sameOriginDocuments()) {
            const dialogs = [...doc.querySelectorAll('.el-dialog, [role="dialog"], .assessment-overview')].filter(isVisible);
            for (const dialog of dialogs) {
                const heading = dialog.querySelector('.el-dialog__title, [role="heading"], h1, h2, h3');
                if (assessmentText(heading?.innerText) !== '知识点测评完成详情') continue;
                const columns = [...dialog.querySelectorAll('thead th, [role="columnheader"]')].map((el) => assessmentText(el.textContent));
                if (!columns.includes('名称') || !columns.includes('完成情况')) continue;
                const data = assessmentVm(doc);
                const params = data?.enterTheEvaluationParams;
                const byId = context.courseGuid && String(params?.courseGUID) === context.courseGuid && String(params?.ExamDate) === context.term;
                const explicit = dialog.getAttribute('data-course-key') === context.courseKey;
                // DOM-only adapters require an explicit course scope. A heading alone
                // cannot bind an old modal to the newly clicked course.
                if (!byId && !explicit) continue;
                if (binding && binding.courseKey !== context.courseKey) continue;
                return { verified: true, context: assessmentContextData(context), dialog, doc, data, openedAt: binding?.clickedAt || Date.now(), resultType: 'SAME_DOCUMENT', ownership: byId ? 'courseGUID + ExamDate + unique course card' : 'explicit course key' };
            }
        }
        return null;
    }

    async function assessmentWait(predicate, timeout = ASSESSMENT_LIMITS.navigationMs, generation = assessmentState().generation) {
        const deadline = Date.now() + timeout;
        do {
            if (generation !== assessmentState().generation || detectLoginPage() || detectExamPage().matched) return null;
            const result = predicate();
            if (result) return result;
            await new Promise((resolve) => root.setTimeout(resolve, 150));
        } while (Date.now() < deadline);
        return null;
    }

    async function openAssessmentOverview(context, options = {}) {
        const state = assessmentState();
        const generation = state.generation;
        if (!context?.courseKey || !context.courseTitle) return { verified: false, error: 'COURSE_NOT_VERIFIED' };
        if (detectLoginPage()) return { verified: false, error: 'LOGIN_REQUIRED' };
        const exam = detectExamPage();
        if (exam.matched) { stopForExam(exam.reasons); return { verified: false, error: 'EXAM_OR_IDENTITY_BLOCKED' }; }
        let current = assessmentDetail(context);
        if (current && !options.refresh) return current;
        if (options.refresh) {
            for (const doc of sameOriginDocuments()) {
                for (const dialog of [...doc.querySelectorAll('.el-dialog, [role="dialog"], .assessment-overview')].filter(isVisible)) {
                    if (assessmentText(dialog.querySelector('.el-dialog__title, [role="heading"], h2')?.innerText) !== '知识点测评完成详情') continue;
                    const close = dialog.querySelector('.el-dialog__headerbtn, [aria-label="el.dialog.close"], [data-overview-close]');
                    if (!assessmentClickable(close)) return { verified: false, error: 'OVERVIEW_CLOSE_FAILED' };
                    close.click();
                    if (!await assessmentWait(() => !isVisible(dialog), options.timeoutMs, generation)) return { verified: false, error: 'OVERVIEW_CLOSE_FAILED' };
                }
            }
        }
        let lastError = 'ENTRY_NOT_FOUND';
        for (let attempt = 0; attempt < 3; attempt += 1) {
            const matches = assessmentContexts().filter((item) => item.courseKey === context.courseKey && assessmentText(item.courseTitle) === assessmentText(context.courseTitle));
            if (matches.length > 1) return { verified: false, error: 'ENTRY_AMBIGUOUS' };
            const card = matches[0]?.card;
            if (!card) {
                lastError = 'ENTRY_NOT_FOUND';
                if (attempt < 2) await new Promise((resolve) => root.setTimeout(resolve, 250));
                continue;
            }
            let controls = assessmentControls(card, ['进入评测']);
            if (!controls.length) controls = assessmentControls(card, ['进入测评']);
            if (controls.length > 1) return { verified: false, error: 'ENTRY_AMBIGUOUS' };
            if (!controls.length) { lastError = 'ENTRY_NOT_FOUND'; continue; }
            const button = controls[0];
            log(`测评入口已找到：${context.courseTitle} / ${compactControlText(button)}`);
            if (!await assessmentWait(() => assessmentClickable(button), options.timeoutMs, generation)) {
                lastError = isDisabledControl(button) ? 'ENTRY_DISABLED' : 'ENTRY_OBSCURED';
                continue;
            }
            if (generation !== state.generation) return { verified: false, error: 'CANCELLED' };
            const binding = { courseKey: context.courseKey, clickedAt: Date.now() };
            const navRequest = { schemaVersion: 1, requestId: `${state.ownerId}:${binding.clickedAt}`, context: assessmentContextData(context), createdAt: binding.clickedAt, expiresAt: binding.clickedAt + 30000 };
            gmSet(ASSESSMENT_KEYS.navigation, navRequest);
            button.click();
            log(`测评入口已点击：${context.courseTitle}`);
            // Once clicked, do not click it again merely because a popup is slow.
            current = await assessmentWait(() => {
                const local = assessmentDetail(context, binding);
                if (local) return local;
                const remote = gmGet(ASSESSMENT_KEYS.navigationResponse, null);
                if (remote?.schemaVersion === 1 && remote.requestId === navRequest.requestId && remote.courseKey === context.courseKey && remote.snapshot?.context?.courseKey === context.courseKey && remote.snapshot.observedAt >= binding.clickedAt && remote.expiresAt > Date.now()) return { verified: true, context: assessmentContextData(context), snapshot: remote.snapshot, resultType: 'REMOTE_DOCUMENT', openedAt: binding.clickedAt, ownership: 'correlated navigation + verified course scope' };
                return null;
            }, options.timeoutMs, generation);
            if (gmGet(ASSESSMENT_KEYS.navigation, null)?.requestId === navRequest.requestId) gmSet(ASSESSMENT_KEYS.navigation, null);
            if (current) { log(`测评详情已核验：${context.courseTitle}`); return current; }
            const afterExam = detectExamPage();
            if (afterExam.matched) stopForExam(afterExam.reasons);
            return { verified: false, error: generation !== state.generation ? 'CANCELLED' : afterExam.matched ? 'EXAM_OR_IDENTITY_BLOCKED' : 'OVERVIEW_NOT_VERIFIED' };
        }
        return { verified: false, error: lastError };
    }

    function assessmentRecord(context, row, observedAt) {
        const questionId = assessmentId(row.questionId);
        const knowledgeTitle = String(row.examinePoint ?? row.knowledgeTitle ?? '').trim();
        const chapterKey = assessmentId(row.chapterKey);
        return {
            schemaVersion: 1, ...assessmentContextData(context), questionId,
            knowledgeKey: `${context.courseKey}::${questionId ? `q:${questionId}` : `name:${chapterKey}:${assessmentText(knowledgeTitle)}`}`,
            keyStability: questionId ? 'PLATFORM_QUESTION_ID' : 'COMPOSITE_NAME', knowledgeTitle,
            chapterKey, chapterTitle: String(row.chapterTitle || ''), lessonKey: '', lessonTitle: '',
            platformStatus: assessmentStatus(row.isPass ?? row.platformStatus), queueState: 'PENDING',
            mappingStatus: 'MISSING', mappingEvidence: [], observedAt, lastVerifiedAt: observedAt,
            attempts: 0, lastError: '', runId: ''
        };
    }

    async function scanAssessmentOverview(opened, options = {}) {
        const state = assessmentState();
        if (opened?.verified && opened.snapshot?.context?.courseKey === opened.context?.courseKey && opened.snapshot.observedAt >= opened.openedAt) {
            state.snapshot = opened.snapshot; state.context = opened.context; updatePanel(); return opened.snapshot;
        }
        const observedAt = Date.now();
        const result = { schemaVersion: 1, context: opened?.context || null, records: [], complete: false, pagesRead: 0, uniqueCount: 0, platformTotal: null, reachedEnd: false, loading: false, error: '', observedAt, verifiedAt: observedAt };
        if (!opened?.verified || !opened.dialog?.isConnected || !isVisible(opened.dialog)) return { ...result, error: 'OVERVIEW_NOT_VERIFIED' };
        const generation = state.generation;
        const records = new Map();
        const deadline = Date.now() + (options.scanMs || ASSESSMENT_LIMITS.scanMs);
        let progressedAt = Date.now();
        let sourceSignature = '';
        let stable = 0;
        const seenPages = new Set();
        while (Date.now() < deadline) {
            if (generation !== state.generation || detectLoginPage() || detectExamPage().matched) { result.error = 'CANCELLED_OR_BLOCKED'; break; }
            const live = assessmentDetail(opened.context);
            if (!live || live.dialog !== opened.dialog) { result.error = 'OVERVIEW_CHANGED'; break; }
            const data = live.data;
            const loading = Boolean(data?.enterTheEvaluationLoading || [...live.dialog.querySelectorAll('.el-loading-mask, [aria-busy="true"]')].some(isVisible));
            result.loading = loading;
            if (!loading) {
                let batch;
                if (data) {
                    // This is the fully loaded source of the observed Element table,
                    // not a guessed endpoint or a count from the video progress card.
                    batch = data.enterTheEvaluationData.map((row) => ({ questionId: row.questionId, examinePoint: row.examinePoint, isPass: row.isPass, coursewareCode: row.coursewareCode }));
                    result.platformTotal = batch.length;
                    if (batch.some((row) => row.coursewareCode !== opened.context.coursewareCode)) { result.error = 'COURSE_DATA_MISMATCH'; break; }
                } else {
                    batch = [...live.dialog.querySelectorAll('tbody tr, [role="row"][data-knowledge-name]')].map((row) => {
                        const cells = row.querySelectorAll('td');
                        return { questionId: row.getAttribute('data-question-id') || '', examinePoint: row.getAttribute('data-knowledge-name') || cells[0]?.textContent, platformStatus: cells[1]?.textContent || row.getAttribute('data-status'), chapterKey: row.getAttribute('data-chapter-key') || '' };
                    });
                    const total = live.dialog.getAttribute('data-assessment-total') || live.dialog.querySelector('[aria-rowcount]')?.getAttribute('aria-rowcount');
                    result.platformTotal = total === null || total === undefined ? null : Number(total);
                }
                const pageKey = live.dialog.querySelector('[aria-current="page"], .el-pager .is-active')?.textContent || '1';
                seenPages.add(pageKey);
                const before = records.size;
                let conflict = false;
                for (const row of batch) {
                    if (!row.examinePoint) { conflict = true; continue; }
                    const record = assessmentRecord(opened.context, row, observedAt);
                    const prior = records.get(record.knowledgeKey);
                    if (prior && (prior.knowledgeTitle !== record.knowledgeTitle || prior.platformStatus !== record.platformStatus)) conflict = true;
                    records.set(record.knowledgeKey, record);
                }
                if (conflict) { result.error = 'ROW_ID_OR_STATUS_CONFLICT'; break; }
                const signature = JSON.stringify(batch);
                stable = sourceSignature === signature ? stable + 1 : 0;
                if (sourceSignature !== signature || before !== records.size) progressedAt = Date.now();
                sourceSignature = signature;
                const next = live.dialog.querySelector('.btn-next, [data-assessment-next]');
                const scroller = live.dialog.querySelector('.el-scrollbar__wrap, [data-assessment-scroll]');
                const atBottom = !scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
                result.reachedEnd = data ? true : (!next || isDisabledControl(next)) && atBottom;
                if (stable >= 1 && result.platformTotal !== null && result.platformTotal > 0 && records.size === result.platformTotal && result.reachedEnd) {
                    result.complete = true;
                    break;
                }
                if (!data && next && !isDisabledControl(next) && assessmentClickable(next)) {
                    next.click();
                    await assessmentWait(() => (live.dialog.querySelector('[aria-current="page"], .el-pager .is-active')?.textContent || '1') !== pageKey, options.idleMs, generation);
                    progressedAt = Date.now();
                } else if (!data && scroller && !atBottom) {
                    scroller.scrollTop += Math.max(1, scroller.clientHeight * 0.8);
                }
                if (!batch.length && stable >= 1) { result.error = 'EMPTY_OVERVIEW'; break; }
            }
            if (Date.now() - progressedAt > (options.idleMs || ASSESSMENT_LIMITS.idleMs)) { result.error = 'SCAN_NO_PROGRESS'; break; }
            await new Promise((resolve) => root.setTimeout(resolve, 150));
        }
        result.records = [...records.values()];
        result.observedAt = Date.now();
        result.verifiedAt = result.observedAt;
        for (const row of result.records) { row.observedAt = result.observedAt; row.lastVerifiedAt = result.observedAt; }
        result.pagesRead = seenPages.size;
        result.uniqueCount = records.size;
        if (!result.complete && !result.error) result.error = 'SCAN_TIMEOUT';
        state.snapshot = result;
        state.context = opened.context;
        state.error = result.error;
        const stored = gmGet(ASSESSMENT_KEYS.snapshots, {});
        stored[opened.context.courseKey] = result;
        const bounded = Object.fromEntries(Object.entries(stored).sort((a, b) => b[1].observedAt - a[1].observedAt).slice(0, 8));
        gmSet(ASSESSMENT_KEYS.snapshots, bounded);
        log(`${result.complete ? '测评扫描已完成' : '测评扫描未完成'}：${opened.context.courseTitle}，${records.size} 项${result.error ? `，${result.error}` : ''}`);
        return result;
    }

    function assessmentSummary(snapshot) {
        const counts = { PASSED: 0, FAILED: 0, NOT_STARTED: 0, UNKNOWN: 0 };
        for (const row of snapshot?.records || []) counts[row.platformStatus in counts ? row.platformStatus : 'UNKNOWN'] += 1;
        return { ...counts, complete: snapshot?.complete === true, allPassed: snapshot?.complete === true && (snapshot.records?.length || 0) > 0 && counts.FAILED + counts.NOT_STARTED + counts.UNKNOWN === 0 };
    }

    function buildKnowledgeNodeIndex(context, previous = []) {
        const vm = assessmentVm(root.document, 'player');
        const active = cwsActiveLesson();
        const out = [...previous].filter((entry) => entry.courseKey === context.courseKey);
        if (!vm || !active || String(vm.coursewareCode) !== context.coursewareCode || `video_${assessmentId(vm.nodeData.id)}` !== active.id || vm.spinShow) return out;
        for (const question of vm.questionList) {
            const id = assessmentId(question.catalogId);
            if (!id || `video_${id}` !== active.id || (question.coursewareCode && String(question.coursewareCode) !== context.coursewareCode) || !question.examinePoint) continue;
            const group = active.parentElement.closest('li.conBox');
            const title = group?.querySelector(':scope > .videoTitle')?.innerText || '';
            const entry = { courseKey: context.courseKey, coursewareCode: context.coursewareCode, questionId: assessmentId(question.questionId), knowledgeTitle: String(question.examinePoint).trim(), chapterKey: assessmentId(vm.nodeData.parentId || vm.nodeData.pId) || group?.id || '', chapterTitle: title.trim(), lessonKey: active.id, lessonTitle: String(active.querySelector('.videoTitme')?.innerText || '').trim(), order: cwsCatalogRows().indexOf(active), evidence: 'loaded questionList.catalogId + questionId + examinePoint + active directory ID', observedAt: Date.now() };
            if (!out.some((prior) => prior.questionId === entry.questionId && prior.lessonKey === entry.lessonKey && prior.knowledgeTitle === entry.knowledgeTitle)) out.push(entry);
        }
        return out;
    }

    function resolveAssessmentTarget(record, index) {
        const scoped = index.filter((entry) => entry.courseKey === record.courseKey && entry.coursewareCode === record.coursewareCode);
        let matches = record.questionId ? scoped.filter((entry) => entry.questionId === record.questionId && assessmentText(entry.knowledgeTitle) === assessmentText(record.knowledgeTitle)) : [];
        if (!matches.length && !record.questionId) matches = scoped.filter((entry) => assessmentText(entry.knowledgeTitle) === assessmentText(record.knowledgeTitle) && (!record.chapterKey || record.chapterKey === entry.chapterKey));
        const nodes = [...new Set(matches.map((entry) => entry.lessonKey))];
        if (nodes.length !== 1) return { mappingStatus: nodes.length ? 'AMBIGUOUS' : 'MISSING', candidates: matches };
        return { mappingStatus: 'EXACT', ...matches[0], mappingEvidence: matches.map((entry) => entry.evidence) };
    }

    function assessmentQueue(snapshot, previous = [], index = []) {
        if (!snapshot?.complete || !snapshot.context?.courseKey) return [];
        const prior = new Map(previous.map((item) => [item.knowledgeKey, item]));
        return snapshot.records.map((record) => {
            const old = prior.get(record.knowledgeKey);
            const mapping = resolveAssessmentTarget(record, index);
            const freshPass = record.platformStatus === 'PASSED' && (!old?.submissionAt || snapshot.observedAt > old.submissionAt);
            return { ...record, ...mapping, attempts: old?.attempts || 0, submissionAt: old?.submissionAt || 0, queueState: freshPass ? 'DONE' : record.platformStatus === 'UNKNOWN' ? 'DEFERRED' : old?.queueState === 'DONE' ? 'PENDING' : old?.queueState || 'PENDING', lastError: freshPass ? '' : record.platformStatus === 'UNKNOWN' ? 'UNKNOWN_PLATFORM_STATUS' : old?.lastError || '', runId: old?.runId || '' };
        }).sort((a, b) => ({ FAILED: 0, NOT_STARTED: 1, UNKNOWN: 2, PASSED: 3 }[a.platformStatus] - { FAILED: 0, NOT_STARTED: 1, UNKNOWN: 2, PASSED: 3 }[b.platformStatus]) || (a.order ?? 10000) - (b.order ?? 10000));
    }

    function assessmentRunValid(run, context = assessmentState().context) {
        return run?.schemaVersion === 1 && run.status === 'ACTIVE' && run.runId && run.expiresAt > Date.now() && context?.courseKey === run.context?.courseKey && context?.coursewareCode === run.context?.coursewareCode;
    }

    function assessmentMessageValid(message, run) {
        return assessmentRunValid(run, run?.context) && message?.schemaVersion === 1 && message.runId === run.runId && message.courseKey === run.context.courseKey && message.requestId && message.createdAt <= Date.now() && message.expiresAt > Date.now() && message.expiresAt - message.createdAt <= 120000 && typeof message.targetLessonKey === 'string';
    }

    function assessmentLeaseKey(_runId, role) { return `fzugk-assessment-lease-v1:${role}`; }

    function ownsAssessmentLease(role = 'player') {
        const state = assessmentState();
        const run = gmGet(ASSESSMENT_KEYS.run, null);
        const lease = gmGet(assessmentLeaseKey(state.runId, role), null);
        return state.leaseReady && assessmentRunValid(run) && lease?.runId === state.runId && lease.courseKey === state.context.courseKey && lease.ownerId === state.ownerId && lease.expiresAt > Date.now();
    }

    async function acquireAssessmentLease(role) {
        const state = assessmentState();
        const generation = state.generation;
        const runId = state.runId;
        if (state.stopped || !assessmentRunValid(gmGet(ASSESSMENT_KEYS.run, null))) return false;
        const key = assessmentLeaseKey(state.runId, role);
        const lease = gmGet(key, null);
        if (lease?.runId === state.runId && lease.courseKey === state.context.courseKey && lease.expiresAt > Date.now() && lease.ownerId !== state.ownerId) return false;
        gmSet(key, { schemaVersion: 1, runId: state.runId, courseKey: state.context.courseKey, ownerId: state.ownerId, expiresAt: Date.now() + ASSESSMENT_LIMITS.leaseMs });
        state.leaseReady = false;
        await new Promise((resolve) => root.setTimeout(resolve, 250 + Math.random() * 100));
        if (state.stopped || state.generation !== generation || state.runId !== runId || gmGet(ASSESSMENT_KEYS.run, null)?.runId !== runId || !assessmentRunValid(gmGet(ASSESSMENT_KEYS.run, null))) return false;
        const confirmed = gmGet(key, null);
        state.leaseReady = confirmed?.runId === state.runId && confirmed.courseKey === state.context.courseKey && confirmed.ownerId === state.ownerId && confirmed.expiresAt > Date.now();
        return state.leaseReady;
    }

    function renewAssessmentLease(role) {
        const state = assessmentState();
        if (!ownsAssessmentLease(role)) return false;
        gmSet(assessmentLeaseKey(state.runId, role), { schemaVersion: 1, runId: state.runId, courseKey: state.context.courseKey, ownerId: state.ownerId, expiresAt: Date.now() + ASSESSMENT_LIMITS.leaseMs });
        return true;
    }

    function saveAssessmentCheckpoint() {
        const state = assessmentState();
        if (!state.runId || !ownsAssessmentLease('player')) return;
        gmSet(`fzugk-assessment-checkpoint-v1:${state.context.courseKey}`, { schemaVersion: 1, runId: state.runId, context: state.context, queue: state.queue, index: state.index, phase: state.phase, targetKey: state.target?.knowledgeKey || '', submissionAt: state.submissionAt, updatedAt: Date.now() });
    }

    function requestAssessmentVerification(final = false) {
        const state = assessmentState();
        if (!ownsAssessmentLease('player')) return false;
        const requestId = `${state.runId}:${state.ownerId}:${Date.now()}:${state.verifyStep}`;
        state.requestId = requestId;
        state.verifyAt = Date.now();
        state.finalRequested = final;
        gmSet(ASSESSMENT_KEYS.request, { schemaVersion: 1, runId: state.runId, courseKey: state.context.courseKey, targetLessonKey: state.target?.lessonKey || '', requestId, createdAt: Date.now(), expiresAt: Date.now() + 90000, after: state.submissionAt, type: 'VERIFY' });
        log(`等待入口页重新核验${final ? '整门课程' : state.target?.knowledgeTitle || '测评'}；请求已保存`);
        return true;
    }

    function assessmentCancel(reason = 'STOPPED', publish = true) {
        const state = assessmentState();
        saveAssessmentCheckpoint();
        state.generation += 1;
        if (state.heartbeat) root.clearInterval(state.heartbeat);
        state.heartbeat = null;
        state.stopped = true;
        state.error = reason;
        if (publish) {
            const run = gmGet(ASSESSMENT_KEYS.run, null);
            if (run?.runId === state.runId && run.status === 'ACTIVE') gmSet(ASSESSMENT_KEYS.run, { ...run, status: 'STOPPED', stoppedAt: Date.now() });
        }
        for (const role of ['player', 'portal']) {
            const key = assessmentLeaseKey(state.runId, role);
            const lease = gmGet(key, null);
            if (lease?.runId === state.runId && lease.ownerId === state.ownerId) gmSet(key, null);
        }
        state.leaseReady = false;
        state.phase = 'PAUSED';
        runtime.mode = 'STUDY';
    }

    async function scanSelectedAssessment(context = null) {
        const state = assessmentState();
        if (runtime.mode === 'ASSESSMENT' && state.runId) assessmentCancel('MANUAL_RESCAN');
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.timer = null;
        runtime.settings.enabled = false;
        cancelPendingAssistantWork();
        state.generation += 1;
        state.stopped = false;
        const selected = runtime.panel?.querySelector('[data-role="assessment-course"]')?.value;
        context ||= assessmentContexts().find((item) => item.courseKey === selected);
        if (!context) {
            // A player cannot turn its absent overview into a successful empty scan.
            const run = gmGet(ASSESSMENT_KEYS.run, null);
            if (run?.context && assessmentText(extractCourseInfo().course) === assessmentText(run.context.courseTitle)) {
                state.context = run.context;
                state.error = 'RETURN_TO_COURSE_LIST_REQUIRED';
            } else state.error = 'ENTRY_NOT_FOUND';
            log(`测评未扫描：${state.error}；请保留课程列表页，播放器不会用视频进度代替详情`, 'warn');
            return null;
        }
        state.context = assessmentContextData(context);
        state.phase = 'SCANNING';
        const opened = await openAssessmentOverview(context, { refresh: true });
        if (!opened.verified) { state.error = opened.error; state.phase = 'DEFERRED'; updatePanel(); return null; }
        state.opened = opened;
        const snapshot = await scanAssessmentOverview(opened);
        state.phase = snapshot.complete ? 'READY' : 'DEFERRED';
        updatePanel();
        return snapshot;
    }

    async function startAssessmentRecovery() {
        const state = assessmentState();
        if (assessmentVm(root.document, 'player')) {
            const run = gmGet(ASSESSMENT_KEYS.run, null);
            if (assessmentRunValid(run, run?.context)) return adoptAssessmentRun(run, true);
            state.error = 'FRESH_OVERVIEW_REQUIRED';
            log('补齐未启动：需先在课程列表页完成目标课程的新扫描', 'warn');
            return;
        }
        const snapshot = await scanSelectedAssessment();
        if (!snapshot?.complete) return;
        state.queue = assessmentQueue(snapshot);
        if (assessmentSummary(snapshot).allPassed) { state.phase = 'DONE'; log('平台最新完整详情已确认：所有知识点均已通过'); return; }
        state.runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const runId = state.runId;
        const generation = state.generation;
        state.stopped = false;
        state.phase = 'WAITING_PLAYER';
        state.context = snapshot.context;
        gmSet(ASSESSMENT_KEYS.run, { schemaVersion: 1, runId: state.runId, context: snapshot.context, status: 'ACTIVE', createdAt: Date.now(), expiresAt: Date.now() + 7200000, snapshotAt: snapshot.observedAt });
        runtime.mode = 'ASSESSMENT';
        runtime.settings.enabled = true;
        startAssessmentTimer();
        log(`补齐队列已建立：${snapshot.context.courseTitle}；等待同课程学习窗口，入口页负责复核`);
        // Reuse an already running target player. Otherwise open its actual card
        // entry once, and leave login/identity/notice classification to the guards.
        await new Promise((resolve) => root.setTimeout(resolve, 700));
        if (state.stopped || state.generation !== generation || state.runId !== runId || runtime.mode !== 'ASSESSMENT' || !assessmentRunValid(gmGet(ASSESSMENT_KEYS.run, null)) || gmGet(ASSESSMENT_KEYS.run, null)?.runId !== runId) return;
        const worker = gmGet(assessmentLeaseKey(state.runId, 'player'), null);
        if (!worker || worker.runId !== state.runId || worker.courseKey !== state.context.courseKey || worker.expiresAt <= Date.now()) {
            const detail = assessmentDetail(state.context);
            const close = detail?.dialog.querySelector('.el-dialog__headerbtn');
            if (assessmentClickable(close)) close.click();
            const cards = assessmentContexts().filter((item) => item.courseKey === state.context.courseKey);
            const entries = cards.length === 1 ? assessmentControls(cards[0].card, ['进入学习']) : [];
            if (entries.length === 1 && assessmentClickable(entries[0])) { entries[0].click(); log(`已点击同课程学习入口：${state.context.courseTitle}`); }
            else { state.error = 'LEARNING_ENTRY_NOT_AVAILABLE'; log('学习入口暂不可用，已保存补齐队列', 'warn'); }
        }
    }

    function startAssessmentTimer() {
        if (runtime.timer) root.clearInterval(runtime.timer);
        const state = assessmentState();
        if (state.heartbeat) root.clearInterval(state.heartbeat);
        state.heartbeat = root.setInterval(() => {
            if (runtime.mode !== 'ASSESSMENT' || !runtime.settings.enabled) { root.clearInterval(state.heartbeat); state.heartbeat = null; return; }
            const role = assessmentVm(root.document, 'portal') ? 'portal' : 'player';
            renewAssessmentLease(role);
        }, 3000);
        runtime.timer = root.setInterval(() => tick().catch((error) => { runtime.busy = false; assessmentState().error = error.message; log(`测评调度失败：${error.message}`, 'error'); }), runtime.settings.loopIntervalMs);
        tick().catch((error) => log(error.message, 'error'));
    }

    async function adoptAssessmentRun(run, refresh = false) {
        const state = assessmentState();
        const vm = assessmentVm(root.document, 'player');
        if (!vm || !assessmentRunValid(run, run.context) || assessmentText(extractCourseInfo().course) !== assessmentText(run.context.courseTitle) || String(vm.coursewareCode) !== run.context.coursewareCode) return false;
        if (state.runId === run.runId && runtime.mode === 'ASSESSMENT') return true;
        state.context = run.context;
        state.runId = run.runId;
        state.stopped = false;
        state.generation += 1;
        const generation = state.generation;
        const snapshot = gmGet(ASSESSMENT_KEYS.snapshots, {})[run.context.courseKey];
        if (!snapshot?.complete || snapshot.observedAt < run.createdAt - 2000 || Date.now() - snapshot.observedAt > ASSESSMENT_LIMITS.snapshotMs) { state.error = 'FRESH_OVERVIEW_REQUIRED'; return false; }
        const checkpoint = gmGet(`fzugk-assessment-checkpoint-v1:${run.context.courseKey}`, null);
        const resume = checkpoint?.runId === run.runId;
        state.snapshot = snapshot;
        state.index = resume ? checkpoint.index : [];
        state.queue = assessmentQueue(snapshot, resume ? checkpoint.queue : [], state.index);
        state.visited = new Set();
        state.target = resume ? state.queue.find((row) => row.knowledgeKey === checkpoint.targetKey) : null;
        state.submissionAt = resume ? checkpoint.submissionAt : 0;
        state.phase = 'RESCAN_BEFORE_RESUME';
        runtime.mode = 'ASSESSMENT';
        runtime.settings.enabled = true;
        cancelPendingAssistantWork();
        const acquired = await acquireAssessmentLease('player');
        if (state.stopped || state.generation !== generation || state.runId !== run.runId || gmGet(ASSESSMENT_KEYS.run, null)?.runId !== run.runId || !assessmentRunValid(gmGet(ASSESSMENT_KEYS.run, null))) return false;
        if (!acquired) {
            state.phase = 'WAITING_OWNER';
        } else {
            // Every new player/reload/takeover checks fresh platform state first.
            state.phase = 'VERIFYING';
            state.verifyStep = 0;
            state.submissionAt = resume ? checkpoint.submissionAt : 0;
            requestAssessmentVerification(false);
        }
        startAssessmentTimer();
        return true;
    }

    function assessmentMayAnswer(question = null) {
        if (runtime.mode !== 'ASSESSMENT') return true;
        const state = assessmentState();
        if (!ownsAssessmentLease('player') || state.phase !== 'RUNNING' || !state.target) return false;
        const vm = assessmentVm(root.document, 'player');
        if (!vm || String(vm.coursewareCode) !== state.context.coursewareCode || cwsActiveLesson()?.id !== state.target.lessonKey || `video_${assessmentId(vm.nodeData.id)}` !== state.target.lessonKey) return false;
        const current = vm.questionItem;
        const id = assessmentId(current?.questionId);
        const targets = state.queue.filter((row) => row.lessonKey === state.target.lessonKey && ['FAILED', 'NOT_STARTED'].includes(row.platformStatus));
        if (!id || !targets.some((row) => row.questionId === id && assessmentText(row.knowledgeTitle) === assessmentText(current.examinePoint))) return false;
        return !question || assessmentText(question.course) === assessmentText(state.context.courseTitle);
    }

    function assessmentNoteSubmission() {
        if (runtime.mode !== 'ASSESSMENT' || !assessmentMayAnswer()) return;
        const state = assessmentState();
        state.submissionAt = Date.now();
        for (const row of state.queue.filter((item) => item.lessonKey === state.target.lessonKey && item.queueState !== 'DONE')) row.submissionAt = state.submissionAt;
        saveAssessmentCheckpoint();
    }

    function assessmentDefer(reason) {
        const state = assessmentState();
        if (state.target) {
            for (const row of state.queue.filter((item) => item.lessonKey === state.target.lessonKey && item.queueState !== 'DONE')) { row.queueState = 'DEFERRED'; row.lastError = reason; }
        }
        state.error = reason;
        state.target = null;
        state.nav = null;
        state.phase = 'LOCATING';
        saveAssessmentCheckpoint();
        log(`测评待核实：${reason}`, 'warn');
    }

    function navigateAssessmentLesson(lessonKey) {
        if (!ownsAssessmentLease('player') || findQuestionNodes().length || runtime.pendingCorrection) return false;
        const row = cwsCatalogRows().find((item) => item.id === lessonKey);
        if (!row) return false;
        if (!isVisible(row)) {
            for (let scope = row.parentElement; scope; scope = scope.parentElement) {
                if (scope.tagName !== 'UL' || isVisible(scope)) continue;
                const heading = [...scope.parentElement.children].find((child) => child.classList.contains('videoTitle'));
                if (assessmentClickable(heading)) { heading.click(); return false; }
            }
            return false;
        }
        if (!assessmentClickable(row)) return false;
        runtime.expectedLessonId = row.id;
        cancelPendingAssistantWork();
        row.click();
        return true;
    }

    async function assessmentPortalTick() {
        const state = assessmentState();
        const run = gmGet(ASSESSMENT_KEYS.run, null);
        if (!assessmentRunValid(run)) {
            assessmentCancel('RUN_STOPPED', false); runtime.settings.enabled = false;
            state.phase = run?.status || 'PAUSED'; runtime.state = run?.status === 'DONE' ? 'DONE' : 'ASSESSMENT_PENDING';
            if (runtime.timer) root.clearInterval(runtime.timer); runtime.timer = null;
            return;
        }
        if (!ownsAssessmentLease('portal') && !await acquireAssessmentLease('portal')) return;
        renewAssessmentLease('portal');
        const request = gmGet(ASSESSMENT_KEYS.request, null);
        if (!assessmentMessageValid(request, run) || request.requestId === state.handledRequest) return;
        state.handledRequest = request.requestId;
        state.phase = 'VERIFYING';
        const opened = await openAssessmentOverview(state.context, { refresh: true });
        const snapshot = opened.verified ? await scanAssessmentOverview(opened) : null;
        if (!ownsAssessmentLease('portal') || !assessmentMessageValid(request, gmGet(ASSESSMENT_KEYS.run, null))) return;
        gmSet(ASSESSMENT_KEYS.response, { ...request, createdAt: Date.now(), expiresAt: Date.now() + 90000, snapshot, error: opened.error || snapshot?.error || '', verifiedAt: snapshot?.observedAt || 0 });
        state.phase = 'WAITING_PLAYER';
        const checkpoint = gmGet(`fzugk-assessment-checkpoint-v1:${state.context.courseKey}`, null);
        if (checkpoint?.runId === state.runId) state.queue = checkpoint.queue;
    }

    async function assessmentPlayerTick() {
        const state = assessmentState();
        const run = gmGet(ASSESSMENT_KEYS.run, null);
        const vm = assessmentVm(root.document, 'player');
        if (!assessmentRunValid(run) || !vm || String(vm.coursewareCode) !== state.context.coursewareCode || assessmentText(extractCourseInfo().course) !== assessmentText(state.context.courseTitle)) { stop(); return; }
        if (!ownsAssessmentLease('player')) {
            if (!await acquireAssessmentLease('player')) { state.phase = 'WAITING_OWNER'; return; }
            const checkpoint = gmGet(`fzugk-assessment-checkpoint-v1:${state.context.courseKey}`, null);
            if (checkpoint?.runId === state.runId) {
                state.queue = checkpoint.queue; state.index = checkpoint.index;
                state.target = state.queue.find((row) => row.knowledgeKey === checkpoint.targetKey) || null;
                state.submissionAt = checkpoint.submissionAt;
            }
            state.phase = 'VERIFYING';
            state.verifyStep = 0;
            requestAssessmentVerification(false);
            return;
        }
        renewAssessmentLease('player');
        syncStudyContext();
        holdPlatformContinuousPlayback();
        if (state.phase === 'VERIFYING') {
            for (const video of findVideos()) video.pause();
            const response = gmGet(ASSESSMENT_KEYS.response, null);
            if (assessmentMessageValid(response, run) && response.requestId === state.requestId) {
                if (!response.snapshot?.complete || response.verifiedAt <= state.submissionAt) {
                    assessmentDefer(response.error || 'OVERVIEW_STALE_OR_INCOMPLETE'); completeAssessmentRun('PARTIAL'); return;
                }
                state.snapshot = response.snapshot;
                state.queue = assessmentQueue(response.snapshot, state.queue, state.index);
                state.requestId = '';
                if (assessmentSummary(state.snapshot).allPassed) { completeAssessmentRun('DONE'); return; }
                const targets = state.target ? state.queue.filter((row) => row.lessonKey === state.target.lessonKey && row.queueState !== 'DONE') : [];
                if (targets.length && state.submissionAt) {
                    if (state.verifyStep < ASSESSMENT_LIMITS.verificationMs.length - 1) {
                        state.verifyStep += 1;
                        state.verifyAt = Date.now();
                        return;
                    }
                    assessmentDefer('PLATFORM_STATUS_NOT_UPDATED');
                    return;
                }
                if (state.finalRequested) { completeAssessmentRun('PARTIAL'); return; }
                state.target = null;
                state.submissionAt = 0;
                state.phase = 'LOCATING';
            } else if (state.requestId && Date.now() - state.verifyAt > 90000) { assessmentDefer('OVERVIEW_COORDINATOR_UNAVAILABLE'); completeAssessmentRun('PARTIAL'); return; }
            else if (!state.requestId && Date.now() - state.verifyAt >= ASSESSMENT_LIMITS.verificationMs[state.verifyStep]) requestAssessmentVerification(state.finalRequested);
            return;
        }
        state.index = buildKnowledgeNodeIndex(state.context, state.index);
        state.queue = assessmentQueue(state.snapshot, state.queue, state.index);
        if (state.phase === 'RUNNING') {
            if (!findQuestionNodes().length) {
                if (state.submissionAt) {
                    state.phase = 'VERIFYING'; state.verifyStep = 0;
                    requestAssessmentVerification(false);
                } else if (Date.now() - state.runningAt > ASSESSMENT_LIMITS.navigationMs) assessmentDefer('QUIZ_OPEN_FAILED');
                else state.error = 'WAITING_TARGET_QUIZ';
                return;
            }
            if (!assessmentMayAnswer()) { assessmentDefer('QUESTION_OR_LESSON_MISMATCH'); return; }
            if (await resumePendingCorrection()) return;
            if (await repairVisibleWrongQuestion()) return;
            if (clickCourseQuizFollowup()) return;
            for (const node of findQuestionNodes()) {
                const parsed = parseQuestion(node);
                if (!state.submissionAt) runtime.processedQuestions.delete(parsed.fingerprint);
            }
            if (await handleQuestions()) return;
            return;
        }
        if (findQuestionNodes().length || runtime.pendingCorrection) { state.error = 'UNSUBMITTED_QUESTION_PRESENT'; return; }
        for (const video of findVideos()) video.pause();
        const pending = state.queue.filter((row) => ['FAILED', 'NOT_STARTED'].includes(row.platformStatus) && row.queueState === 'PENDING' && row.attempts < ASSESSMENT_LIMITS.attempts);
        if (!pending.length) { state.phase = 'VERIFYING'; state.verifyStep = 0; state.submissionAt = Math.max(0, ...state.queue.map((row) => row.submissionAt || 0)); requestAssessmentVerification(true); return; }
        const mapped = pending.find((row) => row.mappingStatus === 'EXACT');
        if (mapped) {
            state.target = mapped;
            if (cwsActiveLesson()?.id !== mapped.lessonKey) {
                if (state.nav?.id === mapped.lessonKey && Date.now() - state.nav.at < ASSESSMENT_LIMITS.navigationMs) return;
                if (state.nav?.id === mapped.lessonKey) { assessmentDefer('NAVIGATION_TIMEOUT'); return; }
                if (navigateAssessmentLesson(mapped.lessonKey)) state.nav = { id: mapped.lessonKey, at: Date.now() };
                return;
            }
            const verified = resolveAssessmentTarget(mapped, buildKnowledgeNodeIndex(state.context));
            if (verified.mappingStatus !== 'EXACT' || verified.lessonKey !== mapped.lessonKey || vm.spinShow) {
                state.targetWaitAt ||= Date.now();
                if (Date.now() - state.targetWaitAt >= ASSESSMENT_LIMITS.navigationMs) assessmentDefer('TARGET_LOAD_TIMEOUT');
                else state.error = 'TARGET_NOT_LOADED';
                return;
            }
            state.targetWaitAt = 0;
            const entries = assessmentControls(root.document.querySelector('.video-box') || root.document, ['知识点弹题', '开始测评', '重做']);
            // Observed platform p.toPlayTime is a real clickable control, though it
            // does not expose role=button. Do not substitute arbitrary text spans.
            const known = [...root.document.querySelectorAll('.video-box .toPlayTime')].filter((el) => isVisible(el) && assessmentText(el.innerText) === '知识点弹题');
            const buttons = uniqueElements([...entries, ...known]);
            if (buttons.length !== 1 || !assessmentClickable(buttons[0])) { assessmentDefer('NO_UNIQUE_REDO_ENTRY'); return; }
            for (const row of state.queue.filter((item) => item.lessonKey === mapped.lessonKey && item.queueState === 'PENDING')) { row.attempts += 1; row.queueState = 'RUNNING'; row.runId = state.runId; }
            state.phase = 'RUNNING';
            state.runningAt = Date.now();
            state.submissionAt = 0;
            state.nav = null;
            buttons[0].click();
            // Forget only fingerprints of the target popup, never the whole bank.
            for (const node of findQuestionNodes()) runtime.processedQuestions.delete(parseQuestion(node).fingerprint);
            saveAssessmentCheckpoint();
            log(`已打开目标测评：${mapped.knowledgeTitle} / ${mapped.lessonTitle}`);
            return;
        }
        if (state.nav) {
            if (cwsActiveLesson()?.id === state.nav.id && `video_${assessmentId(vm.nodeData.id)}` === state.nav.id && !vm.spinShow && (!vm.questionList.length || vm.questionList.every((q) => `video_${assessmentId(q.catalogId)}` === state.nav.id))) {
                // Wait for normal chapter requests to settle, without assuming that
                // the new active CSS class alone means question data has arrived.
                if (Date.now() - state.nav.at < 1200) return;
                state.visited.add(state.nav.id);
                state.index = buildKnowledgeNodeIndex(state.context, state.index);
                state.nav = null;
                saveAssessmentCheckpoint();
            } else if (Date.now() - state.nav.at >= ASSESSMENT_LIMITS.navigationMs) {
                state.visited.add(state.nav.id); state.error = 'INDEX_LOAD_TIMEOUT'; state.nav = null;
            }
            return;
        }
        const candidates = cwsCatalogRows().filter((row) => !state.visited.has(row.id));
        candidates.sort((a, b) => {
            const score = (row) => pending.some((target) => assessmentText(cwsLessonTitle(row)).includes(assessmentText(target.knowledgeTitle))) ? 1 : 0;
            return score(b) - score(a);
        });
        const next = candidates[0];
        if (!next) {
            for (const row of pending) { row.queueState = 'DEFERRED'; row.lastError = row.mappingStatus === 'AMBIGUOUS' ? 'MAPPING_AMBIGUOUS' : 'MAPPING_MISSING'; }
            state.error = 'MAPPING_INCOMPLETE'; saveAssessmentCheckpoint(); return;
        }
        state.discoveryStartedAt ||= Date.now();
        if (Date.now() - state.discoveryStartedAt > ASSESSMENT_LIMITS.scanMs) {
            for (const row of pending) { row.queueState = 'DEFERRED'; row.lastError = 'INDEX_SCAN_TIMEOUT'; }
            saveAssessmentCheckpoint(); return;
        }
        if (state.entryWait?.id !== next.id) state.entryWait = { id: next.id, at: Date.now() };
        if (navigateAssessmentLesson(next.id)) { state.nav = { id: next.id, at: Date.now() }; state.entryWait = null; }
        else if (Date.now() - state.entryWait.at > ASSESSMENT_LIMITS.navigationMs) { state.visited.add(next.id); state.error = 'DIRECTORY_ENTRY_BLOCKED'; state.entryWait = null; }
    }

    function completeAssessmentRun(status) {
        const state = assessmentState();
        saveAssessmentCheckpoint();
        if (state.heartbeat) root.clearInterval(state.heartbeat);
        state.heartbeat = null;
        const run = gmGet(ASSESSMENT_KEYS.run, null);
        if (run?.runId === state.runId) gmSet(ASSESSMENT_KEYS.run, { ...run, status, finishedAt: Date.now() });
        state.phase = status;
        runtime.state = status === 'DONE' ? 'DONE' : 'ASSESSMENT_PENDING';
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.timer = null;
        cancelPendingAssistantWork();
        saveSettings({ enabled: false });
        runtime.mode = 'STUDY';
        for (const video of findVideos()) video.pause();
        log(status === 'DONE' ? '最新完整平台详情已确认，测评补齐完成' : '测评补齐部分完成，剩余项目与原因已保存', status === 'DONE' ? 'info' : 'warn');
    }

    async function assessmentTick() {
        const state = assessmentState();
        runtime.state = `ASSESSMENT_${state.phase}`;
        const exam = detectExamPage();
        if (exam.matched) { stopForExam(exam.reasons); return; }
        if (detectLoginPage()) { stop(); state.error = 'LOGIN_REQUIRED'; return; }
        if (assessmentVm(root.document, 'portal')) await assessmentPortalTick();
        else if (assessmentVm(root.document, 'player')) await assessmentPlayerTick();
        else { state.error = 'UNSUPPORTED_PAGE'; }
        updatePanel();
    }

    function registerAssessmentSync() {
        if (typeof GM_addValueChangeListener !== 'function') return;
        GM_addValueChangeListener(ASSESSMENT_KEYS.run, (_key, _old, value, remote) => {
            if (!remote) return;
            const state = assessmentState();
            if (value?.status === 'ACTIVE' && runtime.mode === 'ASSESSMENT' && state.runId && value.runId !== state.runId) {
                assessmentCancel('RUN_REPLACED', false);
                cancelPendingAssistantWork();
                if (runtime.timer) root.clearInterval(runtime.timer);
                runtime.timer = null;
                runtime.settings.enabled = false;
                runtime.state = 'PAUSED';
                for (const video of findVideos()) video.pause();
                updatePanel();
            }
            if (value?.runId === state.runId && value.status !== 'ACTIVE' && runtime.mode === 'ASSESSMENT') {
                state.phase = value.status; assessmentCancel(value.status, false);
                if (runtime.timer) root.clearInterval(runtime.timer);
                runtime.timer = null; runtime.settings.enabled = false;
                state.phase = value.status;
                runtime.state = value.status === 'DONE' ? 'DONE' : 'ASSESSMENT_PENDING';
                updatePanel();
                return;
            }
            if (value?.status === 'ACTIVE') {
                if (assessmentVm(root.document, 'portal') && assessmentContexts().some((item) => item.courseKey === value.context?.courseKey)) {
                    state.context = value.context; state.runId = value.runId; state.phase = 'WAITING_PLAYER'; state.stopped = false;
                    runtime.mode = 'ASSESSMENT'; runtime.settings.enabled = true; startAssessmentTimer();
                } else adoptAssessmentRun(value).catch((error) => log(`测评协调失败：${error.message}`, 'warn'));
            }
        });
    }

    async function resumeAssessmentNavigation() {
        const request = gmGet(ASSESSMENT_KEYS.navigation, null);
        if (request?.schemaVersion !== 1 || !request.context?.courseKey || !request.requestId || request.expiresAt <= Date.now() || request.createdAt > Date.now() || request.expiresAt - request.createdAt > 30000) return false;
        const opened = assessmentDetail(request.context, { courseKey: request.context.courseKey, clickedAt: request.createdAt });
        if (!opened) return false;
        const snapshot = await scanAssessmentOverview(opened);
        if (gmGet(ASSESSMENT_KEYS.navigation, null)?.requestId !== request.requestId) return false;
        gmSet(ASSESSMENT_KEYS.navigationResponse, { schemaVersion: 1, requestId: request.requestId, courseKey: request.context.courseKey, snapshot, expiresAt: Date.now() + 30000 });
        assessmentState().phase = snapshot.complete ? 'READY' : 'DEFERRED';
        log('已核验新文档测评详情并保存快照');
        return true;
    }

    function detectCourseComplete() {
        const selectors = ['.course-progress', '.study-progress', '.completion-status', '.finished-tip', '.course-finished', '[class*="complete" i]'];
        const text = selectors.flatMap((selector) => [...root.document.querySelectorAll(selector)])
            .filter(isVisible)
            .map((element) => element.innerText)
            .join(' ');
        return /(课程已完成|本课程已完成|全部完成|学习完成|已学完|恭喜.*完成)/.test(text);
    }

    async function finishCourse() {
        let context = assessmentState().context;
        const vm = assessmentVm(root.document, 'player');
        if (vm && runtime.mode !== 'ASSESSMENT') {
            const contexts = gmGet('fzugk-assessment-contexts-v1', []);
            const matches = contexts.filter((item) => item.coursewareCode === String(vm.coursewareCode) && assessmentText(item.courseTitle) === assessmentText(extractCourseInfo().course));
            if (matches.length === 1) {
                const state = assessmentState();
                context = matches[0]; state.context = context;
                state.runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
                state.queue = []; state.index = []; state.target = null; state.submissionAt = 0; state.verifyStep = 0; state.stopped = false;
                gmSet(ASSESSMENT_KEYS.run, { schemaVersion: 1, runId: state.runId, context, status: 'ACTIVE', createdAt: Date.now(), expiresAt: Date.now() + 7200000, purpose: 'FINISH_CHECK' });
                runtime.mode = 'ASSESSMENT';
                if (await acquireAssessmentLease('player')) { state.phase = 'VERIFYING'; requestAssessmentVerification(false); }
                else state.phase = 'WAITING_OWNER';
                log('视频收尾：已自动请求入口页完整查漏，未完成测评将进入补齐');
                return;
            }
        }
        const snapshot = context && gmGet(ASSESSMENT_KEYS.snapshots, {})[context.courseKey];
        if (!context || assessmentText(context.courseTitle) !== assessmentText(extractCourseInfo().course) || (vm && context.coursewareCode !== String(vm.coursewareCode)) || !snapshot?.complete || Date.now() - snapshot.observedAt > ASSESSMENT_LIMITS.snapshotMs || !assessmentSummary(snapshot).allPassed) {
            runtime.state = 'ASSESSMENT_PENDING';
            assessmentState().error = '视频完成，测评待核实';
            if (runtime.timer) root.clearInterval(runtime.timer);
            runtime.timer = null;
            saveSettings({ enabled: false });
            log('视频完成，测评待核实：需要由课程列表页重新打开同课程进入评测并扫描', 'warn');
            return;
        }
        runtime.state = 'DONE';
        cancelPendingAssistantWork();
        const { course } = extractCourseInfo();
        const exportKey = `${course}:${dateStamp()}`;
        if (runtime.settings.autoExportDocx && runtime.settings.exportOnCourseComplete && runtime.lastExportKey !== exportKey) {
            try {
                await exportDocx('course');
                runtime.lastExportKey = exportKey;
            } catch (error) {
                log(`课程完成，但 Word 自动导出失败：${error.message}`, 'error');
                notify('复习文档待导出', '自动下载可能被浏览器阻止，请点击面板中的“导出 Word”。');
            }
        }
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.timer = null;
        saveSettings({ enabled: false });
        notify('课程学习完成', `${course} 已完成，学习助手已停止。`);
    }

    function clickNextUnit(videoState) {
        if (runtime.mode === 'ASSESSMENT') return false;
        if (!runtime.settings.autoAdvance || !canAdvanceLesson(videoState)) return false;
        const current = cwsActiveLesson();
        if (current) {
            const rows = cwsCatalogRows(current.ownerDocument);
            const next = rows[rows.indexOf(current) + 1];
            if (!next) return false;
            if (!isVisible(next)) {
                // Expand the actual next group; never skip a collapsed chapter.
                for (let scope = next.parentElement; scope; scope = scope.parentElement) {
                    if (scope.tagName !== 'UL' || isVisible(scope)) continue;
                    const heading = [...scope.parentElement.children].find((child) => child.classList.contains('videoTitle'));
                    if (!heading || !isVisible(heading)) continue;
                    heading.click();
                    log(`已展开下一章节目录：${heading.innerText.trim()}`);
                    return true;
                }
                return false;
            }
            runtime.expectedLessonId = next.id;
            runtime.advancedMediaKey = videoState.key;
            runtime.state = 'ADVANCING';
            next.click();
            runtime.lastProgressAt = Date.now();
            log(`已点击下一目录项：${cwsLessonTitle(next)}；本节平台进度 100%`);
            return true;
        }
        const candidates = [...root.document.querySelectorAll('button, a, [role="button"]')].filter(isVisible);
        const button = candidates.find((element) => {
            const text = String(element.innerText || element.getAttribute('title') || '').replace(/\s+/g, '');
            return /^(下一节|下一章|下一单元|下一课|继续学习)$/.test(text);
        });
        if (!button) return false;
        button.click();
        runtime.advancedMediaKey = videoState.key;
        runtime.state = 'ADVANCING';
        runtime.lastProgressAt = Date.now();
        runtime.processedQuestions.clear();
        log(`已切换：${String(button.innerText || button.title).trim()}`);
        return true;
    }

    function stopForExam(reasons) {
        if (runtime.mode === 'ASSESSMENT') assessmentCancel('EXAM_OR_IDENTITY_BLOCKED');
        const identityOnly = reasons?.length === 1 && reasons[0] === '身份验证提示';
        runtime.stoppedByExam = !identityOnly;
        runtime.state = identityOnly ? 'IDENTITY_REQUIRED' : 'EXAM_BLOCKED';
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.timer = null;
        cancelPendingAssistantWork();
        runtime.pendingCorrection = null;
        saveSettings({ enabled: false });
        if (identityOnly) {
            log('检测到身份验证提示，学习助手已暂停。请本人完成验证后重新启动。', 'warn');
            notify('身份验证需本人完成', '请本人完成页面验证后重新启动学习助手。');
            return;
        }
        const reason = (reasons || []).join('、') || '考试页面';
        log(`检测到${reason}，脚本已停止。考试由用户本人完成。`, 'warn');
        notify('学习助手已停止', `检测到${reason}，请本人接管考试。`);
    }

    function pause(reason = '用户暂停') {
        if (runtime.mode === 'ASSESSMENT') assessmentCancel(reason);
        runtime.state = 'PAUSED';
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.timer = null;
        cancelPendingAssistantWork();
        saveSettings({ enabled: false });
        log(reason, 'warn');
        notify('学习助手已暂停', reason);
    }

    function start() {
        if (runtime.mode === 'ASSESSMENT') assessmentCancel('NORMAL_STUDY_STARTED');
        if (detectLoginPage()) {
            runtime.state = 'IDLE';
            log('登录页不执行自动化，请正常登录并进入课程后启动。');
            return;
        }
        const exam = detectExamPage();
        if (exam.matched) {
            stopForExam(exam.reasons);
            return;
        }
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.stoppedByExam = false;
        saveSettings({ enabled: true });
        runtime.state = 'SCANNING';
        runtime.timer = root.setInterval(() => tick().catch((error) => {
            runtime.busy = false;
            runtime.state = 'ERROR';
            log(`主循环异常：${error.message}`, 'error');
        }), runtime.settings.loopIntervalMs);
        tick().catch((error) => log(`启动失败：${error.message}`, 'error'));
        log(`刷课全自动模式已启动（脚本 ${VERSION}）`);
    }

    function stop() {
        if (runtime.mode === 'ASSESSMENT') assessmentCancel('USER_STOPPED');
        if (runtime.timer) root.clearInterval(runtime.timer);
        runtime.timer = null;
        cancelPendingAssistantWork();
        runtime.pendingCorrection = null;
        runtime.state = 'IDLE';
        saveSettings({ enabled: false });
        log('学习助手已停止');
    }

    async function tick() {
        if (runtime.busy || !runtime.settings.enabled) return;
        runtime.busy = true;
        try {
            if (runtime.mode === 'ASSESSMENT') { await assessmentTick(); return; }
            if (runtime.lastUrl !== root.location.href) {
                runtime.lastUrl = root.location.href;
                runtime.answerGeneration += 1;
                runtime.processedQuestions.clear();
                runtime.correctionAttempts.clear();
                runtime.pendingCorrection = null;
                runtime.state = 'SCANNING';
            }
            const exam = detectExamPage();
            if (exam.matched) return stopForExam(exam.reasons);
            syncStudyContext();
            holdPlatformContinuousPlayback();
            await syncCourseMaterials().catch((error) => log(`课程资料同步失败：${error.message}`, 'warn'));
            if (await resumePendingCorrection()) return;
            if (await repairVisibleWrongQuestion()) return;
            if (clickCourseQuizFollowup()) return;
            if (clickAllowedDialog()) return;
            if (await handleQuestions()) return;
            let videoState = await playVideos();
            if (videoState.replayNeeded) {
                runtime.state = 'VERIFYING';
                await replayIncompleteLesson(videoState);
                return;
            }
            if (!videoState.found && runtime.settings.autoAdvanceNoMedia && activeLessonProgress() === 100) {
                videoState = { found: false, complete: true, key: `${runtime.studyContextKey}::no-media` };
            }
            if (videoState.found && !videoState.complete) return;
            runtime.state = 'VERIFYING';
            if (videoState.complete && !canAdvanceLesson(videoState)) {
                await replayIncompleteLesson(videoState);
                return;
            }
            if (clickPlatformNextDialog(videoState)) return;
            if (clickNextUnit(videoState)) return;
            const rows = cwsCatalogRows();
            if (detectCourseComplete() || (rows.length && cwsActiveLesson() === rows[rows.length - 1] && videoState.complete && activeLessonProgress() === 100)) await finishCourse();
        } finally {
            runtime.busy = false;
        }
    }

    function crc32(bytes) {
        if (!crc32.table) {
            crc32.table = new Uint32Array(256);
            for (let n = 0; n < 256; n += 1) {
                let c = n;
                for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
                crc32.table[n] = c >>> 0;
            }
        }
        let crc = 0xFFFFFFFF;
        for (const byte of bytes) crc = crc32.table[(crc ^ byte) & 0xFF] ^ (crc >>> 8);
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }

    function u16(value) {
        return new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF]);
    }

    function u32(value) {
        return new Uint8Array([value & 0xFF, (value >>> 8) & 0xFF, (value >>> 16) & 0xFF, (value >>> 24) & 0xFF]);
    }

    function concatBytes(parts) {
        const total = parts.reduce((sum, part) => sum + part.length, 0);
        const output = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) {
            output.set(part, offset);
            offset += part.length;
        }
        return output;
    }

    function dosDateTime(date = new Date()) {
        const year = Math.max(1980, date.getFullYear());
        return {
            time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
            date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
        };
    }

    function createStoredZip(files) {
        const encoder = new TextEncoder();
        const locals = [];
        const centrals = [];
        let offset = 0;
        const stamp = dosDateTime();
        for (const file of files) {
            const name = encoder.encode(file.name);
            const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
            const checksum = crc32(data);
            const local = concatBytes([
                u32(0x04034B50), u16(20), u16(0x0800), u16(0), u16(stamp.time), u16(stamp.date),
                u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), name, data
            ]);
            locals.push(local);
            centrals.push(concatBytes([
                u32(0x02014B50), u16(20), u16(20), u16(0x0800), u16(0), u16(stamp.time), u16(stamp.date),
                u32(checksum), u32(data.length), u32(data.length), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), name
            ]));
            offset += local.length;
        }
        const central = concatBytes(centrals);
        const end = concatBytes([
            u32(0x06054B50), u16(0), u16(0), u16(files.length), u16(files.length), u32(central.length), u32(offset), u16(0)
        ]);
        return concatBytes([...locals, central, end]);
    }

    function wRun(text, options = {}) {
        const props = [
            options.bold ? '<w:b/>' : '',
            options.color ? `<w:color w:val="${options.color}"/>` : '',
            options.size ? `<w:sz w:val="${options.size * 2}"/><w:szCs w:val="${options.size * 2}"/>` : ''
        ].join('');
        return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
    }

    function wParagraph(text = '', style = '', options = {}) {
        const pProps = [
            style ? `<w:pStyle w:val="${style}"/>` : '',
            options.keepNext ? '<w:keepNext/>' : '',
            options.pageBreakBefore ? '<w:pageBreakBefore/>' : '',
            options.spacingAfter != null ? `<w:spacing w:after="${options.spacingAfter}"/>` : ''
        ].join('');
        return `<w:p>${pProps ? `<w:pPr>${pProps}</w:pPr>` : ''}${wRun(text, options)}</w:p>`;
    }

    function wTable(rows, widths) {
        const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
        const body = rows.map((row, rowIndex) => `<w:tr>${row.map((cell, cellIndex) => {
            const fill = rowIndex === 0 ? '<w:shd w:fill="D9EAF7"/>' : (rowIndex % 2 === 0 ? '<w:shd w:fill="F7FAFC"/>' : '');
            const width = widths[cellIndex] || widths[widths.length - 1];
            return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${fill}<w:vAlign w:val="center"/><w:tcMar><w:top w:w="100" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tcMar></w:tcPr>${wParagraph(String(cell), '', { bold: rowIndex === 0, size: rowIndex === 0 ? 10.5 : 10 })}</w:tc>`;
        }).join('')}</w:tr>`).join('');
        return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders><w:top w:val="single" w:sz="4" w:color="D9D9D9"/><w:left w:val="single" w:sz="4" w:color="D9D9D9"/><w:bottom w:val="single" w:sz="4" w:color="D9D9D9"/><w:right w:val="single" w:sz="4" w:color="D9D9D9"/><w:insideH w:val="single" w:sz="4" w:color="D9D9D9"/><w:insideV w:val="single" w:sz="4" w:color="D9D9D9"/></w:tblBorders></w:tblPr><w:tblGrid>${grid}</w:tblGrid>${body}</w:tbl>`;
    }

    function buildDocumentXml(records, scopeTitle) {
        const correct = records.filter((record) => record.result === '正确').length;
        const wrong = records.filter((record) => record.result === '错误').length;
        const review = records.filter((record) => record.conflict || record.result === '未知').length;
        const accuracy = correct + wrong ? `${Math.round(correct / (correct + wrong) * 100)}%` : '暂无';
        const byChapter = new Map();
        for (const record of records) {
            const key = record.chapter || '未识别章节';
            if (!byChapter.has(key)) byChapter.set(key, []);
            byChapter.get(key).push(record);
        }
        const body = [];
        body.push(wParagraph(`${scopeTitle}刷课题目复习资料`, 'Title', { keepNext: true }));
        body.push(wParagraph(`本资料由学习助手根据刷课阶段已作答的随堂练习自动整理。正式考试题目不会被收集。导出时间：${new Date().toLocaleString('zh-CN')}`, '', { size: 11, spacingAfter: 200 }));
        body.push(wParagraph('复习概览', 'Heading1', { keepNext: true }));
        body.push(wTable([
            ['题目总数', '正确', '错误', '待复核', '正确率'],
            [records.length, correct, wrong, review, accuracy]
        ], [1800, 1500, 1500, 1500, 1800]));
        body.push(wParagraph('章节目录', 'Heading1', { keepNext: true }));
        let chapterIndex = 1;
        for (const [chapter, questions] of byChapter) {
            body.push(wParagraph(`${chapterIndex}. ${chapter}（${questions.length} 题）`, '', { size: 11 }));
            chapterIndex += 1;
        }
        const priority = records.filter((record) => record.result === '错误' || record.conflict || record.result === '未知');
        if (priority.length) {
            body.push(wParagraph('错题与待复核题', 'Heading1', { keepNext: true, pageBreakBefore: true }));
            priority.forEach((record, index) => body.push(...questionParagraphs(record, index + 1)));
        }
        body.push(wParagraph('全部题目', 'Heading1', { keepNext: true, pageBreakBefore: priority.length > 0 }));
        chapterIndex = 1;
        for (const [chapter, questions] of byChapter) {
            body.push(wParagraph(`${chapterIndex} ${chapter}`, 'Heading2', { keepNext: true }));
            questions.forEach((record, index) => body.push(...questionParagraphs(record, index + 1)));
            chapterIndex += 1;
        }
        body.push(wParagraph('复习统计', 'Heading1', { keepNext: true, pageBreakBefore: true }));
        const statsRows = [['章节', '题目数', '错题', '待复核']];
        for (const [chapter, questions] of byChapter) {
            statsRows.push([
                chapter,
                questions.length,
                questions.filter((item) => item.result === '错误').length,
                questions.filter((item) => item.conflict || item.result === '未知').length
            ]);
        }
        body.push(wTable(statsRows, [4600, 1300, 1300, 1300]));
        body.push(`<w:sectPr><w:footerReference w:type="default" r:id="rId1"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`);
        return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join('')}</w:body></w:document>`;
    }

    function questionParagraphs(record, number) {
        const lines = [];
        const status = record.conflict ? '需复核' : record.result || '未知';
        lines.push(wParagraph(`${number}. ${record.stem}`, '', { bold: true, size: 11, keepNext: true, spacingAfter: 80 }));
        for (const option of record.options || []) lines.push(wParagraph(`${option.key}. ${option.text}`, '', { size: 10.5, spacingAfter: 40 }));
        lines.push(wParagraph(`提交答案：${(record.submittedAnswer || []).join('、') || '未记录'}`, '', { size: 10.5 }));
        lines.push(wParagraph(`正确答案：${record.correctAnswer || '平台未提供'}`, '', { size: 10.5, bold: true }));
        lines.push(wParagraph(`结果：${status}　来源：${record.answerSource || '未记录'}　置信度：${record.confidence == null ? '未记录' : `${Math.round(record.confidence * 100)}%`}　出现次数：${record.occurrences || 1}`, '', { size: 10 }));
        if (record.explanation) lines.push(wParagraph(`解析：${record.explanation}`, '', { size: 10.5 }));
        if (record.evidence?.length) lines.push(wParagraph(`证据：${record.evidence.join('；')}`, '', { size: 10 }));
        for (const citation of (record.citations || []).slice(0, 6)) {
            const time = citation.startTime == null ? '' : `（视频 ${Math.round(citation.startTime)}${citation.endTime == null ? '' : `-${Math.round(citation.endTime)}`} 秒）`;
            const page = citation.page ? `（第 ${citation.page} 页）` : '';
            lines.push(wParagraph(`来源：${citation.title || '课程资料'}${page}${time}${citation.url ? `　${citation.url}` : ''}`, '', { size: 9.5 }));
        }
        if (record.conflict) lines.push(wParagraph('提示：本题曾出现不同答案或判定结果，请复核。', '', { size: 10.5, bold: true }));
        lines.push(wParagraph('', '', { spacingAfter: 160 }));
        return lines;
    }

    function buildDocxBytes(records, scopeTitle = '课程') {
        const documentXml = buildDocumentXml(records, scopeTitle);
        const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:color w:val="000000"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="360" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:before="0" w:after="300"/><w:jc w:val="center"/></w:pPr><w:rPr><w:rFonts w:ascii="Microsoft YaHei" w:hAnsi="Microsoft YaHei" w:eastAsia="Microsoft YaHei"/><w:b/><w:color w:val="000000"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="160"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="220" w:after="120"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:style></w:styles>`;
        const footerXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`;
        const files = [
            { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
            { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
            { name: 'word/document.xml', data: documentXml },
            { name: 'word/styles.xml', data: stylesXml },
            { name: 'word/footer1.xml', data: footerXml },
            { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
            { name: 'docProps/core.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(scopeTitle)}刷课题目复习资料</dc:title><dc:creator>福州大学自考学习无障碍助手</dc:creator><cp:lastModifiedBy>福州大学自考学习无障碍助手</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${nowIso()}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${nowIso()}</dcterms:modified></cp:coreProperties>` },
            { name: 'docProps/app.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>福州大学自考学习无障碍助手</Application></Properties>` }
        ];
        return createStoredZip(files);
    }

    async function exportDocx(scope = 'course') {
        const { course } = extractCourseInfo();
        const records = await getArchivedQuestions(scope === 'all' ? '' : course);
        const filtered = scope === 'wrong' ? records.filter((record) => record.result === '错误' || record.conflict || record.result === '未知') : records;
        if (!filtered.length) {
            notify('没有可导出的题目', '当前范围尚未记录刷课随堂题。');
            return null;
        }
        const title = scope === 'all' ? '全部课程' : course;
        const bytes = buildDocxBytes(filtered, title);
        const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
        const url = URL.createObjectURL(blob);
        const anchor = root.document.createElement('a');
        anchor.href = url;
        const fileName = `${safeFileName(title)}_刷课题目复习资料_${dateStamp()}.docx`;
        anchor.download = fileName;
        anchor.style.display = 'none';
        root.document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        runtime.pendingDownload = { url, fileName, createdAt: Date.now() };
        root.setTimeout(() => URL.revokeObjectURL(url), 30000);
        runtime.lastExportKey = `${title}:${dateStamp()}`;
        log(`已生成 Word 复习文档，共 ${filtered.length} 题`);
        return { count: filtered.length, fileName };
    }

    function createPanel() {
        if (!root.document?.body || root.document.getElementById(`${SCRIPT_ID}-panel`)) return;
        const panel = root.document.createElement('section');
        panel.id = `${SCRIPT_ID}-panel`;
        panel.innerHTML = `
            <div class="fzugk-head"><strong>学习无障碍助手</strong><button data-action="collapse" title="收起">−</button></div>
            <div class="fzugk-body">
                <div class="fzugk-status"><span data-role="state">IDLE</span><span data-role="course">未识别课程</span></div>
                <div class="fzugk-actions">
                    <button data-action="start">启动全自动</button>
                    <button data-action="stop">停止</button>
                    <button data-action="export">导出 Word</button>
                </div>
                <div class="fzugk-meta" data-role="meta">正式考试永不自动化</div>
                <div class="fzugk-service" data-role="service">本地 AI：未配置</div>
                <div class="fzugk-assessment">
                    <strong>测评查漏 · ${VERSION}</strong>
                    <select data-role="assessment-course" aria-label="测评目标课程" style="width:100%;margin:6px 0"></select>
                    <div data-role="assessment-status">测评未扫描</div>
                    <div class="fzugk-actions" style="margin-top:6px">
                        <button data-action="assessment-scan">扫描遗漏</button>
                        <button data-action="assessment-start">补齐未完成</button>
                        <button data-action="assessment-locate">定位</button>
                        <button data-action="assessment-pause">暂停</button>
                        <button data-action="assessment-verify">重新核验</button>
                    </div>
                </div>
                <div class="fzugk-log" data-role="log"></div>
            </div>`;
        const style = root.document.createElement('style');
        style.textContent = `
            #${SCRIPT_ID}-panel{position:fixed;right:18px;bottom:18px;width:330px;z-index:2147483646;background:#fff;color:#111;border:1px solid #999;border-radius:10px;box-shadow:0 6px 24px rgba(0,0,0,.22);font:14px/1.45 "Microsoft YaHei",sans-serif}
            #${SCRIPT_ID}-panel .fzugk-head{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#17365d;color:#fff;border-radius:9px 9px 0 0}
            #${SCRIPT_ID}-panel button{min-height:36px;padding:7px 11px;border:1px solid #777;border-radius:6px;background:#f7f7f7;color:#111;cursor:pointer}
            #${SCRIPT_ID}-panel .fzugk-head button{min-height:28px;padding:1px 9px;border-color:#fff;background:transparent;color:#fff}
            #${SCRIPT_ID}-panel .fzugk-body{padding:11px}
            #${SCRIPT_ID}-panel .fzugk-status{display:grid;grid-template-columns:110px 1fr;gap:8px;margin-bottom:9px;font-weight:700}
            #${SCRIPT_ID}-panel .fzugk-actions{display:flex;gap:7px;flex-wrap:wrap;margin-bottom:8px}
            #${SCRIPT_ID}-panel .fzugk-actions button:first-child{background:#e2f0d9;border-color:#70ad47}
            #${SCRIPT_ID}-panel .fzugk-meta{font-size:12px;color:#8a1c1c;margin:7px 0}
            #${SCRIPT_ID}-panel .fzugk-log{max-height:120px;overflow:auto;padding:7px;background:#f6f7f8;border-radius:5px;font-size:12px;white-space:pre-wrap}
            #${SCRIPT_ID}-panel.fzugk-collapsed .fzugk-body{display:none}`;
        root.document.head.appendChild(style);
        root.document.body.appendChild(panel);
        runtime.panel = panel;
        panel.addEventListener('click', async (event) => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action === 'start') start();
            if (action === 'stop') stop();
            if (action === 'assessment-scan' || action === 'assessment-verify') await scanSelectedAssessment();
            if (action === 'assessment-start') await startAssessmentRecovery();
            if (action === 'assessment-pause') stop();
            if (action === 'assessment-locate') {
                const target = assessmentState().target || assessmentState().queue.find((row) => row.mappingStatus === 'EXACT' && row.queueState !== 'DONE');
                if (target && runtime.mode === 'ASSESSMENT') navigateAssessmentLesson(target.lessonKey);
                else log('定位未执行：尚无已核验且唯一匹配的运行目标', 'warn');
            }
            if (action === 'export') await exportDocx('course').catch((error) => log(`导出失败：${error.message}`, 'error'));
            if (action === 'collapse') panel.classList.toggle('fzugk-collapsed');
        });
        updatePanel();
    }

    function updatePanel() {
        const panel = runtime.panel;
        if (!panel) return;
        const state = panel.querySelector('[data-role="state"]');
        const course = panel.querySelector('[data-role="course"]');
        const logBox = panel.querySelector('[data-role="log"]');
        const service = panel.querySelector('[data-role="service"]');
        if (state) state.textContent = runtime.state;
        if (course) course.textContent = runtime.currentCourse || '未识别课程';
        if (service) service.textContent = `本地 AI：${runtime.settings.assistantServiceEnabled && runtime.settings.assistantServiceToken ? '已启用' : '未配置'}　转录：${runtime.settings.audioTranscription ? '开' : '关'}　画面：${runtime.settings.visualRecognition ? '开' : '关'}`;
        if (logBox) logBox.textContent = runtime.logLines.slice(-6).map((line) => `[${line.at}] ${line.message}`).join('\n');
        const assessment = assessmentState();
        const status = panel.querySelector('[data-role="assessment-status"]');
        const selection = panel.querySelector('[data-role="assessment-course"]');
        const contexts = assessmentContexts();
        const signature = contexts.map((item) => item.courseKey).join('|');
        if (selection && selection.dataset.signature !== signature) {
            const selected = selection.value;
            selection.replaceChildren(...contexts.map((item) => {
                const option = root.document.createElement('option'); option.value = item.courseKey; option.textContent = item.courseTitle; return option;
            }));
            if (contexts.some((item) => item.courseKey === selected)) selection.value = selected;
            selection.dataset.signature = signature;
            selection.hidden = !contexts.length;
            if (contexts.length) gmSet('fzugk-assessment-contexts-v1', contexts.map(assessmentContextData).slice(0, 20));
        }
        if (status) {
            const summary = assessmentSummary(assessment.snapshot);
            status.textContent = `${assessment.context?.courseTitle || ''}\n${assessment.snapshot ? summary.complete ? '已完整扫描' : '扫描未完成' : '测评未扫描'} · 已通过 ${summary.PASSED} / 未通过 ${summary.FAILED} / 未做 ${summary.NOT_STARTED} / 未知 ${summary.UNKNOWN}\n${assessment.phase}${assessment.target ? ` · ${assessment.target.knowledgeTitle} / ${assessment.target.chapterTitle} · ${assessment.target.mappingStatus}` : ''}${assessment.error ? `\n${assessment.error}` : ''}`;
            status.style.whiteSpace = 'pre-wrap';
        }
    }

    function registerMenus() {
        if (typeof GM_registerMenuCommand !== 'function') return;
        GM_registerMenuCommand('启动刷课全自动模式', start);
        GM_registerMenuCommand('停止学习助手', stop);
        GM_registerMenuCommand('导出考试助手配置与答案表 JSON', () => {
            const { assistantServiceEnabled, assistantServiceUrl, assistantServiceToken, minAnswerConfidence } = runtime.settings;
            const data = { settings: { assistantServiceEnabled, assistantServiceUrl, assistantServiceToken, minAnswerConfidence }, answerBank: gmGet(ANSWER_BANK_KEY, []) };
            root.prompt('复制到考试助手的「配置 / 导入」。此配置含本地访问令牌，请仅在本机使用。', JSON.stringify(data, null, 2));
        });
        GM_registerMenuCommand('导出当前课程 Word', () => exportDocx('course'));
        GM_registerMenuCommand('导出当前课程错题 Word', () => exportDocx('wrong'));
        GM_registerMenuCommand('导出全部课程 Word', () => exportDocx('all'));
        GM_registerMenuCommand('导入本地答案表 JSON', () => {
            const text = root.prompt('粘贴答案表 JSON 数组。字段示例：[{"stem":"题干","answers":["A"],"explanation":"解析"}]');
            if (!text) return;
            try {
                const data = JSON.parse(text);
                if (!Array.isArray(data)) throw new Error('答案表必须是数组');
                gmSet(ANSWER_BANK_KEY, data);
                notify('答案表已导入', `共 ${data.length} 条记录。`);
            } catch (error) {
                root.alert(`答案表导入失败：${error.message}`);
            }
        });
        GM_registerMenuCommand('配置并测试本地 AI 服务', async () => {
            const endpoint = root.prompt('本地辅助服务地址（留空则停用）', runtime.settings.assistantServiceUrl || 'http://127.0.0.1:8766');
            if (endpoint == null) return;
            if (!endpoint.trim()) {
                saveSettings({ assistantServiceEnabled: false, assistantServiceToken: '' });
                return;
            }
            const token = root.prompt('本地访问令牌（在 service/config.json 中）', runtime.settings.assistantServiceToken || '');
            if (token == null) return;
            saveSettings({ assistantServiceEnabled: true, assistantServiceUrl: endpoint.trim(), assistantServiceToken: token.trim() });
            try {
                const health = await serviceRequest('/health', null, 'GET');
                notify('本地服务连接成功', `AI：${health.aiConfigured ? '已配置' : '未配置'}；资料：${health.materialCount || 0} 条；已验证答案：${health.verifiedCount || 0} 条。`);
            } catch (error) {
                notify('本地服务连接失败', error.message);
            }
        });
        GM_registerMenuCommand(`${runtime.settings.audioTranscription ? '关闭' : '启用'}课件音频转录`, () => {
            const enabled = !runtime.settings.audioTranscription;
            saveSettings({ audioTranscription: enabled });
            if (!enabled) stopAudioCapture();
            notify('音频转录设置', enabled ? '已启用；本地服务还需启用 transcription。' : '已关闭。');
        });
        GM_registerMenuCommand(`${runtime.settings.visualRecognition ? '关闭' : '启用'}课件画面识别`, () => {
            const enabled = !runtime.settings.visualRecognition;
            saveSettings({ visualRecognition: enabled });
            notify('课件画面识别设置', enabled ? '已启用；只在知识点题请求时截取当前课件画面。' : '已关闭。');
        });
        GM_registerMenuCommand('立即同步当前课程资料', () => syncCourseMaterials(true)
            .then(() => notify('课程资料同步完成', '已将当前页面可见讲义、知识点与字幕写入本地索引。'))
            .catch((error) => notify('课程资料同步失败', error.message)));
        GM_registerMenuCommand('清除当前课程归档', async () => {
            const course = extractCourseInfo().course;
            if (!root.confirm(`确定删除“${course}”的本地题目归档吗？此操作无法撤销。`)) return;
            const count = await clearCourseArchive(course);
            notify('归档已清除', `已删除 ${count} 道题。`);
        });
    }

    function registerSettingsSync() {
        if (typeof GM_addValueChangeListener !== 'function') return;
        GM_addValueChangeListener(SETTINGS_KEY, (_key, _oldValue, newValue, remote) => {
            if (!remote || !newValue || typeof newValue !== 'object') return;
            const wasEnabled = runtime.settings.enabled;
            runtime.settings = { ...DEFAULT_SETTINGS, ...newValue };
            if (runtime.mode === 'ASSESSMENT') {
                if (!runtime.settings.enabled) { assessmentCancel('REMOTE_STOP'); cancelPendingAssistantWork(); }
                else runtime.settings.enabled = true;
            }
            if (!runtime.settings.enabled && runtime.timer) {
                root.clearInterval(runtime.timer);
                runtime.timer = null;
                runtime.state = 'IDLE';
                log('已同步停止其他课件页面');
            } else if (runtime.settings.enabled && !wasEnabled && !runtime.timer && !detectLoginPage()) {
                log('已同步启动课件页面');
                start();
            }
            updatePanel();
        });
    }

    function boot() {
        loadSettings();
        createPanel();
        registerMenus();
        registerSettingsSync();
        registerAssessmentSync();
        resumeAssessmentNavigation().catch((error) => log(`跨文档详情读取失败：${error.message}`, 'warn'));
        root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && event.shiftKey) stop();
        });
        const assessmentRun = gmGet(ASSESSMENT_KEYS.run, null);
        if (detectLoginPage() && assessmentRun?.status === 'ACTIVE') {
            const state = assessmentState(); state.context = assessmentRun.context; state.runId = assessmentRun.runId;
            assessmentCancel('LOGIN_REQUIRED');
        }
        if (assessmentRunValid(assessmentRun, assessmentRun?.context) && assessmentVm(root.document, 'player')) {
            adoptAssessmentRun(assessmentRun, true).catch((error) => log(error.message, 'warn'));
        } else if (assessmentRunValid(assessmentRun, assessmentRun?.context) && assessmentVm(root.document, 'portal')) {
            const state = assessmentState(); state.context = assessmentRun.context; state.runId = assessmentRun.runId;
            runtime.mode = 'ASSESSMENT'; runtime.settings.enabled = true; state.phase = 'WAITING_PLAYER'; startAssessmentTimer();
        } else if (runtime.settings.enabled && !detectLoginPage()) start();
        else if (detectLoginPage()) log('登录页保持静默；登录后进入课程页面再启动。');
        else log('准备就绪。请点击“启动全自动”。');
    }

    const exported = {
        VERSION,
        normalizeText,
        escapeXml,
        safeFileName,
        fnv1a,
        questionFingerprint,
        createStoredZip,
        buildDocxBytes,
        buildDocumentXml,
        detectExamPage,
        parseQuestion,
        assessmentText, assessmentStatus, assessmentId, assessmentSummary, assessmentRecord,
        assessmentQueue, resolveAssessmentTarget, assessmentMessageValid,
        assessmentApi: { assessmentState, assessmentContexts, assessmentVm, openAssessmentOverview, scanAssessmentOverview, buildKnowledgeNodeIndex, scanSelectedAssessment, startAssessmentRecovery, adoptAssessmentRun, assessmentTick, assessmentCancel, assessmentMayAnswer, acquireAssessmentLease, ownsAssessmentLease }
    };

    if (typeof module !== 'undefined' && module.exports) module.exports = exported;
    if (root.document && root.location) {
        if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', boot, { once: true });
        else boot();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
