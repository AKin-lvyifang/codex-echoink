<a href="https://github.com/AKin-lvyifang/obsidian-codex">
  <img width="1024" alt="Codex for Obsidian v0.3.0 Writing Context Harness." src="docs/images/obsidian-codex-writing-harness-v0.3.0.png">
</a>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="#whats-new">What's New</a> ·
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#development">Development</a> ·
  <a href="#license">License</a> ·
  <a href="README_CN.md">中文</a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/obsidian-codex/releases/latest">
    <img src="https://img.shields.io/badge/platform-Obsidian_Desktop-7C3AED?style=flat-square&logo=obsidian&logoColor=white" alt="Platform: Obsidian Desktop">
    <img src="https://img.shields.io/badge/version-v0.3.0-0EA5E9?style=flat-square" alt="Version v0.3.0">
    <img src="https://img.shields.io/badge/license-MIT-10B981?style=flat-square" alt="MIT License">
    <img src="https://img.shields.io/badge/language-English_%2B_%E4%B8%AD%E6%96%87-F59E0B?style=flat-square" alt="English and Chinese README">
  </a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/obsidian-codex/releases/download/v0.3.0/obsidian-codex-0.3.0.zip"><strong>Download v0.3.0</strong></a>
  ·
  <a href="https://github.com/AKin-lvyifang/obsidian-codex/releases/latest">Latest Release</a>
</p>

---

## Features

### Vault-native Codex Workspace

- Opens Codex in the Obsidian sidebar.
- Uses the current vault as the working directory.
- Lets Codex read notes, inspect folders, edit documents, and run local commands.
- Keeps the workflow inside Obsidian instead of bouncing between apps.

### Agent-style Process Timeline

- Renders reasoning, commands, file edits, MCP calls, and context usage as readable process cards.
- Shows file chips for touched files, with vault files opening back in Obsidian.
- Keeps large outputs and raw details folded away so the conversation stays readable.
- Supports Agent / Plan mode, model selection, reasoning effort, speed, and file permission modes.

### Local-first Integration

- Reuses your local Codex CLI login state.
- Does not require storing an OpenAI API key by default.
- Optionally supports OpenAI Responses API-compatible custom providers, including multiple models per provider.
- Supports local proxy settings for the Codex child process.
- Keeps plugin, MCP, and skill switches scoped to the current vault instead of rewriting global Codex config.

### Writing Context Harness

- Adds in-editor rewrite, expand, and continue actions for selected text.
- Lets you choose `Fast`, `Quality`, or `Strict` writing quality modes.
- Uses visible article understanding for long-form context instead of silently running background summaries.
- Shows a writing context panel with the current note, model, understanding status, and structured article understanding.
- Reuses article understanding after small edits, so continuous rewrite / expand / continue runs do not repeatedly re-read the whole note.
- Shows an inline candidate that can be accepted with `Enter` or canceled with `Esc`.

This feature is still experimental and disabled by default, but v0.3.0 makes it a much more deliberate writing workflow.

## What's New

### v0.3.0

**New feature:** Writing Context Harness for editor rewrite, expand, and continue.

**What changed:**

- Added `Fast`, `Quality`, and `Strict` writing quality modes.
- Added visible article understanding in the sidebar writing context panel.
- Added structured article understanding for theme, audience, purpose, structure, facts, style, fabrication boundaries, and local writing guidance.
- Added soft reuse for article understanding, so small continuous edits reuse existing understanding instead of re-running it every time.
- Added strict-mode review, which checks the generated candidate before showing it.
- Kept the inline candidate flow: `Enter` accepts, `Esc` cancels.
- Kept article understanding out of the normal chat history.

**How to use:**

1. Enable writing actions in the plugin settings.
2. Choose the default writing quality mode: `Fast`, `Quality`, or `Strict`.
3. Select text in the editor and run `Rewrite`, `Expand`, or `Continue`.
4. Click the `Writing` chip in the sidebar to inspect or refresh article understanding.
5. Press `Enter` to accept the gray candidate, or `Esc` to cancel.

### v0.2.0

**Bug fix:** fixed `spawn codex ENOENT` after Codex account re-login by detecting the Codex Desktop CLI path and adding a manual login refresh button.

**Experimental feature:** rewrite, expand, and continue selected editor text in place. This is still experimental, disabled by default, and not recommended for stable daily use.

**How to test:**

1. Enable writing actions in the plugin settings.
2. Select text in the editor and right-click `Rewrite`, `Expand`, or `Continue`.
3. Press `Enter` to accept the gray candidate, or `Esc` to cancel.
4. Test on non-critical notes first.

### v0.1.2

**New feature:** public releases now keep the GitHub repository focused on install and usage files only.

**How to use:**

1. Download the latest release package.
2. Install the `obsidian-codex` plugin folder.
3. Use the plugin without browsing internal project documents.

### v0.1.1

**New feature:** paste WeChat or system screenshots directly into the Codex input box.

**How to use:**

1. Take a screenshot.
2. Click the Codex input box.
3. Press `Command+V`, then send.

## Install

1. Install and log in to Codex CLI.
2. Download [`obsidian-codex-0.3.0.zip`](https://github.com/AKin-lvyifang/obsidian-codex/releases/download/v0.3.0/obsidian-codex-0.3.0.zip) from [the latest release](https://github.com/AKin-lvyifang/obsidian-codex/releases/latest).
3. Unzip it and get the `obsidian-codex` folder.
4. Move it into your vault plugin directory:

```text
<vault>/.obsidian/plugins/obsidian-codex/
```

5. Restart Obsidian and enable `Codex for Obsidian` in Community plugins.

The plugin folder should contain:

```text
obsidian-codex/
  main.js
  manifest.json
  styles.css
```

## Quick Start

1. Open the Codex sidebar from the ribbon icon or command palette.
2. Ask Codex to inspect, summarize, rewrite, or manage files in the current vault.
3. Attach notes, files, images, skills, or MCP tools when needed.
4. Review the process cards for commands, edits, context usage, and evidence.

## Screenshots

![Codex for Obsidian sidebar demo](docs/images/obsidian-codex-vault-answer.png)

## Development

```bash
npm install
npm run test
npm run typecheck
npm run build
```

Generate a shareable install package:

```bash
npm run package
```

Deploy to your own Obsidian vault:

```bash
OBSIDIAN_VAULT=/path/to/your/vault npm run deploy
```

## Requirements

- Codex CLI must be installed and available locally. Custom API providers still run through `codex app-server`; the plugin does not call provider APIs directly.
- Custom API providers must be compatible with the OpenAI Responses API, such as `/v1/responses`. Providers that only support `/v1/chat/completions` may not work.
- Custom API keys are stored in Obsidian plugin data, so use them only on a trusted local machine.
- Leave the Codex CLI path empty to auto-detect it from `PATH` and common install folders, or set the path manually in plugin settings.

## License

Codex for Obsidian is open source under the [MIT License](LICENSE).

You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of this software as permitted by the MIT License, as long as the copyright and license notice are included. The software is provided "as is", without warranty of any kind.
