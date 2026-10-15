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

## 用途与许可

本仓库以源码可见方式分享，采用自定义的[个人非商业使用许可](LICENSE)；由于限制商业用途，不属于标准开源许可证。

允许个人学习研究、私下运行、修改及适配，也允许使用 Codex 等开发工具辅助自己的个人非商业项目。你可以在 GitHub 上 fork 本仓库并保存个人修改；请保留原有版权、归属说明及许可条款。

禁止商业使用，包括售卖、收费服务、客户交付、用于企业经营或其他商业项目。除 GitHub 平台条款允许的查看、fork，以及 LICENSE 明确允许的个人使用外，不授予其他对外再分发、再许可或商业服务权利；其他用途需另行取得相关权利人的书面授权。

参考源码时应自行适配目标环境，不应假定原站点地址、页面结构或配置适用于其他环境。建议让开发工具分析实现方式、模块边界、数据流和工程组织，再针对自己的项目实现与验证。

本许可仅适用于许可人有权授权的内容。已有源码元数据、注释和归属说明予以保留；第三方内容及依赖仍遵循各自授权。
