import { describe, expect, test } from 'bun:test';
import {
  LLM_PROVIDER_PRESETS,
  findLLMProviderPreset,
} from '../src/services/llm.providers.js';

describe('LLMProviderPresets', () => {
  test('contains all expected providers', () => {
    const expectedProviders = ['openai', 'minimax', 'moonshot', 'zhipu', 'gemini', 'claude', 'custom'];
    const actualProviders = LLM_PROVIDER_PRESETS.map(p => p.value);

    expectedProviders.forEach(provider => {
      expect(actualProviders).toContain(provider);
    });
  });

  test('has at least one model for each built-in provider', () => {
    const builtInProviders = LLM_PROVIDER_PRESETS.filter(p => p.value !== 'custom');

    builtInProviders.forEach(provider => {
      expect(provider.models.length).toBeGreaterThan(0);
    });
  });

  test('custom provider allows custom model and base URL', () => {
    const customProvider = LLM_PROVIDER_PRESETS.find(p => p.value === 'custom');

    expect(customProvider).toBeDefined();
    expect(customProvider?.allowCustomModel).toBe(true);
    expect(customProvider?.allowCustomBaseUrl).toBe(true);
    expect(customProvider?.baseUrl).toBe('');
    expect(customProvider?.models).toEqual([]);
  });

  test('each built-in provider has non-empty base URL', () => {
    const builtInProviders = LLM_PROVIDER_PRESETS.filter(p => p.value !== 'custom');

    builtInProviders.forEach(provider => {
      expect(provider.baseUrl.length).toBeGreaterThan(0);
    });
  });

  test('each model has name and value', () => {
    LLM_PROVIDER_PRESETS.forEach(provider => {
      provider.models.forEach(model => {
        expect(model.name.length).toBeGreaterThan(0);
        expect(model.value.length).toBeGreaterThan(0);
      });
    });
  });

  test('gemini provider has correct base URL', () => {
    const gemini = LLM_PROVIDER_PRESETS.find(p => p.value === 'gemini');

    expect(gemini).toBeDefined();
    expect(gemini?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
    expect(gemini?.name).toBe('Gemini (Google AI)');
  });

  test('claude provider has correct base URL', () => {
    const claude = LLM_PROVIDER_PRESETS.find(p => p.value === 'claude');

    expect(claude).toBeDefined();
    expect(claude?.baseUrl).toBe('https://api.anthropic.com/v1/');
    expect(claude?.name).toBe('Claude (Anthropic)');
  });
});

describe('findLLMProviderPreset', () => {
  test('returns correct preset for openai', () => {
    const preset = findLLMProviderPreset('openai');

    expect(preset).toBeDefined();
    expect(preset?.value).toBe('openai');
    expect(preset?.baseUrl).toBe('https://api.openai.com/v1');
  });

  test('returns correct preset for minimax', () => {
    const preset = findLLMProviderPreset('minimax');

    expect(preset).toBeDefined();
    expect(preset?.value).toBe('minimax');
    expect(preset?.baseUrl).toBe('https://api.minimaxi.com/v1');
  });

  test('returns correct preset for moonshot', () => {
    const preset = findLLMProviderPreset('moonshot');

    expect(preset).toBeDefined();
    expect(preset?.value).toBe('moonshot');
    expect(preset?.baseUrl).toBe('https://api.moonshot.cn/v1');
  });

  test('returns correct preset for zhipu', () => {
    const preset = findLLMProviderPreset('zhipu');

    expect(preset).toBeDefined();
    expect(preset?.value).toBe('zhipu');
    expect(preset?.baseUrl).toBe('https://open.bigmodel.cn/api/paas/v4');
  });

  test('returns correct preset for gemini', () => {
    const preset = findLLMProviderPreset('gemini');

    expect(preset).toBeDefined();
    expect(preset?.value).toBe('gemini');
    expect(preset?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai/');
  });

  test('returns correct preset for claude', () => {
    const preset = findLLMProviderPreset('claude');

    expect(preset).toBeDefined();
    expect(preset?.value).toBe('claude');
    expect(preset?.baseUrl).toBe('https://api.anthropic.com/v1/');
  });

  test('returns correct preset for custom', () => {
    const preset = findLLMProviderPreset('custom');

    expect(preset).toBeDefined();
    expect(preset?.value).toBe('custom');
    expect(preset?.allowCustomModel).toBe(true);
    expect(preset?.allowCustomBaseUrl).toBe(true);
  });

  test('returns undefined for unknown provider', () => {
    const preset = findLLMProviderPreset('unknown' as any);

    expect(preset).toBeUndefined();
  });
});
