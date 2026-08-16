import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { registerAgentCommand } from '../src/commands/agent.js';
import { registerAnalyzeCommand } from '../src/commands/analyze.js';
import { parseStarCount } from '../src/commands/number-options.js';
import { registerScoutCommand } from '../src/commands/scout.js';

describe('repository targeting command options', () => {
  test('registers scout targeting options for presets and all-repos fallback', () => {
    const program = new Command();
    registerScoutCommand(program);

    const scoutCommand = program.commands.find((command) => command.name() === 'scout');
    const help = scoutCommand?.helpInformation() ?? '';

    expect(help).toContain('--preset <name>');
    expect(help).toContain('--all-repos');
    expect(help).toContain('--min-stars <count>');
    expect(help).toContain('--max-stars <count>');
  });

  test('registers agent targeting options for presets and all-repos fallback', () => {
    const program = new Command();
    registerAgentCommand(program);

    const agentCommand = program.commands.find((command) => command.name() === 'agent');
    const help = agentCommand?.helpInformation() ?? '';

    expect(help).toContain('--preset <name>');
    expect(help).toContain('--all-repos');
    expect(help).toContain('--min-stars <count>');
    expect(help).toContain('--max-stars <count>');
  });

  test('parses non-negative integer star counts', () => {
    expect(parseStarCount('0')).toBe(0);
    expect(parseStarCount('125')).toBe(125);
    expect(() => parseStarCount('-1')).toThrow('Expected a non-negative integer.');
    expect(() => parseStarCount('1.5')).toThrow('Expected a non-negative integer.');
  });

  test('registers analyze targeting options for presets', () => {
    const program = new Command();
    registerAnalyzeCommand(program);

    const analyzeCommand = program.commands.find((command) => command.name() === 'analyze');
    const help = analyzeCommand?.helpInformation() ?? '';

    expect(help).toContain('--repo <repository>');
    expect(help).toContain('--preset <name>');
  });
});
