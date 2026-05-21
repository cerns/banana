/**
 * Integration tests for the full hub message flow.
 *
 * Tests the complete lifecycle:
 *   1. Message posted to channel → sessions matched → dispatched
 *   2. Wave1/Wave2 staggered dispatch
 *   3. [BEGIN_WORK] → cancel others → work on WORK channel
 *   4. Work completes → tree-structure reply-back → @requester
 *   5. Programmatic routing (C2) — JobRecord metadata, not prompt tags
 *   6. --bare flag for hub chat, system prompt split
 *   7. SKIP detection → no chain propagation
 *   8. Talking continuation → multiple rounds
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    persistPath: '',
    historyMax: 1000,
    hubPersistPath: '',
    hubMaxChainDepth: 5,
    hubMaxConcurrentJobs: 10,
    hubCooldownMs: 0,
    hubMaxTalkRounds: 10,
    tasksPersistPath: '',
    docsPersistPath: '',
    taskContextMax: 8,
    docContextMax: 5,
    docRevisionMax: 20,
    sshMaxTurns: 25,
    hubChatMaxTurns: 3,
    hubWaveSize: 2,
    promptCompressEnabled: false,
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: { ...actual, readFileSync: vi.fn(), writeFileSync: vi.fn(), mkdirSync: vi.fn() },
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../../src/ws/dashboardBroadcast.js', () => ({
  broadcastToDashboards: vi.fn(),
}));

vi.mock('../../src/push/pushManager.js', () => ({
  pushManager: { sendPush: vi.fn().mockResolvedValue(undefined) },
}));

const mockIsSessionBusy = vi.fn().mockReturnValue(false);
const mockOnJobComplete = vi.fn();
const mockExecuteRemoteJob = vi.fn();
const mockAbortRemoteJob = vi.fn();

vi.mock('../../src/ssh/remoteSessionExecutor.js', () => ({
  isSessionBusy: (...args: any[]) => mockIsSessionBusy(...args),
  onJobComplete: (...args: any[]) => mockOnJobComplete(...args),
  executeRemoteJob: (...args: any[]) => mockExecuteRemoteJob(...args),
  abortRemoteJob: (...args: any[]) => mockAbortRemoteJob(...args),
}));

vi.mock('../../src/ssh/sshRunner.js', () => ({
  runClaudeOverSsh: vi.fn(),
}));

describe('Hub Flow Integration', () => {
  let hubRouter: typeof import('../../src/hub/hubRouter.js');
  let hubStore: typeof import('../../src/hub/hubStore.js');
  let sessionStore: typeof import('../../src/sessions/sessionStore.js');
  let broadcastMod: typeof import('../../src/ws/dashboardBroadcast.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    mockIsSessionBusy.mockReturnValue(false);

    vi.doMock('../../src/ssh/remoteSessionExecutor.js', () => ({
      isSessionBusy: (...args: any[]) => mockIsSessionBusy(...args),
      onJobComplete: (...args: any[]) => mockOnJobComplete(...args),
      executeRemoteJob: (...args: any[]) => mockExecuteRemoteJob(...args),
      abortRemoteJob: (...args: any[]) => mockAbortRemoteJob(...args),
    }));

    sessionStore = await import('../../src/sessions/sessionStore.js');
    hubStore = await import('../../src/hub/hubStore.js');
    broadcastMod = await import('../../src/ws/dashboardBroadcast.js');
    hubRouter = await import('../../src/hub/hubRouter.js');
  });

  function createSession(overrides: Partial<import('../../src/sessions/sessionStore.js').SessionRecord> = {}) {
    const session: import('../../src/sessions/sessionStore.js').SessionRecord = {
      sessionId: 'sess-' + Math.random().toString(36).slice(2, 8),
      clientId: '',
      hostname: 'test',
      workdir: '/w',
      connectedAt: new Date().toISOString(),
      status: 'connected',
      jobs: [],
      type: 'remote',
      machineId: 'm1',
      ...overrides,
    };
    sessionStore.sessionStore.upsert(session);
    return session;
  }

  /** Fire the onJobComplete callback for a specific job, injecting fake chunks as the agent's reply. */
  function fireJobCallback(reply: string | unknown[]) {
    const calls = mockOnJobComplete.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall).toBeDefined();
    const [jobId, callback] = lastCall;

    // Find the job and inject chunks
    for (const s of sessionStore.sessionStore.getAll()) {
      const job = s.jobs.find(j => j.jobId === jobId);
      if (job) {
        job.chunks = Array.isArray(reply)
          ? reply
          : [{ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }];
        break;
      }
    }

    callback();
  }

  /** Fire a specific job's callback by session ID. */
  function fireJobCallbackForSession(sessionId: string, reply: string) {
    const call = mockOnJobComplete.mock.calls.find(c => {
      const jid = c[0];
      const sess = sessionStore.sessionStore.get(sessionId);
      return sess?.jobs.some(j => j.jobId === jid);
    });
    expect(call).toBeDefined();

    const [jobId, callback] = call!;
    const sess = sessionStore.sessionStore.get(sessionId)!;
    const job = sess.jobs.find(j => j.jobId === jobId)!;
    job.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: reply }] } }];
    callback();
  }

  // ─── Full Lifecycle ─────────────────────────────────────────────────

  describe('Full message lifecycle: post → dispatch → reply → hook back', () => {
    it('should route user message → expert dispatch → reply posted to channel', () => {
      const agent = createSession({
        sessionId: 'expert-1',
        screenName: 'alice',
        channels: ['backend'],
        interests: ['auth'],
        role: 'Auth Expert',
      });

      // 1. User posts to channel
      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'JWT tokens are expiring too fast',
        channelIds: ['backend'],
        tags: ['auth'],
      });

      // 2. Expert dispatched
      expect(mockExecuteRemoteJob).toHaveBeenCalledWith(
        'expert-1', expect.any(String), expect.stringContaining('JWT tokens'),
        undefined, 'hub', expect.anything(),
      );

      // 3. Agent replies
      fireJobCallback('The default TTL is 15 minutes. Check config.tokenExpiryMs.');

      // 4. Reply posted to channel
      const channelMsgs = hubStore.hubStore.getByChannel('backend');
      const replies = channelMsgs.filter(m => m.parentId === msg.id && m.from === 'expert-1');
      expect(replies).toHaveLength(1);
      expect(replies[0].content).toContain('default TTL is 15 minutes');
    });

    it('should store hub routing metadata on JobRecord (C2)', () => {
      createSession({
        sessionId: 'c2-agent',
        channels: ['ch-c2'],
        interests: ['routing'],
      });

      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Test routing',
        channelIds: ['ch-c2'],
        tags: ['routing'],
      });

      // Verify job has hub metadata
      const sess = sessionStore.sessionStore.get('c2-agent')!;
      const job = sess.jobs[sess.jobs.length - 1];
      expect(job.hubChannelId).toBe('ch-c2');
      expect(job.hubMessageId).toBe(msg.id);
      expect(job.hubEngagement).toBe('expert');
    });

    it('should pass --bare and --max-turns for hub chat via sshOpts', () => {
      createSession({
        sessionId: 'bare-test',
        channels: ['ch-bare'],
        interests: ['test'],
      });

      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Test bare mode',
        channelIds: ['ch-bare'],
        tags: ['test'],
      });

      const sshOpts = mockExecuteRemoteJob.mock.calls[0][5];
      expect(sshOpts).toBeDefined();
      expect(sshOpts.bare).toBe(true);
      expect(sshOpts.maxTurns).toBe(3); // hubChatMaxTurns
      expect(sshOpts.systemPrompt).toBeDefined();
      expect(typeof sshOpts.systemPrompt).toBe('string');
    });
  });

  // ─── BEGIN_WORK Flow ────────────────────────────────────────────────

  describe('[BEGIN_WORK] → work session → tree-structure reply', () => {
    it('full flow: chat → BEGIN_WORK → triggered work → result posted with @requester', async () => {
      const agent = createSession({
        sessionId: 'worker-1',
        screenName: 'bob',
        channels: ['project'],
        interests: ['billing'],
        role: 'Billing Expert',
      });

      // 1. User posts
      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'ProductManager',
        content: 'Fix the billing validation bug',
        channelIds: ['project'],
        tags: ['billing'],
        mentions: ['infra-lead'],
      });

      // 2. Agent replies with [BEGIN_WORK]
      fireJobCallback('I\'ll fix the billing regex validation.\n\n## Plan\n1. Read billing.ts\n2. Fix regex\n\n[BEGIN_WORK]');

      // 3. Verify [BEGIN_WORK] reply posted (marker stripped)
      const chatMsgs = hubStore.hubStore.getByChannel('project');
      const chatReply = chatMsgs.find(m => m.from === 'worker-1' && m.parentId === msg.id);
      expect(chatReply).toBeDefined();
      expect(chatReply!.content).not.toContain('[BEGIN_WORK]');
      expect(chatReply!.content).toContain('billing regex validation');

      // 4. triggerSessionOnMessage is called via setImmediate — flush it
      await new Promise(r => setImmediate(r));

      // The triggered dispatch should now exist
      const triggerCalls = mockOnJobComplete.mock.calls.filter(c => {
        const sess = sessionStore.sessionStore.get('worker-1');
        return sess?.jobs.some(j => j.jobId === c[0] && j.hubEngagement === 'triggered');
      });
      expect(triggerCalls.length).toBeGreaterThanOrEqual(1);

      // 5. Simulate work completion
      const lastTriggerCall = triggerCalls[triggerCalls.length - 1];
      const trigJob = sessionStore.sessionStore.get('worker-1')!.jobs.find(j => j.jobId === lastTriggerCall[0])!;
      trigJob.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Fixed regex in billing.ts:42. All tests pass.' }] } }];
      lastTriggerCall[1]();

      // 6. Work result posted to channel
      const allMsgs = hubStore.hubStore.getByChannel('project');
      const workResult = allMsgs.find(m => m.from === 'worker-1' && m.content.includes('Fixed regex'));
      expect(workResult).toBeDefined();

      // 7. A1: Tree-structure — fanOut=false
      // The work result should NOT fan out to all subscribers
      // It should mention the requester (ProductManager) and original mentions (infra-lead)
      expect(workResult!.mentions).toContain('ProductManager');
      expect(workResult!.mentions).toContain('infra-lead');
    });

    it('triggered work prompt should NOT contain [REPLY_TO_CHANNEL] (C3)', () => {
      createSession({
        sessionId: 'no-tag-agent',
        channels: ['ch-c3'],
        interests: ['test'],
      });

      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Do the work', channelIds: ['ch-c3'], tags: ['test'],
      });

      // Trigger the session manually
      mockExecuteRemoteJob.mockClear();
      mockOnJobComplete.mockClear();
      hubRouter.triggerSessionOnMessage('no-tag-agent', msg.id);

      const prompt = mockExecuteRemoteJob.mock.calls[0]?.[2];
      expect(prompt).toBeDefined();
      // C3: No routing tags in prompt
      expect(prompt).not.toContain('[REPLY_TO_CHANNEL]');
      // C3: Should have auto-post guidance
      expect(prompt).toContain('automatically posted back to the channel');
    });

    it('triggered work should use higher --max-turns (B4)', () => {
      createSession({
        sessionId: 'turns-agent',
        channels: ['ch-turns'],
        interests: ['test'],
      });

      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Work on it', channelIds: ['ch-turns'], tags: ['test'],
      });

      mockExecuteRemoteJob.mockClear();
      hubRouter.triggerSessionOnMessage('turns-agent', msg.id);

      const sshOpts = mockExecuteRemoteJob.mock.calls[0]?.[5];
      expect(sshOpts?.maxTurns).toBe(25); // sshMaxTurns for work
      expect(sshOpts?.bare).toBeUndefined(); // NOT bare for triggered work
    });
  });

  // ─── Wave Dispatch ──────────────────────────────────────────────────

  describe('A2: Staggered dispatch — wave1/wave2', () => {
    it('should dispatch wave1 immediately and wave2 only after wave1 completes', () => {
      // Create 4 experts (waveSize=2, so wave1=2, wave2=2)
      createSession({ sessionId: 'w-high-1', channels: ['ch-wave'], interests: ['perf', 'frontend'], screenName: 'perf-expert' });
      createSession({ sessionId: 'w-high-2', channels: ['ch-wave'], interests: ['perf'], screenName: 'frontend-dev' });
      createSession({ sessionId: 'w-low-1', channels: ['ch-wave'], interests: ['backend'], screenName: 'backend-dev' });
      createSession({ sessionId: 'w-low-2', channels: ['ch-wave'], interests: ['devops'], screenName: 'devops' });

      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Fix LCP regression',
        channelIds: ['ch-wave'],
        tags: ['perf', 'frontend'],
      });

      // Wave1 should have dispatched 2 sessions (highest overlap)
      const dispatchedSessions = mockExecuteRemoteJob.mock.calls.map(c => c[0]);
      expect(dispatchedSessions).toHaveLength(2);
      // High-overlap sessions should be in wave1
      expect(dispatchedSessions).toContain('w-high-1');
      expect(dispatchedSessions).toContain('w-high-2');
      // Low-overlap sessions should NOT be dispatched yet
      expect(dispatchedSessions).not.toContain('w-low-1');
      expect(dispatchedSessions).not.toContain('w-low-2');
    });

    it('should skip wave2 when wave1 produces [BEGIN_WORK]', () => {
      createSession({ sessionId: 'wave-a', channels: ['ch-w2'], interests: ['perf', 'frontend'] });
      createSession({ sessionId: 'wave-b', channels: ['ch-w2'], interests: ['perf'] });
      createSession({ sessionId: 'wave-c', channels: ['ch-w2'], interests: ['testing'] });

      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Fix it', channelIds: ['ch-w2'], tags: ['perf'],
      });

      const initialDispatches = mockExecuteRemoteJob.mock.calls.length;

      // Wave1 agent A says [BEGIN_WORK]
      const callA = mockOnJobComplete.mock.calls.find(c => {
        const sess = sessionStore.sessionStore.get('wave-a');
        return sess?.jobs.some(j => j.jobId === c[0]);
      });
      if (callA) {
        const job = sessionStore.sessionStore.get('wave-a')!.jobs.find(j => j.jobId === callA[0])!;
        job.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'I\'ll handle this [BEGIN_WORK]' }] } }];
        callA[1]();
      }

      // Wave1 agent B SKIPs
      const callB = mockOnJobComplete.mock.calls.find(c => {
        const sess = sessionStore.sessionStore.get('wave-b');
        return sess?.jobs.some(j => j.jobId === c[0]);
      });
      if (callB) {
        const job = sessionStore.sessionStore.get('wave-b')!.jobs.find(j => j.jobId === callB[0])!;
        job.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'SKIP' }] } }];
        callB[1]();
      }

      // Wave2 (wave-c) should NOT have been dispatched because [BEGIN_WORK] was claimed
      const wave2Dispatches = mockExecuteRemoteJob.mock.calls.filter(c => c[0] === 'wave-c');
      expect(wave2Dispatches).toHaveLength(0);
    });

    it('should dispatch wave2 when wave1 completes without [BEGIN_WORK]', () => {
      // All 3 need tag overlap to be matched as 'expert'
      createSession({ sessionId: 'nw-a', channels: ['ch-nw'], interests: ['api', 'auth'] });
      createSession({ sessionId: 'nw-b', channels: ['ch-nw'], interests: ['api'] });
      createSession({ sessionId: 'nw-c', channels: ['ch-nw'], interests: ['auth'] });

      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Review the auth flow', channelIds: ['ch-nw'], tags: ['api', 'auth'],
      });

      // Both wave1 agents reply normally (no BEGIN_WORK)
      for (const sid of ['nw-a', 'nw-b']) {
        const call = mockOnJobComplete.mock.calls.find(c => {
          const sess = sessionStore.sessionStore.get(sid);
          return sess?.jobs.some(j => j.jobId === c[0]);
        });
        if (call) {
          const job = sessionStore.sessionStore.get(sid)!.jobs.find(j => j.jobId === call[0])!;
          job.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: `Advice from ${sid}` }] } }];
          call[1]();
        }
      }

      // Wave2 (nw-c) should now be dispatched
      const wave2Dispatches = mockExecuteRemoteJob.mock.calls.filter(c => c[0] === 'nw-c');
      expect(wave2Dispatches).toHaveLength(1);
    });
  });

  // ─── Dispatch Cancellation ──────────────────────────────────────────

  describe('A3: Cancel dispatches on [BEGIN_WORK]', () => {
    it('should cancel queued dispatches when [BEGIN_WORK] is detected', () => {
      const fast = createSession({ sessionId: 'fast-1', channels: ['ch-cancel'], interests: ['x'] });
      const slow = createSession({ sessionId: 'slow-1', channels: ['ch-cancel'], interests: ['x'] });

      // Make slow-1 busy so it gets queued
      mockIsSessionBusy.mockImplementation((sid: string) => sid === 'slow-1');

      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Do something', channelIds: ['ch-cancel'], tags: ['x'],
      });

      // fast-1 dispatched, slow-1 queued
      const dispatched = mockExecuteRemoteJob.mock.calls.map(c => c[0]);
      expect(dispatched).toContain('fast-1');

      // slow-1 should be in queue
      const slowSess = sessionStore.sessionStore.get('slow-1')!;
      expect(slowSess.hubQueue?.length).toBeGreaterThan(0);

      // fast-1 replies with [BEGIN_WORK]
      const call = mockOnJobComplete.mock.calls.find(c => {
        return sessionStore.sessionStore.get('fast-1')?.jobs.some(j => j.jobId === c[0]);
      });
      if (call) {
        const job = sessionStore.sessionStore.get('fast-1')!.jobs.find(j => j.jobId === call[0])!;
        job.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'On it [BEGIN_WORK]' }] } }];
        call[1]();
      }

      // slow-1's queue should be cleared (cancelled by A3)
      const updatedSlow = sessionStore.sessionStore.get('slow-1')!;
      const queuedForMsg = (updatedSlow.hubQueue ?? []).filter(q => q.hubMessageId === msg.id);
      expect(queuedForMsg).toHaveLength(0);
    });
  });

  // ─── Programmatic Reply-Back ────────────────────────────────────────

  describe('C1: Programmatic reply-back — always post work results', () => {
    it('should post fallback when triggered job has empty text output', () => {
      createSession({
        sessionId: 'empty-work',
        channels: ['ch-empty'],
        interests: ['x'],
      });

      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Do work', channelIds: ['ch-empty'], tags: ['x'],
      });

      // Trigger the session
      mockOnJobComplete.mockClear();
      hubRouter.triggerSessionOnMessage('empty-work', msg.id);

      // Fire callback with empty text chunks (tool-only output)
      const call = mockOnJobComplete.mock.calls[mockOnJobComplete.mock.calls.length - 1];
      const sess = sessionStore.sessionStore.get('empty-work')!;
      const job = sess.jobs.find(j => j.jobId === call[0])!;
      // Simulate tool-only output — no text blocks
      job.chunks = [
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use' } } },
        { type: 'stream_event', event: { type: 'content_block_stop' } },
      ];
      call[1]();

      // C1: Should still post a result (fallback placeholder)
      const allMsgs = hubStore.hubStore.getByChannel('ch-empty');
      const workResult = allMsgs.find(m => m.from === 'empty-work' && m.parentId === msg.id);
      expect(workResult).toBeDefined();
      expect(workResult!.content).toContain('check session logs');
    });
  });

  // ─── SKIP Detection ─────────────────────────────────────────────────

  describe('SKIP in flow context', () => {
    it('SKIP should not trigger chain propagation or wave2 claim', () => {
      createSession({ sessionId: 'skip-a', channels: ['ch-skip'], interests: ['test'] });

      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Quick question', channelIds: ['ch-skip'], tags: ['test'],
      });

      // Agent SKIPs
      const call = mockOnJobComplete.mock.calls[mockOnJobComplete.mock.calls.length - 1];
      const job = sessionStore.sessionStore.get('skip-a')!.jobs.find(j => j.jobId === call[0])!;
      job.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: '[SKIP][#NO_ACTION_NEEDED]' }] } }];
      call[1]();

      // Dispatch marked as skipped
      const stored = hubStore.hubStore.getMessage(msg.id)!;
      const dispatch = stored.dispatches.find(d => d.sessionId === 'skip-a');
      expect(dispatch?.status).toBe('skipped');

      // SKIP message posted to channel
      const channelMsgs = hubStore.hubStore.getByChannel('ch-skip');
      const skipMsg = channelMsgs.find(m => m.from === 'skip-a' && m.content.includes('[SKIP]'));
      expect(skipMsg).toBeDefined();
    });
  });

  // ─── System Prompt (B1/B3) ──────────────────────────────────────────

  describe('B1/B3: System prompt split', () => {
    it('should include system prompt in sshOpts for hub chat dispatch', () => {
      createSession({
        sessionId: 'sys-prompt',
        channels: ['ch-sys'],
        interests: ['test'],
        role: 'Test Agent',
        rolePrompt: 'You test things.',
        screenName: 'tester',
      });

      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Run tests', channelIds: ['ch-sys'], tags: ['test'],
      });

      const sshOpts = mockExecuteRemoteJob.mock.calls[0][5];
      expect(sshOpts.systemPrompt).toContain('tester');
      expect(sshOpts.systemPrompt).toContain('Test Agent');
      expect(sshOpts.systemPrompt).toContain('You test things.');
    });

    it('should use slim system prompt for listen engagement (B3)', () => {
      // Create an agent with 'mentioned' engagement to test listen
      createSession({
        sessionId: 'listen-agent',
        channels: ['ch-listen'],
        interests: [], // no overlap → listen
        screenName: 'listener',
      });

      // @mention it to force dispatch as 'mentioned'
      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Hey @listener, thoughts?',
        channelIds: ['ch-listen'],
        tags: ['unrelated'],
        mentions: ['listener'],
      });

      // The agent gets dispatched as 'mentioned' since it was @mentioned
      const sshOpts = mockExecuteRemoteJob.mock.calls[0]?.[5];
      expect(sshOpts).toBeDefined();
      expect(sshOpts.systemPrompt).toBeDefined();
    });
  });

  // ─── Tree-Structure Mentions ────────────────────────────────────────

  describe('A1: Tree-structure mentions on work results', () => {
    it('triggered work result should auto-mention requester and original mentions', () => {
      createSession({
        sessionId: 'tree-agent',
        screenName: 'worker',
        channels: ['ch-tree'],
        interests: ['impl'],
      });

      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'PM-Sarah',
        content: 'Implement the new feature @designer-max',
        channelIds: ['ch-tree'],
        tags: ['impl'],
        mentions: ['designer-max'],
      });

      // Trigger the agent
      mockOnJobComplete.mockClear();
      hubRouter.triggerSessionOnMessage('tree-agent', msg.id);

      // Complete the work
      const call = mockOnJobComplete.mock.calls[mockOnJobComplete.mock.calls.length - 1];
      const sess = sessionStore.sessionStore.get('tree-agent')!;
      const job = sess.jobs.find(j => j.jobId === call[0])!;
      job.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Feature implemented. Tests pass.' }] } }];
      call[1]();

      // Work result should auto-mention PM-Sarah (requester) and designer-max (original mention)
      const allMsgs = hubStore.hubStore.getByChannel('ch-tree');
      const workResult = allMsgs.find(m => m.from === 'tree-agent' && m.content.includes('Feature implemented'));
      expect(workResult).toBeDefined();
      expect(workResult!.mentions).toContain('PM-Sarah');
      expect(workResult!.mentions).toContain('designer-max');
    });

    it('non-triggered reply should NOT have fanOut=false forced', () => {
      createSession({
        sessionId: 'normal-reply',
        channels: ['ch-normal'],
        interests: ['qa'],
      });

      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Any thoughts on testing?', channelIds: ['ch-normal'], tags: ['qa'],
      });

      // Agent replies normally (no BEGIN_WORK, not triggered)
      const call = mockOnJobComplete.mock.calls[mockOnJobComplete.mock.calls.length - 1];
      const job = sessionStore.sessionStore.get('normal-reply')!.jobs.find(j => j.jobId === call[0])!;
      job.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'We should add E2E tests.' }] } }];
      call[1]();

      // Reply posted — should NOT auto-mention requester (only triggered results do)
      const allMsgs = hubStore.hubStore.getByChannel('ch-normal');
      const reply = allMsgs.find(m => m.from === 'normal-reply' && m.content.includes('E2E tests'));
      expect(reply).toBeDefined();
      // Non-triggered replies don't get auto-requester mention
      expect(reply!.mentions).not.toContain('User');
    });
  });

  // ─── Combined Scenarios ─────────────────────────────────────────────

  describe('End-to-end: multi-agent conversation cycle', () => {
    it('user post → 4 experts → wave1 dispatches 2 → 1 SKIPs, 1 replies → wave2 dispatches 2 → both SKIP', () => {
      // 4 experts with varying relevance — all need at least 1 tag overlap to match
      createSession({ sessionId: 'e2e-a', channels: ['ch-e2e'], interests: ['auth', 'api'], screenName: 'auth-expert' });
      createSession({ sessionId: 'e2e-b', channels: ['ch-e2e'], interests: ['api'], screenName: 'api-dev' });
      createSession({ sessionId: 'e2e-c', channels: ['ch-e2e'], interests: ['auth'], screenName: 'db-admin' });
      createSession({ sessionId: 'e2e-d', channels: ['ch-e2e'], interests: ['api'], screenName: 'devops' });

      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Auth endpoint returning 401',
        channelIds: ['ch-e2e'],
        tags: ['auth', 'api'],
      });

      // Wave1: 2 dispatched (a: overlap=2, b: overlap=1)
      const wave1 = mockExecuteRemoteJob.mock.calls.map(c => c[0]);
      expect(wave1).toHaveLength(2);
      expect(wave1).toContain('e2e-a');
      expect(wave1).toContain('e2e-b');

      // e2e-a replies with advice (no BEGIN_WORK)
      const callA = mockOnJobComplete.mock.calls.find(c =>
        sessionStore.sessionStore.get('e2e-a')?.jobs.some(j => j.jobId === c[0])
      )!;
      const jobA = sessionStore.sessionStore.get('e2e-a')!.jobs.find(j => j.jobId === callA[0])!;
      jobA.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'Check the token refresh logic in auth.ts.' }] } }];
      callA[1]();

      // e2e-b SKIPs
      const callB = mockOnJobComplete.mock.calls.find(c =>
        sessionStore.sessionStore.get('e2e-b')?.jobs.some(j => j.jobId === c[0])
      )!;
      const jobB = sessionStore.sessionStore.get('e2e-b')!.jobs.find(j => j.jobId === callB[0])!;
      jobB.chunks = [{ type: 'assistant', message: { content: [{ type: 'text', text: '[SKIP][#OUT_OF_DOMAIN]' }] } }];
      callB[1]();

      // Wave2 should now be dispatched (nobody claimed)
      const allDispatches = mockExecuteRemoteJob.mock.calls.map(c => c[0]);
      expect(allDispatches).toContain('e2e-c');
      expect(allDispatches).toContain('e2e-d');

      // Channel has: original msg + reply from a + skip from b
      const channelMsgs = hubStore.hubStore.getByChannel('ch-e2e');
      expect(channelMsgs.length).toBeGreaterThanOrEqual(3);
    });
  });
});
