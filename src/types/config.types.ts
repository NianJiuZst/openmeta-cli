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

export type LLMProvider = 'openai' | 'minimax' | 'moonshot' | 'zhipu' | 'custom';

export interface LLMConfig {
  provider: LLMProvider;
  apiBaseUrl: string;
  apiKey: string;
  modelName: string;
  apiHeaders?: Record<string, string>;
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
