# FZUGK Study Assistant

福州大学自考学习辅助用户脚本、考试辅助用户脚本及本地服务源码。

## 文件

- `outputs/fzugk-study-assistant.user.js`：学习辅助脚本，版本 0.5.1。
- `outputs/exam-assistant.user.js`：考试辅助脚本，版本 1.3.4。
- `service/server.mjs`：本地服务，提供配置、AI 接口及脚本安装入口。
- `service/config.example.json`：配置模板，不含可用凭据。
- `service/*.ps1`、`service/exam-installer.mjs`：本地启动、安装、卸载与配置工具。

## 安装与运行

1. 安装支持内置 `fetch` 的现代 Node.js，以及 Tampermonkey 等用户脚本管理器。本地服务使用 Node.js 内置模块，无需安装 npm 依赖或编译。
2. 将 `service/config.example.json` 复制为 `service/config.json`，设置自己的本地访问令牌。按需填写自己的 DeepSeek API Key，或设置 `DEEPSEEK_API_KEY` 环境变量。不要提交实际配置文件。
3. 在 Windows PowerShell 中运行 `service/start-service.ps1` 启动服务。也可在仓库根目录运行 `node service/server.mjs` 前台启动。
4. 打开 `http://127.0.0.1:8766/install`，按页面指引安装学习脚本；考试脚本入口为 `http://127.0.0.1:8766/install/exam`。也可通过用户脚本管理器直接安装对应的 `.user.js` 文件。
5. 在用户脚本设置中填写与本地服务一致的访问令牌，按实际需要启用功能。服务仅应监听本机回环地址。

可选工具：`service/set-deepseek-key.ps1` 用于配置 API Key；`service/install-local-service.ps1` 和 `service/uninstall-local-service.ps1` 管理当前用户的登录启动项；`service/start-exam-installer.ps1` 启动独立考试脚本安装入口。

仓库仅提供源码与配置模板，不包含个人学习记录、实际答题数据、浏览器会话、运行数据或密钥。请自行核对功能与所用平台规则；身份验证应由本人完成。

## 许可与归属

保留源码已有元数据、注释与归属说明。本仓库暂无单独的许可文件；公开可读不等于授予任意再分发或其他使用授权。
