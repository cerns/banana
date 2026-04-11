import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('should load config from environment variables', async () => {
    process.env.BANANA_TOKEN = 'my-secret';
    process.env.BANANA_PORT = '4000';
    process.env.BANANA_HISTORY_MAX = '500';

    const { config } = await import('../src/config.js');
    expect(config.token).toBe('my-secret');
    expect(config.port).toBe(4000);
    expect(config.historyMax).toBe(500);
  });

  it('should use defaults when env vars not set', async () => {
    process.env.BANANA_TOKEN = 'test';
    delete process.env.BANANA_PORT;
    delete process.env.BANANA_HISTORY_MAX;

    const { config } = await import('../src/config.js');
    expect(config.port).toBe(3000);
    expect(config.historyMax).toBe(1000);
  });

  it('should have machinesPersistPath', async () => {
    process.env.BANANA_TOKEN = 'test';
    const { config } = await import('../src/config.js');
    expect(config.machinesPersistPath).toContain('machines.json');
  });

  it('should have persistPath', async () => {
    process.env.BANANA_TOKEN = 'test';
    const { config } = await import('../src/config.js');
    expect(config.persistPath).toContain('sessions.json');
  });

  it('should have hub config defaults', async () => {
    process.env.BANANA_TOKEN = 'test';
    const { config } = await import('../src/config.js');
    expect(config.hubPersistPath).toContain('hub.json');
    expect(config.hubMaxChainDepth).toBe(5);
    expect(config.hubMaxConcurrentJobs).toBe(10);
    expect(config.hubCooldownMs).toBe(10000);
    expect(config.hubMaxTalkRounds).toBe(10);
  });

  it('should have task/doc config defaults', async () => {
    process.env.BANANA_TOKEN = 'test';
    delete process.env.BANANA_TASKS_PATH;
    delete process.env.BANANA_DOCS_PATH;
    delete process.env.BANANA_TASK_CONTEXT_MAX;
    delete process.env.BANANA_DOC_CONTEXT_MAX;
    delete process.env.BANANA_DOC_REVISION_MAX;

    const { config } = await import('../src/config.js');
    expect(config.tasksPersistPath).toContain('tasks.json');
    expect(config.docsPersistPath).toContain('docs.json');
    expect(config.taskContextMax).toBe(8);
    expect(config.docContextMax).toBe(5);
    expect(config.docRevisionMax).toBe(20);
  });

  it('should load task/doc config from env vars', async () => {
    process.env.BANANA_TOKEN = 'test';
    process.env.BANANA_TASK_CONTEXT_MAX = '15';
    process.env.BANANA_DOC_CONTEXT_MAX = '7';
    process.env.BANANA_DOC_REVISION_MAX = '50';

    const { config } = await import('../src/config.js');
    expect(config.taskContextMax).toBe(15);
    expect(config.docContextMax).toBe(7);
    expect(config.docRevisionMax).toBe(50);
  });

  it('should load hub config from env vars', async () => {
    process.env.BANANA_TOKEN = 'test';
    process.env.BANANA_HUB_MAX_DEPTH = '10';
    process.env.BANANA_HUB_MAX_CONCURRENT = '5';
    process.env.BANANA_HUB_COOLDOWN_MS = '5000';

    const { config } = await import('../src/config.js');
    expect(config.hubMaxChainDepth).toBe(10);
    expect(config.hubMaxConcurrentJobs).toBe(5);
    expect(config.hubCooldownMs).toBe(5000);
  });

  it('should default promptCompressEnabled=true', async () => {
    process.env.BANANA_TOKEN = 'test';
    delete process.env.BANANA_PROMPT_COMPRESS;
    const { config } = await import('../src/config.js');
    expect(config.promptCompressEnabled).toBe(true);
  });

  it('should disable promptCompressEnabled when BANANA_PROMPT_COMPRESS=0', async () => {
    process.env.BANANA_TOKEN = 'test';
    process.env.BANANA_PROMPT_COMPRESS = '0';
    const { config } = await import('../src/config.js');
    expect(config.promptCompressEnabled).toBe(false);
  });

  it('should exit if BANANA_TOKEN is missing', async () => {
    delete process.env.BANANA_TOKEN;
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const mockError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await import('../src/config.js');

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
    mockError.mockRestore();
  });
});
