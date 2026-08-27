import { describe, expect, test } from 'bun:test';
import type { StructuredOutputStatus } from '../src/contracts/index.js';
import { contextAssemblerService } from '../src/services/context-assembler.js';
import { LLMService } from '../src/services/llm.js';
import type { ImplementationDraft, MatchedIssue } from '../src/types/index.js';
import { createIssue, createMemory, createRankedIssue, createWorkspace } from './helpers/factories.js';

interface LLMServiceInternals {
  validateConnection(): Promise<boolean>;
  getLastValidationError(): string | null;
  generatePatchDraft(
    issue: ReturnType<typeof createRankedIssue>,
    workspace: ReturnType<typeof createWorkspace>,
    memory: ReturnType<typeof createMemory>,
  ): Promise<{
    status: StructuredOutputStatus;
    data: {
      goal: string;
      targetFiles: Array<{ path: string; reason: string }>;
      proposedChanges: Array<{ title: string; details: string; files: string[] }>;
      risks: string[];
      validationNotes: string[];
    };
  }>;
  analyzeRepository(
    repoFullName: string,
    workspace: ReturnType<typeof createWorkspace>,
    memory: ReturnType<typeof createMemory>,
  ): Promise<{
    status: StructuredOutputStatus;
    data: Array<{
      id: string;
      title: string;
      prPotentialScore: number;
    }>;
  }>;
  assessIssueFeasibility(
    issue: ReturnType<typeof createRankedIssue>,
    workspace: ReturnType<typeof createWorkspace>,
    environment: {
      os: {
        platform: NodeJS.Platform;
        arch: string;
        distro: string;
        version: string;
        isWSL: boolean;
        wslDistros: string[];
        hypervisor: {
          isVM: boolean;
          type: 'hyper-v' | 'virtualbox' | 'vmware' | 'kvm' | 'qemu' | 'parallels' | 'wsl' | 'docker-desktop' | 'none';
          isContainer: boolean;
          isCI: boolean;
          ciName?: string;
        };
      };
      cpu: { model: string; cores: number; threads: number };
      gpu: Array<{ model: string; vramMB: number; driverVersion?: string; cudaVersion?: string }>;
      totalRAMGB: number;
      disks: Array<{ mountPoint: string; totalGB: number; freeGB: number }>;
      tools: Array<{ name: string; available: boolean; version?: string; path?: string }>;
    },
  ): Promise<{
    status: StructuredOutputStatus;
    data: {
      decision:
        | 'proceed'
        | 'repair_then_proceed'
        | 'proceed_static_only'
        | 'proceed_partial_validation'
        | 'stop_hard_blocked'
        | 'stop_user_action_required';
      executionMode: 'full' | 'partial' | 'static_only' | 'blocked';
      summary: string;
    };
  }>;
  client: {
    chat: {
      completions: {
        create: (payload: {
          model: string;
          messages: Array<{ role: string; content: string }>;
          temperature: number;
          reasoning_effort?: string;
          stream?: boolean;
          stream_options?: { include_usage?: boolean };
        }) => unknown | Promise<unknown>;
      };
    };
  } | null;
  provider: 'openai' | 'minimax' | 'moonshot' | 'zhipu' | 'custom';
  parseImplementationDraft(content: string): {
    status: StructuredOutputStatus;
    data: ImplementationDraft;
  };
  parsePatchDraft(content: string): {
    status: StructuredOutputStatus;
    data: {
      goal: string;
      targetFiles: Array<{ path: string; reason: string }>;
      proposedChanges: Array<{ title: string; details: string; files: string[] }>;
      risks: string[];
      validationNotes: string[];
    };
  };
  parsePullRequestDraft(content: string): {
    status: StructuredOutputStatus;
    data: {
      title: string;
      summary: string;
      changes: string[];
      validation: string[];
      risks: string[];
    };
  };
  parseRepositorySuggestions(content: string): {
    status: StructuredOutputStatus;
    data: Array<{
      id: string;
      title: string;
      summary: string;
      rationale: string;
      targetFiles: Array<{ path: string; reason: string }>;
      proposedChanges: string[];
      validationPlan: string[];
      risks: string[];
      estimatedWorkload: 'small' | 'medium' | 'large';
      prPotentialScore: number;
    }>;
  };
  parseLLMResponse(
    content: string,
    originalIssues: ReturnType<typeof createIssue>[],
  ): {
    status: StructuredOutputStatus;
    data: MatchedIssue[];
  };
}

describe('LLMService repository suggestion parsing', () => {
  test('parses structured repository suggestions and keeps the highest scoring duplicate', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const suggestions = service.parseRepositorySuggestions(`
      {
        "version": "1",
        "kind": "repository_suggestion_list",
        "status": "success",
        "data": {
          "suggestions": [
            {
              "id": "docs-install",
              "title": "Document the local install path",
              "summary": "Make setup instructions easier to follow.",
              "rationale": "The README mentions installation but not local linking.",
              "targetFiles": [
                {
                  "path": "README.md",
                  "reason": "Primary onboarding documentation"
                }
              ],
              "proposedChanges": ["Add a local install section"],
              "validationPlan": ["Run the documented command in a clean shell"],
              "risks": ["Docs may drift if package scripts change"],
              "estimatedWorkload": "small",
              "prPotentialScore": 72
            },
            {
              "id": "config-validation",
              "title": "Add config validation tests",
              "summary": "Cover malformed provider config normalization.",
              "rationale": "Config compatibility is a high-impact safety path.",
              "targetFiles": [
                {
                  "path": "src/infra/config.ts",
                  "reason": "Normalization logic"
                },
                {
                  "path": "test/config.test.ts",
                  "reason": "Regression coverage"
                }
              ],
              "proposedChanges": ["Add tests for invalid stream and reasoning values"],
              "validationPlan": ["bun test test/config.test.ts"],
              "risks": [],
              "estimatedWorkload": "medium",
              "prPotentialScore": 91
            },
            {
              "id": "docs-install",
              "title": "Document the local install path",
              "summary": "Duplicate lower-scoring suggestion.",
              "rationale": "Same suggestion should be deduped.",
              "targetFiles": [
                {
                  "path": "README.md",
                  "reason": "Primary onboarding documentation"
                }
              ],
              "proposedChanges": ["Add a smaller docs note"],
              "validationPlan": ["Read the docs"],
              "risks": [],
              "estimatedWorkload": "small",
              "prPotentialScore": 61
            }
          ]
        }
      }
    `);

    expect(suggestions.status).toBe('success');
    expect(suggestions.data).toHaveLength(2);
    expect(suggestions.data[0]?.id).toBe('config-validation');
    expect(suggestions.data[0]?.targetFiles.map((file) => file.path)).toEqual([
      'src/infra/config.ts',
      'test/config.test.ts',
    ]);
    expect(suggestions.data[1]?.id).toBe('docs-install');
    expect(suggestions.data[1]?.summary).toBe('Make setup instructions easier to follow.');
  });

  test('generates repository analysis requests from workspace context', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals & {
      initialize(
        apiKey: string,
        baseUrl: string,
        modelName?: string,
        apiHeaders?: Record<string, string>,
        provider?: 'openai',
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
        stream?: boolean,
      ): void;
    };
    const payloads: Array<{
      messages: Array<{ role: string; content: string }>;
      stream?: boolean;
      reasoning_effort?: string;
    }> = [];

    service.initialize('sk-test', 'https://api.openai.com/v1', 'gpt-5.5', {}, 'openai', 'high', true);
    service.client = {
      chat: {
        completions: {
          create: async (payload) => {
            payloads.push(payload);
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      version: '1',
                      kind: 'repository_suggestion_list',
                      status: 'success',
                      data: {
                        suggestions: [
                          {
                            id: 'docs-install',
                            title: 'Document local install',
                            summary: 'Clarify setup docs.',
                            rationale: 'README setup is incomplete.',
                            targetFiles: [{ path: 'README.md', reason: 'Setup docs' }],
                            proposedChanges: ['Add local install instructions'],
                            validationPlan: ['Review README commands'],
                            risks: [],
                            estimatedWorkload: 'small',
                            prPotentialScore: 82,
                          },
                        ],
                      },
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const result = await service.analyzeRepository(
      'acme/demo',
      createWorkspace({
        topLevelFiles: ['README.md', 'package.json', 'src'],
        candidateFiles: ['README.md', 'src/index.ts'],
        snippets: [
          { path: 'README.md', content: '# Demo\n\nInstall instructions are missing.\n' },
          { path: 'src/index.ts', content: 'export const demo = true;\n' },
        ],
        testCommands: [
          { command: 'bun test', reason: 'Detected package.json test script (bun)', source: 'repo-script' },
        ],
        validationCommands: [
          { command: 'bun test', reason: 'Detected package.json test script (bun)', source: 'repo-script' },
        ],
      }),
      createMemory(),
    );

    expect(result.data[0]?.title).toBe('Document local install');
    expect(payloads[0]).toMatchObject({
      stream: true,
      reasoning_effort: 'high',
    });
    expect(payloads[0]?.messages[1]?.content).toContain('Repository: acme/demo');
    expect(payloads[0]?.messages[1]?.content).toContain('Candidate Files: README.md, src/index.ts');
    expect(payloads[0]?.messages[1]?.content).toContain('FILE: README.md');
    expect(payloads[0]?.messages[1]?.content).toContain('Detected Test Commands: bun test');
  });
});

describe('LLMService issue feasibility assessment', () => {
  test('generates feasibility requests with issue, repo, and local environment context', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals & {
      initialize(apiKey: string, baseUrl: string, modelName?: string): void;
    };
    const payloads: Array<{ messages: Array<{ role: string; content: string }>; temperature: number }> = [];

    service.initialize('sk-test', 'https://api.openai.com/v1', 'gpt-4o-mini');
    service.client = {
      chat: {
        completions: {
          create: async (payload) => {
            payloads.push(payload);
            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      version: '1',
                      kind: 'issue_feasibility_assessment',
                      status: 'success',
                      data: {
                        decision: 'proceed_static_only',
                        executionMode: 'static_only',
                        confidence: 'high',
                        summary: 'This docs-only issue can be handled without CUDA runtime validation.',
                        requiredCapabilities: ['markdown'],
                        gaps: [
                          {
                            code: 'insufficient_gpu',
                            description: 'CUDA runtime validation is not available locally.',
                            severity: 'warning',
                            recoverability: 'not_practical_local',
                            suggestedAction: 'Keep execution limited to docs-only changes.',
                          },
                        ],
                        validationPlan: ['Review the README diff'],
                        rationale: 'The issue text and target file scope are documentation-only.',
                      },
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const result = await service.assessIssueFeasibility(
      createRankedIssue({ title: 'Clarify CUDA setup docs', body: 'Update README wording only.' }),
      createWorkspace({
        topLevelFiles: ['README.md', 'pyproject.toml'],
        candidateFiles: ['README.md'],
        snippets: [{ path: 'README.md', content: '# Demo\n\nCUDA setup is unclear.\n' }],
      }),
      {
        os: {
          platform: 'win32',
          arch: 'x64',
          distro: 'Windows',
          version: '10.0',
          isWSL: false,
          wslDistros: [],
          hypervisor: {
            isVM: false,
            type: 'none',
            isContainer: false,
            isCI: false,
          },
        },
        cpu: { model: 'Test CPU', cores: 8, threads: 16 },
        gpu: [],
        totalRAMGB: 16,
        disks: [{ mountPoint: 'C:', totalGB: 512, freeGB: 128 }],
        tools: [
          { name: 'git', available: true, version: 'git version 2.45.0' },
          { name: 'python', available: false },
          { name: 'nvidia-smi', available: false },
        ],
      },
    );

    expect(result.data.decision).toBe('proceed_static_only');
    expect(payloads[0]?.temperature).toBe(0.1);
    expect(payloads[0]?.messages[1]?.content).toContain('Issue: acme/demo#42');
    expect(payloads[0]?.messages[1]?.content).toContain('FILE: README.md');
    expect(payloads[0]?.messages[1]?.content).toContain('GPU: none detected');
    expect(payloads[0]?.messages[1]?.content).toContain('Virtualization: vm=no, type=none');
    expect(payloads[0]?.messages[1]?.content).toContain('Missing Tools: python, nvidia-smi');
  });
});

describe('LLMService implementation draft parsing', () => {
  test('parses raw JSON responses into file change drafts', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parseImplementationDraft(`
      {
        "version": "1",
        "kind": "implementation_draft",
        "status": "success",
        "data": {
          "summary": "Update the button label",
          "fileChanges": [
            {
              "path": "src/button.tsx",
              "reason": "Add aria-label",
              "content": "export const Button = () => <button aria-label=\\"Open\\" />;"
            }
          ]
        }
      }
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.summary).toBe('Update the button label');
    expect(draft.data.fileChanges).toHaveLength(1);
    expect(draft.data.fileChanges[0]?.path).toBe('src/button.tsx');
  });

  test('rejects fenced JSON responses that fail schema validation', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    expect(() =>
      service.parseImplementationDraft(`
      \`\`\`json
      {
        "version": "1",
        "kind": "implementation_draft",
        "status": "success",
        "data": {
          "summary": "Mixed output",
          "fileChanges": [
            {
              "path": "src/app.ts",
              "reason": "Valid",
              "content": "console.log('ok');"
            },
            {
              "path": "",
              "reason": "Missing path",
              "content": "ignored"
            }
          ]
        }
      }
      \`\`\`
    `),
    ).toThrow('LLM output failed schema validation.');
  });

  test('parses fenced JSON responses with raw tsx content', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parseImplementationDraft(`
      \`\`\`json
      {
        "version": "1",
        "kind": "implementation_draft",
        "status": "success",
        "data": {
          "summary": "Add aria-label support",
          "fileChanges": [
            {
              "path": "src/components/IconButton.tsx",
              "reason": "Add accessible label handling for icon-only buttons",
              "content": "export function IconButton() {\\n  return <button aria-label=\\"Open menu\\" />;\\n}"
            }
          ]
        }
      }
      \`\`\`
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.summary).toBe('Add aria-label support');
    expect(draft.data.fileChanges).toHaveLength(1);
    expect(draft.data.fileChanges[0]?.path).toBe('src/components/IconButton.tsx');
    expect(draft.data.fileChanges[0]?.content).toContain('aria-label="Open menu"');
  });

  test('deduplicates repeated file changes by path and keeps the latest version', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parseImplementationDraft(`
      {
        "version": "1",
        "kind": "implementation_draft",
        "status": "success",
        "data": {
          "summary": "Repeated output",
          "fileChanges": [
            {
              "path": "src/button.tsx",
              "reason": "First attempt",
              "content": "export const Button = () => null;"
            },
            {
              "path": "src/button.tsx",
              "reason": "Final attempt",
              "content": "export const Button = () => <button />;"
            }
          ]
        }
      }
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.fileChanges).toHaveLength(1);
    expect(draft.data.fileChanges[0]?.reason).toBe('Final attempt');
    expect(draft.data.fileChanges[0]?.content).toContain('<button />');
  });

  test('throws when implementation output is not parseable', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    expect(() => service.parseImplementationDraft('unstructured output')).toThrow(
      'LLM did not return a parseable JSON object.',
    );
  });
});

describe('LLMService validation behavior', () => {
  test('requires an OpenAI-compatible payload for custom providers', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    service.provider = 'custom';
    service.client = {
      chat: {
        completions: {
          create: async () => '<!doctype html><html></html>',
        },
      },
    };

    const valid = await service.validateConnection();

    expect(valid).toBe(false);
    expect(service.getLastValidationError()).toContain('did not match the expected OpenAI-compatible format');
  });

  test('accepts exact OK replies for custom providers', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    service.provider = 'custom';
    service.client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'OK' } }],
          }),
        },
      },
    };

    const valid = await service.validateConnection();
    expect(valid).toBe(true);
  });

  test('accepts non-empty assistant replies for custom providers', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    service.provider = 'custom';
    service.client = {
      chat: {
        completions: {
          create: async () => ({
            choices: [{ message: { content: 'Validation passed.' } }],
          }),
        },
      },
    };

    const valid = await service.validateConnection();
    expect(valid).toBe(true);
  });

  test('keeps existing lenient validation for built-in providers', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    service.provider = 'openai';
    service.client = {
      chat: {
        completions: {
          create: async () => '<!doctype html><html></html>',
        },
      },
    };

    const valid = await service.validateConnection();
    expect(valid).toBe(true);
  });

  test('uses streaming validation requests when streaming is enabled', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals & {
      initialize(
        apiKey: string,
        baseUrl: string,
        modelName?: string,
        apiHeaders?: Record<string, string>,
        provider?: 'custom',
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
        stream?: boolean,
      ): void;
    };
    const payloads: Array<Record<string, unknown>> = [];

    async function* validationChunks() {
      yield { choices: [{ delta: { content: 'O' } }] };
      yield { choices: [{ delta: { content: 'K' } }] };
    }

    service.initialize('sk-test', 'https://example.com/v1', 'gpt-5.5', {}, 'custom', 'xhigh', true);
    service.client = {
      chat: {
        completions: {
          create: (payload) => {
            payloads.push(payload);
            return validationChunks();
          },
        },
      },
    };

    const valid = await service.validateConnection();

    expect(valid).toBe(true);
    expect(payloads[0]).toMatchObject({
      model: 'gpt-5.5',
      stream: true,
      stream_options: {
        include_usage: true,
      },
      reasoning_effort: 'xhigh',
    });
  });
});

describe('LLMService reasoning effort requests', () => {
  test('streams chat completions and aggregates content chunks when enabled', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals & {
      initialize(
        apiKey: string,
        baseUrl: string,
        modelName?: string,
        apiHeaders?: Record<string, string>,
        provider?: 'openai',
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
        stream?: boolean,
      ): void;
      generateDailyReport(issueAnalysis: string): Promise<string>;
    };
    const payloads: Array<Record<string, unknown>> = [];

    async function* streamChunks() {
      yield { choices: [{ delta: { content: 'hel' } }] };
      yield { choices: [{ delta: { content: 'lo' } }] };
      yield { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } };
    }

    service.initialize('sk-test', 'https://api.openai.com/v1', 'gpt-5.5', {}, 'openai', 'xhigh', true);
    service.client = {
      chat: {
        completions: {
          create: (payload) => {
            payloads.push(payload);
            return streamChunks();
          },
        },
      },
    };

    const content = await service.generateDailyReport('issue analysis');

    expect(content).toBe('hello');
    expect(payloads[0]).toMatchObject({
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
      stream: true,
      stream_options: {
        include_usage: true,
      },
    });
  });

  test('uses non-streaming chat completions by default', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals & {
      initialize(
        apiKey: string,
        baseUrl: string,
        modelName?: string,
        apiHeaders?: Record<string, string>,
        provider?: 'openai',
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
        stream?: boolean,
      ): void;
      generateDailyReport(issueAnalysis: string): Promise<string>;
    };
    const payloads: Array<Record<string, unknown>> = [];

    service.initialize('sk-test', 'https://api.openai.com/v1', 'gpt-5.5', {}, 'openai', 'xhigh');
    service.client = {
      chat: {
        completions: {
          create: async (payload) => {
            payloads.push(payload);
            return { choices: [{ message: { content: 'done' } }] };
          },
        },
      },
    };

    const content = await service.generateDailyReport('issue analysis');

    expect(content).toBe('done');
    expect(payloads[0]).toMatchObject({
      model: 'gpt-5.5',
      reasoning_effort: 'xhigh',
    });
    expect(payloads[0]).not.toHaveProperty('stream');
    expect(payloads[0]).not.toHaveProperty('stream_options');
  });

  test('passes configured reasoning effort to chat completions', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals & {
      initialize(
        apiKey: string,
        baseUrl: string,
        modelName?: string,
        apiHeaders?: Record<string, string>,
        provider?: 'openai',
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
      ): void;
      generateDailyReport(issueAnalysis: string): Promise<string>;
    };
    const payloads: unknown[] = [];

    service.initialize('sk-test', 'https://api.openai.com/v1', 'gpt-5.5', {}, 'openai', 'high');
    service.client = {
      chat: {
        completions: {
          create: async (payload) => {
            payloads.push(payload);
            return { choices: [{ message: { content: 'done' } }] };
          },
        },
      },
    };

    await service.generateDailyReport('issue analysis');

    expect(payloads[0]).toMatchObject({
      model: 'gpt-5.5',
      reasoning_effort: 'high',
    });
  });

  test('omits reasoning effort for non-reasoning chat models', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals & {
      initialize(
        apiKey: string,
        baseUrl: string,
        modelName?: string,
        apiHeaders?: Record<string, string>,
        provider?: 'openai',
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
      ): void;
      generateDailyReport(issueAnalysis: string): Promise<string>;
    };
    const payloads: Array<Record<string, unknown>> = [];

    service.initialize('sk-test', 'https://api.openai.com/v1', 'gpt-4o-mini', {}, 'openai', 'none');
    service.client = {
      chat: {
        completions: {
          create: async (payload) => {
            payloads.push(payload);
            return { choices: [{ message: { content: 'done' } }] };
          },
        },
      },
    };

    await service.generateDailyReport('issue analysis');

    expect(payloads[0]).not.toHaveProperty('reasoning_effort');
  });

  test('omits default reasoning effort for custom legacy models', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals & {
      initialize(
        apiKey: string,
        baseUrl: string,
        modelName?: string,
        apiHeaders?: Record<string, string>,
        provider?: 'custom',
        reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh',
      ): void;
      generateDailyReport(issueAnalysis: string): Promise<string>;
    };
    const payloads: Array<Record<string, unknown>> = [];

    service.initialize('sk-test', 'https://example.com/v1', 'legacy-model', {}, 'custom', 'none');
    service.client = {
      chat: {
        completions: {
          create: async (payload) => {
            payloads.push(payload);
            return { choices: [{ message: { content: 'done' } }] };
          },
        },
      },
    };

    await service.generateDailyReport('issue analysis');

    expect(payloads[0]).not.toHaveProperty('reasoning_effort');
  });
});

describe('LLMService issue scoring response parsing', () => {
  test('parses structured matched issues and sorts by score descending', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const issues = [
      createIssue({ repoFullName: 'acme/demo', repoName: 'demo', number: 42 }),
      createIssue({ repoFullName: 'acme/web', repoName: 'web', number: 7, title: 'Improve docs' }),
      createIssue({ repoFullName: 'acme/ignored', repoName: 'ignored', number: 11 }),
    ];

    const parsed = service.parseLLMResponse(
      `
      {
        "version": "1",
        "kind": "issue_match_list",
        "status": "success",
        "data": {
          "matches": [
            {
              "issueReference": "acme/demo#42",
              "score": 100,
              "coreDemand": "Add accessible labels",
              "techRequirements": ["react", "typescript", "accessibility"],
              "estimatedWorkload": "1-2 hours",
              "claimStatus": "claimed",
              "claimEvidence": ""
            },
            {
              "issueReference": "acme/web#7",
              "score": 61,
              "coreDemand": "Improve documentation clarity",
              "techRequirements": ["markdown", "docs"],
              "estimatedWorkload": "30 minutes",
              "claimStatus": "likely",
              "claimEvidence": "alice said she is working on this"
            },
            {
              "issueReference": "acme/ignored#11",
              "score": 40,
              "coreDemand": "Ignore this issue",
              "techRequirements": ["none"],
              "estimatedWorkload": "1 hour"
            }
          ]
        }
      }
    `,
      issues,
    );

    expect(parsed.status).toBe('success');
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]?.repoFullName).toBe('acme/demo');
    expect(parsed.data[0]?.matchScore).toBe(100);
    expect(parsed.data[0]?.claimAssessment?.status).toBe('none');
    expect(parsed.data[0]?.analysis.techRequirements).toEqual(['react', 'typescript', 'accessibility']);
    expect(parsed.data[1]?.repoFullName).toBe('acme/web');
    expect(parsed.data[1]?.analysis.estimatedWorkload).toBe('30 minutes');
    expect(parsed.data[1]?.claimAssessment?.status).toBe('likely');
    expect(parsed.data[1]?.claimAssessment?.evidence[0]).toContain('alice said she is working on this');
  });
});

describe('LLMService pull request draft parsing', () => {
  test('parses structured patch drafts wrapped in envelopes', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parsePatchDraft(`
      {
        "version": "1",
        "kind": "patch_draft",
        "status": "success",
        "data": {
          "goal": "Add accessible labels to icon-only buttons",
          "targetFiles": [
            {
              "path": "src/components/IconButton.tsx",
              "reason": "Primary component logic"
            }
          ],
          "proposedChanges": [
            {
              "title": "Update button API",
              "details": "Require an accessible label for icon-only rendering.",
              "files": ["src/components/IconButton.tsx"]
            }
          ],
          "risks": ["Consumer code may rely on current behavior"],
          "validationNotes": ["Run bun test after the patch"]
        }
      }
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.goal).toBe('Add accessible labels to icon-only buttons');
    expect(draft.data.targetFiles[0]?.path).toBe('src/components/IconButton.tsx');
  });

  test('parses structured pull request drafts', () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const draft = service.parsePullRequestDraft(`
      {
        "version": "1",
        "kind": "pull_request_draft",
        "status": "success",
        "data": {
          "title": "Add aria-label handling to icon-only buttons",
          "summary": "Ensure icon-only buttons expose accessible names.",
          "changes": ["Update the shared IconButton component"],
          "validation": ["bun test (pending)"],
          "risks": ["Snapshot updates may be required"]
        }
      }
    `);

    expect(draft.status).toBe('success');
    expect(draft.data.title).toBe('Add aria-label handling to icon-only buttons');
    expect(draft.data.changes).toEqual(['Update the shared IconButton component']);
  });
});

describe('LLMService patch draft generation', () => {
  test('repairs a non-JSON first draft into a valid patch draft envelope', async () => {
    const service = new LLMService() as unknown as LLMServiceInternals;
    const prompts: string[] = [];

    service.client = {
      chat: {
        completions: {
          create: async (payload) => {
            prompts.push(payload.messages[1]?.content ?? '');

            if (prompts.length === 1) {
              return {
                choices: [{ message: { content: 'Plan: update the button component and tests.' } }],
              };
            }

            return {
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      version: '1',
                      kind: 'patch_draft',
                      status: 'success',
                      data: {
                        goal: 'Add accessible labels to icon-only buttons',
                        targetFiles: [
                          {
                            path: 'src/components/IconButton.tsx',
                            reason: 'Primary component logic',
                          },
                        ],
                        proposedChanges: [
                          {
                            title: 'Update button API',
                            details: 'Require an accessible label for icon-only rendering.',
                            files: ['src/components/IconButton.tsx'],
                          },
                        ],
                        risks: ['Consumer code may rely on current behavior'],
                        validationNotes: ['Run bun test after the patch'],
                      },
                    }),
                  },
                },
              ],
            };
          },
        },
      },
    };

    const draft = await service.generatePatchDraft(
      createRankedIssue(),
      createWorkspace({ validationCommands: createWorkspace().testCommands }),
      createMemory(),
    );

    expect(draft.status).toBe('success');
    expect(draft.data.goal).toBe('Add accessible labels to icon-only buttons');
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('The previous patch draft response was not parseable');
    expect(prompts[1]).toContain('Plan: update the button component and tests.');
  });
});

describe('ContextAssemblerService repo memory formatting', () => {
  test('includes run stats, path history, validation failures, and recent outcomes', () => {
    const formatted = contextAssemblerService.buildRepoMemoryContext(createMemory());

    expect(formatted).toContain('Run Stats: total=2, published=1, real_pr=1');
    expect(formatted).toContain('Top Path Signals:');
    expect(formatted).toContain('src/components/IconButton.tsx | candidate 3 | changed 2');
    expect(formatted).toContain('Recent Validation Failure Signals:');
    expect(formatted).toContain('bun test | failures 1 | last exit 1');
    expect(formatted).toContain('Recent Issue Outcomes:');
    expect(formatted).toContain('acme/demo#42 | status published');
  });
});
