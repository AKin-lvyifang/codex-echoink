import { NEXT } from "../next";
import { errorCopyLanguage, pickErrorCopy, type ErrorCopy } from "../types";

const withNext = (lead: ErrorCopy, next: ErrorCopy): ErrorCopy => [`${lead[0]}${next[0]}`, `${lead[1]} ${next[1]}`];

/** Diagnostic codes stored on an MCP connection; the sentence is picked by interface language when shown. */
export type McpDiagnosticCode = "connection_failed" | "authentication_failed" | "schema_invalid" | "disconnected" | "timeout" | "call_failed";

export const MCP_DIAGNOSTIC_COPY = {
  connection_failed: ["无法连接 MCP 服务。请检查服务地址或启动命令后重新测试连接。", "Could not connect to the MCP service. Check its address or start command, then test the connection again."],
  authentication_failed: ["MCP 服务认证失败。请在 MCP 设置中检查认证信息后重新测试连接。", "MCP authentication failed. Check the credentials in MCP settings, then test the connection again."],
  schema_invalid: ["MCP 服务返回的工具定义无效。请更新该服务或联系其提供方。", "The MCP service returned invalid tool definitions. Update the service or contact its provider."],
  disconnected: ["MCP 服务已断开连接。请重新测试连接。", "The MCP service disconnected. Test the connection again."],
  timeout: ["MCP 服务连接或请求超时。请稍后重新测试连接。", "The MCP service timed out. Test the connection again later."],
  call_failed: withNext(["MCP 工具调用未能完成。", "The MCP tool call could not be completed."], NEXT.retryLater)
} as const satisfies Record<McpDiagnosticCode, ErrorCopy>;

/** Broker and settings failures. Keys are prefixed so they never match another area's code. */
export const MCP_CODES = {
  mcp_connection_failed: MCP_DIAGNOSTIC_COPY.connection_failed,
  mcp_authentication_failed: MCP_DIAGNOSTIC_COPY.authentication_failed,
  mcp_schema_invalid: MCP_DIAGNOSTIC_COPY.schema_invalid,
  mcp_disconnected: MCP_DIAGNOSTIC_COPY.disconnected,
  mcp_timeout: MCP_DIAGNOSTIC_COPY.timeout,
  mcp_call_failed: MCP_DIAGNOSTIC_COPY.call_failed,
  mcp_request_timeout: withNext(["MCP 服务请求超时。", "The MCP request timed out."], NEXT.retryLater),
  mcp_request_failed: withNext(["MCP 服务请求未能完成。", "The MCP request could not be completed."], NEXT.retryLater),
  mcp_config_missing: ["MCP 服务缺少连接配置。请在 MCP 设置中重新保存该服务。", "The MCP service has no connection settings. Save it again in MCP settings."],
  mcp_tools_invalid: ["MCP 服务返回的工具列表无效。请更新该服务或联系其提供方。", "The MCP service returned an invalid tool list. Update the service or contact its provider."],
  mcp_session_invalid: ["MCP 服务返回的会话标识无效。请重新测试连接。", "The MCP service returned an invalid session. Test the connection again."],
  mcp_empty_result: withNext(["MCP 服务未返回内容。", "The MCP service returned nothing."], NEXT.retryLater),
  mcp_result_invalid: ["MCP 服务返回的内容无法识别。请更新该服务或联系其提供方。", "The MCP service returned content that could not be read. Update the service or contact its provider."],
  mcp_tool_list_failed: ["暂时无法读取该服务的工具列表。请重新测试连接。", "The tool list for this service could not be read. Test the connection again."],
  mcp_call_cancelled: ["MCP 工具调用已取消。", "The MCP tool call was cancelled."],
  mcp_server_not_found: ["该 MCP 服务已不存在。请刷新 MCP 列表后重试。", "This MCP service no longer exists. Refresh the MCP list and try again."],
  mcp_connection_not_found: ["该 MCP 服务已不存在。请刷新 MCP 列表后重试。", "This MCP service no longer exists. Refresh the MCP list and try again."],
  mcp_tool_not_found: ["该 MCP 工具已不存在。请重新测试连接后重试。", "This MCP tool no longer exists. Test the connection again, then retry."],
  mcp_server_name_invalid: ["服务名称无效。请输入不超过 120 个字符的名称。", "The service name is invalid. Enter a name of up to 120 characters."],
  mcp_http_url_invalid: ["服务地址无效。请使用不含用户名、密码或令牌的 http(s) 地址。", "The service address is invalid. Use an http(s) address without a username, password or token."],
  mcp_stdio_command_invalid: ["启动命令无效。请输入单行可执行命令，参数逐行填写在下方。", "The command is invalid. Enter a single-line executable and put arguments on separate lines below."],
  mcp_credential_header_invalid: ["认证 Header 名称无效。请使用字母、数字或短横线组成的名称，例如 Authorization。", "The credential header name is invalid. Use letters, digits or hyphens, for example Authorization."],
  mcp_credential_env_invalid: ["认证环境变量名称无效。请使用字母、数字或下划线组成的名称，例如 API_TOKEN。", "The credential environment variable is invalid. Use letters, digits or underscores, for example API_TOKEN."],
  mcp_credential_prefix_invalid: ["认证前缀无效。请输入不超过 64 个字符的单行前缀。", "The credential prefix is invalid. Enter a single-line prefix of up to 64 characters."],
  mcp_credential_target_duplicate: ["认证信息的目标与普通 Header 或环境变量重名。请删除重名项或更换名称。", "The credential target is also listed as a public header or environment variable. Remove the duplicate or rename it."],
  mcp_credential_transport_mismatch: ["认证信息与连接方式不匹配。请重新填写认证信息后保存。", "The credential does not match the connection type. Enter the credential again and save."],
  mcp_credential_not_configured: ["该 MCP 服务的认证信息尚未填写。请在 MCP 设置中填写后重新测试连接。", "The credential for this MCP service is missing. Enter it in MCP settings, then test the connection again."],
  mcp_server_delete_not_allowed: ["该 MCP 服务无法在此删除。请在其来源中移除。", "This MCP service cannot be removed here. Remove it from its source."]
} as const satisfies Record<string, ErrorCopy>;

/** Form validation codes raised by the MCP server form (not prefixed, so only the form looks them up). */
export const MCP_FORM_CODES = {
  name_required: ["尚未填写名称。请输入服务名称。", "No name was entered. Enter a service name."],
  endpoint_required: ["尚未填写连接地址。请填写服务地址或启动命令。", "No connection was entered. Enter a service address or command."],
  credential_target_required: ["认证信息尚未指定用途。请填写对应的 Header 或环境变量名称。", "The credential has no target. Enter the header or environment variable it uses."],
  credential_target_duplicate: MCP_CODES.mcp_credential_target_duplicate,
  key_value_invalid: ["普通 Header 或环境变量格式无效。请按每行 NAME=value 填写。", "Public headers or environment variables are invalid. Use one NAME=value per line."]
} as const satisfies Record<string, ErrorCopy>;

/** The MCP server form's save fallback. */
export const MCP_SAVE_FAILED: ErrorCopy = ["MCP 服务未能保存。请检查填写内容后重试。", "The MCP service could not be saved. Check the entries and try again."];

export type McpCode = keyof typeof MCP_CODES;

/** Stored diagnostic code → sentence in the interface language. */
export function mcpDiagnosticText(code: McpDiagnosticCode, language?: string): string {
  return pickErrorCopy(MCP_DIAGNOSTIC_COPY[code] ?? MCP_DIAGNOSTIC_COPY.connection_failed, errorCopyLanguage(language));
}
