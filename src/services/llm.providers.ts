import type { LLMProvider } from '../types/index.js';

export interface LLMProviderPreset {
  name: string;
  value: LLMProvider;
  baseUrl: string;
  models: Array<{ name: string; value: string }>;
  allowCustomModel?: boolean;
  allowCustomBaseUrl?: boolean;
  apiHeaders?: Record<string, string>;
}

export const LLM_PROVIDER_PRESETS: LLMProviderPreset[] = [
  {
    name: 'OpenAI',
    value: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: [
      { name: 'GPT-4o-mini', value: 'gpt-4o-mini' },
      { name: 'GPT-4o', value: 'gpt-4o' },
      { name: 'GPT-4-turbo', value: 'gpt-4-turbo' },
    ],
  },
  {
    name: 'MiniMax',
    value: 'minimax',
    baseUrl: 'https://api.minimaxi.com/v1',
    models: [
      { name: 'MiniMax-M2.7', value: 'MiniMax-M2.7' },
      { name: 'MiniMax-M2.5', value: 'MiniMax-M2.5' },
      { name: 'MiniMax-M2.1', value: 'MiniMax-M2.1' },
      { name: 'MiniMax-M2', value: 'MiniMax-M2' },
    ],
  },
  {
    name: 'Kimi (Moonshot AI)',
    value: 'moonshot',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: [
      { name: 'Kimi K2.6', value: 'kimi-k2.6' },
      { name: 'Kimi K2.5', value: 'kimi-k2.5' },
      { name: 'Moonshot V1 Auto', value: 'moonshot-v1-auto' },
      { name: 'moonshot-v1-8k', value: 'moonshot-v1-8k' },
      { name: 'moonshot-v1-32k', value: 'moonshot-v1-32k' },
      { name: 'moonshot-v1-128k', value: 'moonshot-v1-128k' },
      { name: 'Moonshot V1 8K Vision Preview', value: 'moonshot-v1-8k-vision-preview' },
      { name: 'Moonshot V1 32K Vision Preview', value: 'moonshot-v1-32k-vision-preview' },
      { name: 'Moonshot V1 128K Vision Preview', value: 'moonshot-v1-128k-vision-preview' },
    ],
  },
  {
    name: 'GLM (Zhipu AI)',
    value: 'zhipu',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: [
      { name: 'GLM-5.1', value: 'glm-5.1' },
      { name: 'GLM-5', value: 'glm-5' },
      { name: 'GLM-5-Turbo', value: 'glm-5-turbo' },
      { name: 'GLM-4.7', value: 'glm-4.7' },
      { name: 'GLM-4.7-Flash', value: 'glm-4.7-flash' },
      { name: 'GLM-4.6', value: 'glm-4.6' },
      { name: 'GLM-4.5', value: 'glm-4.5' },
      { name: 'GLM-4.5-Air', value: 'glm-4.5-air' },
      { name: 'GLM-4.5-AirX', value: 'glm-4.5-airx' },
    ],
  },
  {
    name: 'Custom (OpenAI-compatible)',
    value: 'custom',
    baseUrl: '',
    models: [],
    allowCustomModel: true,
    allowCustomBaseUrl: true,
  },
];

export function findLLMProviderPreset(provider: LLMProvider): LLMProviderPreset | undefined {
  return LLM_PROVIDER_PRESETS.find((item) => item.value === provider);
}
