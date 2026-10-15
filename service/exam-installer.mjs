import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Read-only installer; deliberately independent of service config and AI data.
const outputs = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../outputs');
const port = Number(process.env.FZUGK_INSTALL_PORT || 8769);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('安装端口无效');
const files = new Map([
    ['/install/exam-assistant.user.js', 'exam-assistant.user.js'],
    ['/install/fzugk-study-assistant.user.js', 'fzugk-study-assistant.user.js']
]);
const server = http.createServer((req, res) => {
    try {
        const url = new URL(req.url, `http://127.0.0.1:${port}`);
        if (req.method !== 'GET') { res.writeHead(405); return res.end('GET only'); }
        const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };
        if (url.pathname === '/health') {
            res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8' });
            return res.end(JSON.stringify({ ok: true, service: 'fzugk-exam-installer' }));
        }
        if (files.has(url.pathname)) {
            res.writeHead(200, { ...headers, 'Content-Type': 'application/javascript; charset=utf-8' });
            return res.end(fs.readFileSync(path.join(outputs, files.get(url.pathname))));
        }
        if (['/', '/install', '/install/exam'].includes(url.pathname)) {
            const version = fs.readFileSync(path.join(outputs, 'exam-assistant.user.js'), 'utf8').match(/@version\s+([\d.]+)/)?.[1] || '未知';
            res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
            return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>安装考试刷分助手</title><style>body{font:16px/1.8 system-ui,'Microsoft YaHei';background:#f3f7fb;color:#17324d;margin:0;padding:24px}main{max-width:640px;margin:8vh auto;padding:28px;background:white;border:1px solid #d9e5ef;border-radius:16px}a{color:#175f9e}.install{display:block;padding:15px;background:#1f5c3d;color:white;text-align:center;border-radius:9px;text-decoration:none;margin:24px 0}h1{font-size:26px}small{display:block}</style><main><h1>考试刷分助手 ${version}</h1><p>点击下方按钮，在 Tampermonkey 或 ScriptCat 页面确认安装，随后刷新考试页面。</p><a class="install" href="/install/exam-assistant.user.js">安装 ${version}</a><p>自动推进默认关闭。开始考试与身份验证由本人完成，先检查卷子及题目是否识别正确。</p><p><a href="/install/fzugk-study-assistant.user.js">更新学习助手，启用配置导出菜单</a></p><small>此入口只提供安装文件。AI 服务仍使用已配置的本机地址；自动更新地址默认使用 8766 端口，新考试脚本路由需在该服务更新后生效。</small></main></html>`);
        }
        res.writeHead(404, headers);
        res.end('Not found');
    } catch (_) { res.writeHead(500); res.end('Installer source unavailable'); }
});
server.listen(port, '127.0.0.1', () => console.log(`考试助手安装入口：http://127.0.0.1:${port}/install/exam`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
