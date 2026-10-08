<p align="center">
  <a href="https://echoink.cn">
    <img width="1024" alt="EchoInk 2.6.0 — the official website is live" src="assets/releases/echoink-agent-2.6.0-release.png">
  </a>
</p>

<h1 align="center">EchoInk Agent</h1>

<p align="center">Your notes, with an AI companion. Built for Obsidian.</p>

<p align="center">
  <a href="https://echoink.cn">Official website</a> ·
  <a href="https://echoink.cn/install">Download &amp; installation</a> ·
  <a href="#whats-new-in-260">What's new</a> ·
  <a href="#privacy-and-data">Privacy</a> ·
  <a href="README_CN.md">中文</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Desktop%20%2B%20Mobile%20Beta-7C3AED?style=flat-square" alt="Desktop and Mobile Beta">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/tag/2.6.0"><img src="https://img.shields.io/badge/version-2.6.0-0EA5E9?style=flat-square" alt="Version 2.6.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Source%20Available-475569?style=flat-square" alt="Source Available — see LICENSE"></a>
</p>

<p align="center"><a href="https://echoink.cn"><strong>Visit echoink.cn</strong></a></p>

EchoInk is a personal knowledge agent that lives in Obsidian. Chat with your notes, organize knowledge, keep visible and editable long-term memory, and record everyday life. Your notes stay in your vault; connect your own supported model service for AI features. Normal installation does not require Codex CLI.

## What's new in 2.6.0

**EchoInk now has an official website: [echoink.cn](https://echoink.cn).** Product tours, downloads, documentation, and account management now have a permanent home.

- **Register, sign in, and activate PRO.** Use an email verification code or your existing password. During the current beta campaign, register and verify your email to receive an activation code, subject to availability. Sign in inside the desktop plugin and select **Use redemption code** to activate it.
- **Finance, from records to plans.** Import WeChat Pay and Alipay statements, organize merchants, accounts, and categories, set monthly budgets and goals, and link records to bill plans. Use your own model for assisted organization and financial summaries.
- **English Diary.** Write a Markdown diary, generate a natural English version, and revisit useful expressions in a searchable library. Choose which parts of the original may be sent to the model.
- **An easier workspace to navigate.** Choose a color theme, jump between home sections, use the English Diary shortcut, and filter activity heatmaps by year or month.
- **Clear subscription states.** PRO activation shows progress and success. After expiry, previously enabled PRO plugins remain available for reading; their switches and new, import, edit, and generation actions are disabled. Ordinary chat, Knowledge, and original Markdown remain available.
- **Model and tablet improvements.** Updated model discovery and DeepSeek compatibility, plus wider layouts and split views for iPad. Mobile remains Beta.

Finance and English Diary are PRO plugins. PRO does not include model credits. Paid purchasing is not open during the current beta; campaign availability and subscription details are shown on the [website](https://echoink.cn/plans).

## Download and documentation

Visit [echoink.cn](https://echoink.cn) for [installation](https://echoink.cn/install), [features](https://echoink.cn/features), and [help](https://echoink.cn/support). The repository's [Releases](https://github.com/AKin-lvyifang/codex-echoink/releases) remain the official source of plugin files.

Requires **Obsidian 1.11.4 or later**. Desktop includes the account, Finance, and English Diary features above. Mobile Beta supports chat, Markdown note reading and creation, local memory, and tablet layouts; it does not yet include the desktop membership, Finance, English Diary, attachments, CLI, or complete Skills/MCP experience. Real iOS and Android device validation is still pending.

The plugin file exceeds Obsidian Sync Standard's 5 MB per-file limit. Install or update the plugin independently on each device through the official download or Community Plugins; do not rely on Sync Standard to transfer this file.

## Privacy and data

- Conversations, notes, knowledge, memory, diary content, and financial records are stored locally. The plugin does not upload your entire vault by default.
- EchoInk's account service at **https://echoink.cn** handles registration, sign-in, email verification, redemption, subscriptions, and device authorization. It receives the account information and authorization data required for those requests, including a generated device identity. An EchoInk account and an active entitlement are required for PRO plugins; ordinary chat and Knowledge do not require an EchoInk account.
- On desktop, account sessions and device authorization are encrypted under **`~/.echoink/membership/`**, outside the vault, to avoid syncing device credentials with notes. The encryption key uses Obsidian's secret storage. If persistent secure storage is unavailable, authorization is kept in memory for the current session.
- Provider API keys and OpenAI Codex Beta sign-in credentials are saved in plugin settings for the current vault. Use trusted devices and vaults.
- Your selected model service receives the prompts, notes, attachments, memory, and tool results needed for the current AI request. Model services may require their own account and charge separately; image input requires a vision-capable model.
- Desktop conversations can use a local workspace outside the vault. File access follows the selected permission mode; Full access removes the workspace boundary. Outside-vault attachments are read when you explicitly select, drag, or paste them.
- Tavily web search is off by default. When enabled, queries go to `api.tavily.com`, and returned snippets and links go to your model. Tavily needs its own account and API key; connection tests also perform a basic search and consume one credit. See [Tavily's pricing policy](https://docs.tavily.com/documentation/api-credits).
- Custom Providers and MCP connections contact the services or local commands you configure. The plugin has no client usage telemetry. Website and account-service data handling is described in the [privacy policy](https://echoink.cn/support#privacy).

## License

From 2.6.0, newly licensed EchoInk material uses the **EchoInk Source-Available Reference License 1.0**. Source is visible for personal study and reference; it is **not an OSI open-source license**. Unmodified official releases may be used personally and non-commercially. Modification, redistribution, source-derived copies, and commercial use require separate written permission, subject to the exceptions in [LICENSE](LICENSE).

This does not revoke rights already granted under earlier MIT releases, change third-party licenses, or restrict rights that cannot lawfully be excluded. See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
