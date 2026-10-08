/** Public documentation shape; no credentials or Vault data. */
export const deepSeekModelListFixture = {
  object: "list",
  data: [
    { id: "deepseek-flash", name: "DeepSeek-V4.1-Flash", input_modalities: ["text", "image"], context_window: 1048576, max_output_tokens: 393216, effort: { supported_levels: ["low", "high", "max"], default_level: "high" } },
    { id: "deepseek-v4-pro", name: "DeepSeek-V4-Pro", input_modalities: ["text"], context_window: 1048576, max_output_tokens: 393216, effort: { supported_levels: ["low", "high", "max"], default_level: "high" } }
  ]
};

export const syntheticDiscoveredModel = {
  id: "future-model-not-in-any-catalog-2030",
  name: "Future Model 2030",
  input_modalities: ["text", "image"],
  supports_tool_calling: true,
  supports_reasoning: true,
  context_window: 131072,
  max_output_tokens: 32768,
  effort: { supported_levels: ["low", "high", "max"], default_level: "high" },
  arbitrary_request_field: "MUST_NOT_REACH_PAYLOAD"
};
