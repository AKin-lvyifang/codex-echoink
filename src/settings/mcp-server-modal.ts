import { createOriginInput, createOriginButton, createOriginCheck, createOriginSelect, disposeOriginControls, type OriginCheckElement } from "./origin-controls";
import { App, Modal } from "obsidian";
import type { EchoInkMcpServerDraft } from "../plugin/mcp-settings-service";
import type {
  EchoInkMcpConnectionRecord,
  EchoInkResource
} from "../resources/types";
import { applyAmicroButton } from "./amicro-buttons";

export interface McpServerModalOptions {
  readonly app: App;
  readonly language: "zh-CN" | "en";
  readonly resource?: EchoInkResource;
  readonly connection?: EchoInkMcpConnectionRecord;
  readonly save: (draft: EchoInkMcpServerDraft) => Promise<void>;
}

type McpTransport = EchoInkMcpServerDraft["transport"];

export class McpServerModal extends Modal {
  private readonly editing: boolean;
  private readonly existingCredential: boolean;
  private transport: McpTransport;
  private name: string;
  private description: string;
  private endpoint: string;
  private args: string;
  private cwd: string;
  private publicValues: string;
  private credentialTarget: string;
  private credentialPrefix: string;
  private credentialSecret = "";
  private clearCredential = false;
  private saving = false;
  private closed = true;
  private errorMessage = "";
  private fieldErrors: Record<string, string> = {};

  constructor(private readonly options: McpServerModalOptions) {
    super(options.app);
    const connection = options.connection;
    this.editing = Boolean(options.resource);
    this.existingCredential = Boolean(connection?.credential);
    this.transport = connection?.transport ?? "http";
    this.name = options.resource?.name ?? "";
    this.description = options.resource?.description ?? "";
    this.endpoint = connection?.transport === "http"
      ? connection.url
      : connection?.command ?? "";
    this.args = connection?.transport === "stdio"
      ? (connection.args ?? []).join("\n")
      : "";
    this.cwd = connection?.transport === "stdio" ? connection.cwd ?? "" : "";
    this.publicValues = connection?.transport === "http"
      ? stringifyKeyValueLines(connection.headers)
      : connection?.transport === "stdio"
        ? stringifyKeyValueLines(connection.env)
        : "";
    this.credentialTarget = connection?.credential?.targetName ?? "";
    this.credentialPrefix = connection?.credential?.prefix ?? "";
  }

  onOpen(): void {
    this.closed = false;
    this.modalEl.addClass("codex-mcp-server-modal");
    this.render();
  }

  onClose(): void {
    this.closed = true;
    this.credentialSecret = "";
    this.titleEl.empty();
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    this.modalEl.removeClass("codex-mcp-server-modal");
  }

  private get zh(): boolean {
    return this.options.language !== "en";
  }

  private label(chinese: string, english: string): string {
    return this.zh ? chinese : english;
  }

  private render(): void {
    this.titleEl.empty();
    this.titleEl.setText(this.editing
      ? this.label("编辑 MCP Server", "Edit MCP server")
      : this.label("新增 MCP Server", "Add MCP server"));
    disposeOriginControls(this.contentEl);
    this.contentEl.empty();
    const form = this.contentEl.createDiv({
      cls: "codex-mcp-server-form",
      attr: { "aria-busy": String(this.saving) }
    });

    const basic = form.createDiv({ cls: "codex-mcp-form-card is-basic" });
    basic.createEl("h3", { text: this.label("基本信息", "Basic information") });
    this.renderTextField(basic, {
      key: "name",
      label: this.label("名称", "Name"),
      description: this.label("显示在 Resources 和 Tool 卡中的 Server 名称。", "The server name shown in Resources and tool cards."),
      value: this.name,
      placeholder: this.label("例如：团队知识库", "For example: Team knowledge"),
      onInput: (value) => { this.name = value; }
    });
    this.renderTextField(basic, {
      key: "description",
      label: this.label("说明", "Description"),
      description: this.label("简要说明这个 Server 提供什么能力。", "Briefly describe what this server provides."),
      value: this.description,
      placeholder: this.label("可选", "Optional"),
      onInput: (value) => { this.description = value; }
    });

    const transportField = this.createField(
      basic,
      this.label("连接方式", "Transport"),
      this.label("HTTP 连接远程或本地端点；stdio 启动本机命令。", "HTTP connects to an endpoint; stdio starts a local command."),
      "transport"
    );
    transportField.addClass("is-wide");
    const select = createOriginSelect(transportField, {
      cls: "codex-mcp-server-select",
      attr: { id: this.controlId("transport"), "data-mcp-modal-focus-key": "transport" }
    }, [{ value: "http", label: "HTTP" }, { value: "stdio", label: "stdio" }], this.transport, this.app).element;
    select.onchange = () => {
      this.transport = select.value === "stdio" ? "stdio" : "http";
      this.endpoint = "";
      this.args = "";
      this.cwd = "";
      this.publicValues = "";
      this.credentialTarget = "";
      this.credentialPrefix = "";
      this.credentialSecret = "";
      this.clearCredential = this.existingCredential;
      this.errorMessage = "";
      this.fieldErrors = {};
      this.render();
      this.focus("endpoint");
    };

    const connection = form.createDiv({ cls: "codex-mcp-form-card is-connection" });
    connection.createEl("h3", { text: this.transport === "http" ? this.label("HTTP 连接", "HTTP connection") : this.label("本地进程", "Local process") });
    if (this.transport === "http") {
      this.renderTextField(connection, {
        key: "endpoint",
        label: this.label("Server URL", "Server URL"),
        description: this.label("使用完整的 http(s) MCP 地址，不要在 URL 中放入用户名、密码或 Token。", "Use a complete http(s) MCP URL. Do not put credentials in the URL."),
        value: this.endpoint,
        placeholder: "https://mcp.example.com/mcp",
        onInput: (value) => { this.endpoint = value; }
      });
      this.renderTextareaField(connection, {
        key: "public-values",
        label: this.label("普通 Headers", "Public headers"),
        description: this.label("每行 NAME=value。这里只放非敏感值；Token 请使用下方 Credential。", "One NAME=value per line. Put secrets in Credential below."),
        value: this.publicValues,
        placeholder: "X-Client-Version=1",
        rows: 3,
        onInput: (value) => { this.publicValues = value; }
      });
    } else {
      this.renderTextField(connection, {
        key: "endpoint",
        label: this.label("启动命令", "Command"),
        description: this.label("输入可执行命令；参数单独逐行填写。", "Enter the executable command; put one argument on each line below."),
        value: this.endpoint,
        placeholder: "npx",
        onInput: (value) => { this.endpoint = value; }
      });
      this.renderTextareaField(connection, {
        key: "args",
        label: this.label("参数", "Arguments"),
        description: this.label("每行一个参数，不经过 Shell 拼接。", "One argument per line; values are not joined through a shell."),
        value: this.args,
        placeholder: "-y\n@scope/mcp-server",
        rows: 3,
        onInput: (value) => { this.args = value; }
      });
      this.renderTextField(connection, {
        key: "cwd",
        label: this.label("工作目录", "Working directory"),
        description: this.label("可选。Server 进程的工作目录。", "Optional working directory for the server process."),
        value: this.cwd,
        placeholder: this.label("可选", "Optional"),
        onInput: (value) => { this.cwd = value; }
      });
      this.renderTextareaField(connection, {
        key: "public-values",
        label: this.label("普通环境变量", "Public environment variables"),
        description: this.label("每行 NAME=value。这里只放非敏感值；密钥请使用下方 Credential。", "One NAME=value per line. Put secrets in Credential below."),
        value: this.publicValues,
        placeholder: "LOG_LEVEL=info",
        rows: 3,
        onInput: (value) => { this.publicValues = value; }
      });
    }

    const credential = form.createDiv({ cls: "codex-mcp-credential-section codex-mcp-form-card" });
    credential.createDiv({
      cls: "codex-mcp-credential-title",
      text: this.label("Credential", "Credential")
    });
    credential.createDiv({
      cls: "codex-mcp-credential-description",
      text: this.label(
        "Secret 安全保存在 Obsidian SecretStorage，保存后不会回显，也不会进入设置、日志或 Tool Result。",
        "The secret stays in Obsidian SecretStorage and is never echoed into settings, logs, or tool results."
      )
    });
    this.renderTextField(credential, {
      key: "credential-target",
      label: this.transport === "http"
        ? this.label("Header 名称", "Header name")
        : this.label("环境变量名称", "Environment variable"),
      description: this.transport === "http"
        ? this.label("例如 Authorization 或 X-API-Key。", "For example, Authorization or X-API-Key.")
        : this.label("例如 API_TOKEN。", "For example, API_TOKEN."),
      value: this.credentialTarget,
      placeholder: this.transport === "http" ? "Authorization" : "API_TOKEN",
      onInput: (value) => { this.credentialTarget = value; }
    });
    this.renderTextField(credential, {
      key: "credential-prefix",
      label: this.label("前缀", "Prefix"),
      description: this.label("可选。例如 Bearer 后需要保留一个空格。", "Optional. For example, keep the space after Bearer."),
      value: this.credentialPrefix,
      placeholder: this.transport === "http" ? "Bearer " : "",
      onInput: (value) => { this.credentialPrefix = value; }
    });
    const secretField = this.createField(
      credential,
      this.label("Secret", "Secret"),
      this.existingCredential
        ? this.label("已保存。留空会继续使用原 Secret。", "Saved. Leave blank to keep the existing secret.")
        : this.label("只在本次保存时写入 SecretStorage。", "Written to SecretStorage only when you save."),
      "credential-secret"
    );
    secretField.addClass("is-wide");
    const secretInput = createOriginInput(secretField, {
      cls: "codex-mcp-server-input",
      attr: {
        id: this.controlId("credential-secret"),
        type: "password",
        autocomplete: "new-password",
        placeholder: this.existingCredential
          ? this.label("已安全保存", "Saved securely")
          : this.label("可选", "Optional"),
        "data-mcp-modal-focus-key": "credential-secret"
      }
    });
    this.decorateFieldControl(secretField, secretInput, "credential-secret");
    secretInput.value = this.credentialSecret;
    let clearInput: OriginCheckElement | null = null;
    secretInput.oninput = () => {
      this.credentialSecret = secretInput.value;
      if (this.credentialSecret && this.clearCredential) {
        this.clearCredential = false;
        if (clearInput) clearInput.checked = false;
      }
    };

    if (this.existingCredential) {
      const clearRow = credential.createEl("label", { cls: "codex-mcp-credential-clear" });
      const clear = createOriginCheck(clearRow, { attr: { type: "checkbox" } });
      clearInput = clear;
      clear.checked = this.clearCredential;
      clear.onchange = () => {
        this.clearCredential = clear.checked;
        if (this.clearCredential) {
          this.credentialSecret = "";
          secretInput.value = "";
        }
      };
      clearRow.createSpan({ text: this.label("删除已保存的 Credential", "Remove saved credential") });
    }

    const status = this.contentEl.createDiv({
      cls: `codex-mcp-server-modal-status${this.errorMessage ? " is-error" : ""}`,
      attr: { role: "status", "aria-live": "polite" },
      text: this.errorMessage
    });
    const footer = this.contentEl.createDiv({ cls: "codex-mcp-server-modal-footer" });
    const cancel = createOriginButton(footer, {
      text: this.label("取消", "Cancel"),
      attr: { type: "button", "data-mcp-modal-focus-key": "cancel" }
    });
    applyAmicroButton(cancel, { variant: "secondary" });
    cancel.disabled = this.saving;
    cancel.onclick = () => this.close();
    const save = createOriginButton(footer, {
      cls: "mod-cta",
      text: this.saving ? this.label("保存中…", "Saving…") : this.label("保存 Server", "Save server"),
      attr: { type: "button", "data-mcp-modal-focus-key": "save" }
    });
    applyAmicroButton(save, { variant: "primary", motion: "complete" });
    save.disabled = this.saving;
    save.onclick = () => void this.save();
    if (!this.editing) this.focus("name");
    void status;
  }

  private createField(
    container: HTMLElement,
    label: string,
    description: string,
    key: string
  ): HTMLElement {
    const field = container.createDiv({ cls: "codex-mcp-server-field" });
    const labelEl = field.createEl("label", {
      cls: "codex-mcp-server-label",
      text: label,
      attr: { for: this.controlId(key) }
    });
    labelEl.createSpan({ cls: "codex-mcp-server-field-description", text: description });
    return field;
  }

  private renderTextField(container: HTMLElement, input: {
    key: string;
    label: string;
    description: string;
    value: string;
    placeholder: string;
    onInput: (value: string) => void;
  }): void {
    const field = this.createField(container, input.label, input.description, input.key);
    const control = createOriginInput(field, {
      cls: "codex-mcp-server-input",
      attr: {
        id: this.controlId(input.key),
        type: "text",
        placeholder: input.placeholder,
        "data-mcp-modal-focus-key": input.key
      }
    });
    this.decorateFieldControl(field, control, input.key);
    control.value = input.value;
    control.oninput = () => {
      this.clearFieldError(field, control, input.key);
      input.onInput(control.value);
    };
  }

  private renderTextareaField(container: HTMLElement, input: {
    key: string;
    label: string;
    description: string;
    value: string;
    placeholder: string;
    rows: number;
    onInput: (value: string) => void;
  }): void {
    const field = this.createField(container, input.label, input.description, input.key);
    const control = field.createEl("textarea", {
      cls: "codex-mcp-server-textarea",
      attr: {
        id: this.controlId(input.key),
        placeholder: input.placeholder,
        rows: String(input.rows),
        "data-mcp-modal-focus-key": input.key
      }
    });
    this.decorateFieldControl(field, control, input.key);
    control.value = input.value;
    control.oninput = () => {
      this.clearFieldError(field, control, input.key);
      input.onInput(control.value);
    };
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    let publicValues: Record<string, string> | undefined;
    try {
      publicValues = parseKeyValueLines(this.publicValues);
      this.validate(publicValues);
    } catch (error) {
      this.showValidationError(error);
      return;
    }
    const credential = this.credentialTarget.trim() || this.credentialSecret || this.existingCredential
      ? {
        purpose: this.transport === "http" ? "mcp_header" as const : "mcp_env" as const,
        targetName: this.credentialTarget.trim(),
        ...(this.credentialPrefix ? { prefix: this.credentialPrefix } : {}),
        ...(this.credentialSecret ? { secret: this.credentialSecret } : {}),
        ...(this.clearCredential ? { clear: true } : {})
      }
      : undefined;
    const base = {
      ...(this.options.resource ? { resourceId: this.options.resource.id } : {}),
      name: this.name,
      description: this.description,
      transport: this.transport,
      ...(credential ? { credential } : {})
    } as const;
    const draft: EchoInkMcpServerDraft = this.transport === "http"
      ? { ...base, transport: "http", url: this.endpoint, headers: publicValues }
      : {
        ...base,
        transport: "stdio",
        command: this.endpoint,
        args: this.args.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean),
        cwd: this.cwd,
        env: publicValues
      };
    this.saving = true;
    this.errorMessage = "";
    this.fieldErrors = {};
    this.render();
    try {
      await this.options.save(draft);
      if (!this.closed) this.close();
    } catch (error) {
      if (this.closed) return;
      this.saving = false;
      const fieldKey = this.fieldKeyForError(error);
      if (fieldKey) {
        this.fieldErrors = { [fieldKey]: this.errorText(error) };
        this.errorMessage = "";
        this.render();
        this.focus(fieldKey);
      } else {
        this.fieldErrors = {};
        this.errorMessage = this.errorText(error);
        this.render();
        this.focus("save");
      }
    }
  }

  private validate(publicValues: Record<string, string> | undefined): void {
    if (!this.name.trim()) throw new Error("name_required");
    if (!this.endpoint.trim()) throw new Error("endpoint_required");
    const credentialTarget = this.credentialTarget.trim();
    if ((this.credentialSecret || (this.existingCredential && !this.clearCredential)) && !credentialTarget) {
      throw new Error("credential_target_required");
    }
    if (credentialTarget && publicValues && Object.keys(publicValues).some((key) => key.toLowerCase() === credentialTarget.toLowerCase())) {
      throw new Error("credential_target_duplicate");
    }
  }

  private errorText(error: unknown): string {
    const code = error instanceof Error ? error.message : String(error);
    const known: Record<string, [string, string]> = {
      name_required: ["请输入 Server 名称。", "Enter a server name."],
      endpoint_required: ["请填写 Server URL 或启动命令。", "Enter a server URL or command."],
      credential_target_required: ["请填写 Credential 对应的 Header 或环境变量名称。", "Enter the header or environment variable used by the credential."],
      credential_target_duplicate: ["Credential 目标不能同时出现在普通 Header 或环境变量中。", "The credential target cannot also be a public header or environment variable."],
      mcp_credential_target_duplicate: ["Credential 目标不能同时出现在普通 Header 或环境变量中。", "The credential target cannot also be a public header or environment variable."],
      key_value_invalid: ["普通 Header 或环境变量必须按每行 NAME=value 填写。", "Public headers and environment variables must use one NAME=value per line."],
      mcp_server_name_invalid: ["Server 名称无效。", "The server name is invalid."],
      mcp_http_url_invalid: ["Server URL 无效；请使用不含凭据的 http(s) 地址。", "Use a valid http(s) URL without embedded credentials."],
      mcp_stdio_command_invalid: ["启动命令无效。", "The command is invalid."],
      mcp_credential_header_invalid: ["Credential Header 名称无效。", "The credential header name is invalid."],
      mcp_credential_env_invalid: ["Credential 环境变量名称无效。", "The credential environment variable is invalid."],
      mcp_credential_prefix_invalid: ["Credential 前缀无效。", "The credential prefix is invalid."]
    };
    const message = known[code];
    return message ? this.label(message[0], message[1]) : this.label(
      "MCP Server 未保存，请检查可见字段后重试。",
      "The MCP server was not saved. Review the visible fields and try again."
    );
  }

  private fieldKeyForError(error: unknown): string | null {
    const code = error instanceof Error ? error.message : String(error);
    const fields: Record<string, string> = {
      name_required: "name",
      endpoint_required: "endpoint",
      credential_target_required: "credential-target",
      credential_target_duplicate: "credential-target",
      mcp_credential_target_duplicate: "credential-target",
      key_value_invalid: "public-values",
      mcp_server_name_invalid: "name",
      mcp_http_url_invalid: "endpoint",
      mcp_stdio_command_invalid: "endpoint",
      mcp_credential_header_invalid: "credential-target",
      mcp_credential_env_invalid: "credential-target",
      mcp_credential_prefix_invalid: "credential-prefix"
    };
    return fields[code] ?? null;
  }

  private showValidationError(error: unknown): void {
    const fieldKey = this.fieldKeyForError(error);
    if (!fieldKey) {
      this.fieldErrors = {};
      this.errorMessage = this.errorText(error);
      this.render();
      this.focus("save");
      return;
    }
    this.fieldErrors = { [fieldKey]: this.errorText(error) };
    this.errorMessage = "";
    this.render();
    this.focus(fieldKey);
  }

  private decorateFieldControl(
    field: HTMLElement,
    control: HTMLInputElement | HTMLTextAreaElement,
    key: string
  ): void {
    const error = this.fieldErrors[key];
    if (!error) return;
    const errorId = this.errorId(key);
    control.setAttr("aria-invalid", "true");
    control.setAttr("aria-describedby", errorId);
    field.createDiv({
      cls: "codex-mcp-server-field-error",
      text: error,
      attr: { id: errorId, role: "alert" }
    });
  }

  private clearFieldError(
    field: HTMLElement,
    control: HTMLInputElement | HTMLTextAreaElement,
    key: string
  ): void {
    if (!this.fieldErrors[key]) return;
    delete this.fieldErrors[key];
    control.removeAttribute("aria-invalid");
    control.removeAttribute("aria-describedby");
    field.querySelector(`#${this.errorId(key)}`)?.remove();
  }

  private controlId(key: string): string {
    return `echoink-mcp-server-${key}`;
  }

  private errorId(key: string): string {
    return `${this.controlId(key)}-error`;
  }

  private focus(key: string): void {
    (this.modalEl.ownerDocument.defaultView ?? window).requestAnimationFrame(() => {
      this.modalEl.querySelector<HTMLElement>(`[data-mcp-modal-focus-key="${key}"]`)?.focus();
    });
  }
}

function parseKeyValueLines(value: string): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const line of value.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const separator = line.indexOf("=");
    const key = separator >= 0 ? line.slice(0, separator).trim() : "";
    const fieldValue = separator >= 0 ? line.slice(separator + 1).trim() : "";
    if (!key || !fieldValue || /[\r\n]/u.test(key) || key.includes("\u0000")) {
      throw new Error("key_value_invalid");
    }
    result[key] = fieldValue;
  }
  return Object.keys(result).length ? result : undefined;
}

function stringifyKeyValueLines(value: Record<string, string> | undefined): string {
  return Object.entries(value ?? {}).map(([key, raw]) => `${key}=${raw}`).join("\n");
}
