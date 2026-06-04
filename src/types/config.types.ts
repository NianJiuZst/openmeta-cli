import type { ContentType } from './content.types.js';

export type UserProficiency = 'beginner' | 'intermediate' | 'advanced';
export type SchedulerProvider = 'launchd' | 'cron' | 'manual';

export interface UserProfile {
  techStack: string[];
  proficiency: UserProficiency;
  focusAreas: string[];
}

export interface GitHubConfig {
  pat: string;
  username: string;
  targetRepoPath?: string;
}

export type LLMProvider = 'openai' | 'minimax' | 'moonshot' | 'zhipu' | 'gemini' | 'claude' | 'custom';
export type LLMReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface LLMProviderProfile {
  provider: LLMProvider;
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  apiHeaders: Record<string, string>;
  reasoningEffort?: LLMReasoningEffort;
  stream?: boolean;
}

export interface LLMConfig {
  provider: LLMProvider;
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  apiHeaders?: Record<string, string>;
  reasoningEffort?: LLMReasoningEffort;
  stream?: boolean;
  showInteraction?: boolean;
  activeProfile?: string;
  profiles?: Record<string, LLMProviderProfile>;
}

export interface AutomationConfig {
  enabled: boolean;
  scheduleTime: string;
  timezone: string;
  contentType: ContentType;
  scheduler: SchedulerProvider;
  minMatchScore: number;
  skipIfAlreadyGeneratedToday: boolean;
}

export interface AppConfig {
  userProfile: UserProfile;
  github: GitHubConfig;
  llm: LLMConfig;
  automation: AutomationConfig;
  commitTemplate: string;
}
