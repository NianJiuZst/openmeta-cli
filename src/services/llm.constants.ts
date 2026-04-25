export const LLM_VALIDATION_TIMEOUT_MS = 120_000;
export const LLM_VALIDATION_PROMPT = 'Reply with exactly: OK';
export const LLM_VALIDATION_REQUEST = {
  // 把验证请求压到最小，减少 token 消耗，也避免部分模型顺手输出一大段内容。
  temperature: 0,
  top_p: 1,
  max_tokens: 8,
  stream: false,
} as const;

export const LLM_VALIDATION_STATUS_HINTS: Record<number, string> = {
  400: 'The provider rejected the request. Check the base URL, request format, and model name.',
  401: 'Authentication failed. Check that the API key is correct and still active.',
  403: 'The API key is valid but does not have permission to use this model or endpoint.',
  404: 'The model name or API base URL may be incorrect.',
  408: 'The provider timed out while validating the request.',
  429: 'The provider rate-limited the request or the account quota is exhausted.',
  500: 'The provider returned an internal server error.',
  502: 'The provider gateway is temporarily unavailable.',
  503: 'The provider service is temporarily unavailable.',
  504: 'The provider gateway timed out while processing the request.',
};

export const LLM_VALIDATION_FALLBACK_HINTS = {
  timeout: 'The validation request timed out before the provider returned a response.',
  aborted: 'The validation request was aborted before a response was received.',
  network: 'The provider could not be reached. Check network access and the configured base URL.',
  unknown: 'The provider validation failed for an unknown reason. Check the debug logs for details.',
} as const;
