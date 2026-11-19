# EchoInk Agent — privacy and data

The complete disclosures for the EchoInk Agent plugin. A short summary is in the [README](README.md#privacy-at-a-glance). 中文版见 [PRIVACY_CN.md](PRIVACY_CN.md).

## Where data is stored

- **Local content:** Conversations, notes, knowledge, memory, diary content, and financial records are stored locally. The plugin does not upload your entire vault by default.

- **Model credentials:** Provider API keys and OpenAI Codex Beta sign-in credentials are saved in plugin settings for the current vault. Use trusted devices and vaults.

- **Desktop account storage:** On desktop, account sessions and device authorization are encrypted under **`~/.echoink/membership/`**, outside the vault. Operating-system secure storage protects the shared device authorization; Obsidian's secret storage protects each vault's account session separately. If secure storage is unavailable, persistent device authorization cannot complete, and existing credentials are preserved.

- **Mobile account storage:** On mobile, account sessions and authorization use the current vault's Obsidian secret storage, not ordinary plugin settings. Activation applies to each vault's client instance, so different vaults on the same device may occupy separate slots. Unlink unused instances in device management. If secure storage is unavailable, state is kept only for the current session.

## Features that connect to echoink.cn

- **Account and authorization:** EchoInk's account service at **https://echoink.cn** handles registration, sign-in, email verification, redemption, subscriptions, and device authorization. It receives the account information and authorization data required for those requests, including a generated device identity. An EchoInk account and an active entitlement are required for PRO plugins; ordinary chat and Knowledge do not require an EchoInk account.

- **Official PRO Skills:** Official PRO Skills download on demand from **https://echoink.cn**. Seven methodology Skills are delivered remotely; knowledge review retains its complete local basic version and uses a remote enhancement when PRO is valid. The catalog is public, including names, summaries and available comparison links. Content requires sign-in, unified PRO access and an activated device. Finance, English Diary, basic Obsidian operations, Quick Journal and to-do Skills remain bundled.

- **Skill requests and cache:** Skill downloads use the account service to send the login token, Skill ID, device ID, current signed lease, plugin version, platform and optional cached version. They send no notes or conversations. Versioned Markdown is cached in **`skill-cache/`** under the current Vault’s actual plugin data directory, following its configured directory and existing data-root selection, isolated by account, service URL and device. These are ordinary local files and can be copied. Every use requires a valid device lease and less than 7 days since the full content’s `issuedAt`. Cache reads and “not modified” responses never extend that period. Only temporary network failures permit fallback to a still-valid cache. Sign-out, expiry, device revocation or a known entitlement revocation stops access; a fully offline device cannot immediately learn of remote revocation. Each run fixes one content version; updates apply to a later run. Skill text grants no tools or permissions.

- **Expert catalogs and content:** Expert catalogs and content are fetched from echoink.cn. Content downloads require active PRO and device authorization. Requests include the expert ID, device ID, signed lease, plugin version, platform, and optional cached version; these download requests send no notes or conversations. Downloaded content is cached in `expert-cache/` under the current plugin directory.

- **Weather:** Weather is optional. Searching for a city sends the search text to echoink.cn. Once you select a city, EchoInk stores its ID and name in this vault's plugin settings and sends only the city ID to echoink.cn when the workbench opens and every 30 minutes while visible. Weather requests contain no login token or account data; EchoInk does not read device location or store weather history. Weather is a near-term estimate from MET Norway, not a local observation. Weather and city sources, licenses and adaptations remain visible in General settings.

- **Workbench check-in:** Workbench check-in is an online account action. Opening the Workbench while signed in queries your account's status for the local date. Only pulling the weather doll down or pressing Arrow Down submits a manual check-in, sending your account identity through the existing login token, local date, and time zone to **https://echoink.cn**. Check-ins are saved with your server account and cached only in memory by the plugin. There is no automatic check-in or upload of Agent usage days, notes, or conversation content.

- **Run records and reports:** From a session’s **…** menu, you can export its run records or voluntarily upload a problem report to **echoink.cn**. Reports include conversations, note excerpts read by the agent, tool and runtime logs, environment details, and errors, together with your description and optional contact information. Signed-in submissions are linked to your account. Recognized secrets are hidden automatically; review the preview before uploading. Reports are used for troubleshooting and may be analyzed with AI assistance. They are retained for **180 days**; to request earlier deletion, contact the author through [support](https://echoink.cn/support) with the report ID. Exporting alone saves a file in your vault without uploading it.

- **Static PRO information:** The plugin’s own interface includes static PRO benefit information and official Skill comparison links opened when you click them. It does not load dynamic online advertising.

## Data sent to third-party services

- **Model requests:** Your selected model service receives the prompts, notes, attachments, memory, and tool results needed for the current AI request. Model services may require their own account and charge separately; image input requires a vision-capable model.

- **Web search:** Web search is off by default, with a choice of Tavily or DeepSeek. When enabled, queries go to the selected service at `api.tavily.com` or `api.deepseek.com`, and returned snippets and links go to your model. Each service uses its own account and API key and bills usage separately; connection tests also perform a real search. Tavily connection tests use basic search and consume one credit; see [Tavily's pricing policy](https://docs.tavily.com/documentation/api-credits). DeepSeek query limits and billing are described in its [search documentation](https://api-docs.deepseek.com/guides/search/).

- **PDF parsing:** Local PDF text extraction runs on your device. MinerU enhanced parsing sends the PDF to MinerU, requires separate credentials and credits, and follows that service's retention policy. Extracted content needed for reading notes or translations is sent to your selected model.

- **Link capture:** Link capture uses the plugin's built-in fetcher to access pages you explicitly submit.

- **Custom services and MCP:** Custom Providers and MCP connections contact the services or local commands you configure. Local MCP processes run with your operating-system user permissions and inherit the application environment; approving tools in the plugin does not restrict those processes to the workspace.

## Local permissions and external agents

- **Desktop workspace:** Desktop conversations can use a local workspace outside the vault. File access follows the selected permission mode; Full access removes the workspace boundary. Outside-vault attachments are read when you explicitly select, drag, or paste them.

- **EchoInk MCP server:** EchoInk’s desktop MCP server is PRO, off by default, read-only, and listens only on this computer’s loopback address while Obsidian is running. You separately authorize Knowledge and personal memory/profile access. External Agents can receive note excerpts, source paths and revisions, concept links, your profile and memories, and may send them to their model providers or retain them. EchoInk cannot control those records or recall content already sent. Turn off sharing or regenerate the token to stop future access.

- **Knowledge retrieval scope:** Knowledge retrieval excludes the private-memory and internal plugin data folders. This is not a global access restriction for every file tool or third-party service.

## What the plugin does not do

- **Client telemetry:** The plugin has no client usage telemetry. Website and account-service data handling is described in the [privacy policy](https://echoink.cn/support#privacy).
