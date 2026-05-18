import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/config.js', () => ({
  config: {
    persistPath: '',
    historyMax: 1000,
    hubPersistPath: '',
    hubMaxChainDepth: 5,
    hubMaxConcurrentJobs: 3,
    hubCooldownMs: 0, // disable cooldown for tests
    hubMaxTalkRounds: 10,
    tasksPersistPath: '',
    docsPersistPath: '',
    taskContextMax: 8,
    docContextMax: 5,
    docRevisionMax: 20,
  },
}));

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(),
      writeFileSync: vi.fn(),
      mkdirSync: vi.fn(),
    },
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock('../../src/ws/dashboardBroadcast.js', () => ({
  broadcastToDashboards: vi.fn(),
}));

vi.mock('../../src/push/pushManager.js', () => ({
  pushManager: {
    sendPush: vi.fn().mockResolvedValue(undefined),
  },
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

describe('hubRouter', () => {
  let hubRouter: typeof import('../../src/hub/hubRouter.js');
  let hubStore: typeof import('../../src/hub/hubStore.js');
  let sessionStore: typeof import('../../src/sessions/sessionStore.js');
  let broadcastMod: typeof import('../../src/ws/dashboardBroadcast.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    // Reset mock return values (clearAllMocks only clears call history)
    mockIsSessionBusy.mockReturnValue(false);

    // Re-apply dynamic mocks after resetModules
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

  describe('postHubMessage', () => {
    it('should create message and channel on-demand', () => {
      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Hello world',
        channelIds: ['new-channel'],
      });

      expect(msg.id).toBeDefined();
      expect(msg.content).toBe('Hello world');
      expect(msg.channelId).toBe('new-channel');
      expect(msg.status).toBe('complete'); // no matching sessions → immediately complete
      expect(hubStore.hubStore.getChannel('new-channel')).toBeDefined();
    });

    it('should broadcast HUB_MESSAGE to dashboards', () => {
      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'test',
        channelIds: ['ch1'],
      });

      expect(broadcastMod.broadcastToDashboards).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'DASHBOARD_EVENT',
          event: 'HUB_MESSAGE',
        })
      );
    });

    it('should set depth and parentId', () => {
      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'reply',
        channelIds: ['ch1'],
        parentId: 'parent-id',
        depth: 2,
      });

      expect(msg.parentId).toBe('parent-id');
      expect(msg.depth).toBe(2);
    });

    it('should include tags and mentions', () => {
      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'test',
        channelIds: ['ch1'],
        tags: ['backend', 'auth'],
        mentions: ['alice'],
      });

      expect(msg.tags).toEqual(['backend', 'auth']);
      expect(msg.mentions).toEqual(['alice']);
    });

    it('should not dispatch to sender (self-exclusion)', () => {
      createSession({
        sessionId: 'sender',
        channels: ['ch1'],
        interests: ['all'],
      });

      hubRouter.postHubMessage({
        from: 'sender',
        fromName: 'Sender',
        content: 'test',
        channelIds: ['ch1'],
        tags: ['all'],
      });

      const calls = mockExecuteRemoteJob.mock.calls;
      const senderCalls = calls.filter((c: any) => c[0] === 'sender');
      expect(senderCalls).toHaveLength(0);
    });

    it('should not dispatch to local sessions', () => {
      createSession({
        sessionId: 'local-s',
        type: 'local',
        channels: ['ch1'],
        interests: ['all'],
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'test',
        channelIds: ['ch1'],
        tags: ['all'],
      });

      const calls = mockExecuteRemoteJob.mock.calls;
      const localCalls = calls.filter((c: any) => c[0] === 'local-s');
      expect(localCalls).toHaveLength(0);
    });

    it('should not dispatch to sessions without machineId', () => {
      createSession({
        sessionId: 'no-machine',
        machineId: undefined,
        channels: ['ch1'],
        interests: ['all'],
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'test',
        channelIds: ['ch1'],
        tags: ['all'],
      });

      const calls = mockExecuteRemoteJob.mock.calls;
      const noMachineCalls = calls.filter((c: any) => c[0] === 'no-machine');
      expect(noMachineCalls).toHaveLength(0);
    });
  });

  describe('session matching', () => {
    it('should dispatch to sessions subscribed to channel with matching interests', () => {
      createSession({
        sessionId: 'backend-1',
        channels: ['project'],
        interests: ['backend'],
        role: 'Backend Dev',
        screenName: 'backend-alice',
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Build JWT auth',
        channelIds: ['project'],
        tags: ['backend'],
      });

      expect(mockExecuteRemoteJob).toHaveBeenCalledWith(
        'backend-1',
        expect.any(String),
        expect.stringContaining('Build JWT auth'),
        undefined,
        'hub',
      );
    });

    it('should still dispatch to subscribed sessions without interest overlap (war-room)', () => {
      createSession({
        sessionId: 'qa-1',
        channels: ['project'],
        interests: ['testing'],
        role: 'QA',
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Build JWT auth',
        channelIds: ['project'],
        tags: ['backend'],
      });

      // War-room: subscribed sessions always receive, even without interest overlap
      const calls = mockExecuteRemoteJob.mock.calls;
      const qaCall = calls.find((c: any) => c[0] === 'qa-1');
      expect(qaCall).toBeDefined();
      // Off-area sessions get the "war-room listening" guidance
      expect(qaCall![2]).toContain('war-room');
    });

    it('should give expert-level guidance to sessions with matching interests', () => {
      createSession({
        sessionId: 'expert-1',
        channels: ['project'],
        interests: ['backend'],
        role: 'Backend Dev',
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Build JWT auth',
        channelIds: ['project'],
        tags: ['backend'],
      });

      const calls = mockExecuteRemoteJob.mock.calls;
      const expertCall = calls.find((c: any) => c[0] === 'expert-1');
      expect(expertCall).toBeDefined();
      expect(expertCall![2]).toContain('area of expertise');
    });

    it('should dispatch to subscribed sessions when no tags provided', () => {
      createSession({
        sessionId: 'general-1',
        channels: ['project'],
        interests: ['backend'],
        role: 'Dev',
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Stand-up time',
        channelIds: ['project'],
        tags: [],
      });

      expect(mockExecuteRemoteJob).toHaveBeenCalledWith(
        'general-1',
        expect.any(String),
        expect.stringContaining('Stand-up time'),
        undefined,
        'hub',
      );
    });
  });

  describe('@mention resolution', () => {
    it('should resolve screen names to session IDs', () => {
      createSession({
        sessionId: 'ceo-sess',
        screenName: 'ceo-1',
        channels: [],
        interests: [],
      });

      const sid = hubRouter.resolveScreenName('ceo-1');
      expect(sid).toBe('ceo-sess');
    });

    it('should return undefined for unknown screen name', () => {
      expect(hubRouter.resolveScreenName('unknown')).toBeUndefined();
    });

    it('should dispatch to @mentioned session even without channel subscription', () => {
      createSession({
        sessionId: 'mentioned',
        screenName: 'alice',
        channels: [],
        interests: [],
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Hey @alice, what do you think?',
        channelIds: ['ch1'],
        mentions: ['alice'],
      });

      expect(mockExecuteRemoteJob).toHaveBeenCalledWith(
        'mentioned',
        expect.any(String),
        expect.any(String),
        undefined,
        'hub',
      );
    });
  });

  describe('busy session queueing', () => {
    it('should queue when session is busy', () => {
      mockIsSessionBusy.mockReturnValue(true);

      createSession({
        sessionId: 'busy-sess',
        channels: ['ch1'],
        interests: ['all'],
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Do work',
        channelIds: ['ch1'],
        tags: ['all'],
      });

      // Should NOT execute (session is busy)
      const calls = mockExecuteRemoteJob.mock.calls;
      const busyCalls = calls.filter((c: any) => c[0] === 'busy-sess');
      expect(busyCalls).toHaveLength(0);

      // Should have queued message
      const updated = sessionStore.sessionStore.get('busy-sess')!;
      expect(updated.hubQueue).toBeDefined();
      expect(updated.hubQueue!.length).toBeGreaterThan(0);
    });
  });

  describe('processQueue', () => {
    it('should process next queued message', () => {
      mockIsSessionBusy.mockReturnValue(false);

      createSession({
        sessionId: 'queue-sess',
        channels: ['ch1'],
        interests: ['all'],
      });

      // Add a message to the hub
      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Queued work',
        channelIds: ['ch1'],
        tags: ['all'],
      });

      // Clear previous calls from postHubMessage dispatch
      mockExecuteRemoteJob.mockClear();

      // Manually queue it for the session
      sessionStore.sessionStore.updateMeta('queue-sess', {
        hubQueue: [{ hubMessageId: msg.id, queuedAt: new Date().toISOString() }],
      });

      hubRouter.processQueue('queue-sess');

      expect(mockExecuteRemoteJob).toHaveBeenCalled();
    });

    it('should still dispatch in war-room mode even if another session acted', () => {
      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Work',
        channelIds: ['ch1'],
      });

      // Another session already acted on this message
      hubStore.hubStore.addDispatch(msg.id, {
        sessionId: 'other-sess',
        jobId: 'j1',
        status: 'acted',
      });

      createSession({
        sessionId: 'skip-sess',
        channels: ['ch1'],
      });

      sessionStore.sessionStore.updateMeta('skip-sess', {
        hubQueue: [{ hubMessageId: msg.id, queuedAt: new Date().toISOString() }],
      });

      mockExecuteRemoteJob.mockClear();
      hubRouter.processQueue('skip-sess');

      // War-room: every subscriber responds, so skip-sess still dispatches
      const calls = mockExecuteRemoteJob.mock.calls;
      const skipCalls = calls.filter((c: any) => c[0] === 'skip-sess');
      expect(skipCalls).toHaveLength(1);
    });

    it('should not re-dispatch if this session already acted', () => {
      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Work',
        channelIds: ['ch1'],
      });

      createSession({
        sessionId: 'done-sess',
        channels: ['ch1'],
      });

      // Mark this session as already having acted
      hubStore.hubStore.addDispatch(msg.id, {
        sessionId: 'done-sess',
        jobId: 'j1',
        status: 'acted',
      });

      sessionStore.sessionStore.updateMeta('done-sess', {
        hubQueue: [{ hubMessageId: msg.id, queuedAt: new Date().toISOString() }],
      });

      mockExecuteRemoteJob.mockClear();
      hubRouter.processQueue('done-sess');

      const calls = mockExecuteRemoteJob.mock.calls;
      const doneCalls = calls.filter((c: any) => c[0] === 'done-sess');
      expect(doneCalls).toHaveLength(0);
    });

    it('should no-op for empty queue', () => {
      createSession({ sessionId: 'empty-q' });
      expect(() => hubRouter.processQueue('empty-q')).not.toThrow();
    });

    it('should no-op for non-existent session', () => {
      expect(() => hubRouter.processQueue('nope')).not.toThrow();
    });
  });

  describe('prompt building', () => {
    it('should include role and rolePrompt in dispatch prompt', () => {
      createSession({
        sessionId: 'role-sess',
        channels: ['ch1'],
        interests: ['all'],
        role: 'Backend Dev',
        rolePrompt: 'You are a backend developer.',
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Build something',
        channelIds: ['ch1'],
        tags: ['all'],
      });

      expect(mockExecuteRemoteJob).toHaveBeenCalledWith(
        'role-sess',
        expect.any(String),
        expect.stringContaining('Backend Dev'),
        undefined,
        'hub',
      );

      const prompt = mockExecuteRemoteJob.mock.calls[0][2];
      expect(prompt).toContain('You are a backend developer.');
      expect(prompt).toContain('Build something');
      expect(prompt).toContain('SKIP');
      // Regular dispatches also include REPLY_TO_CHANNEL metadata
      expect(prompt).toContain('[REPLY_TO_CHANNEL][#ch1]');
    });
  });

  describe('triggerSessionOnMessage', () => {
    it('should dispatch the named session against the message with triggered guidance', () => {
      createSession({
        sessionId: 'trig-sess',
        channels: ['ch1'],
        role: 'Backend Dev',
      });

      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Build the auth service',
        channelIds: ['ch1'],
      });

      mockExecuteRemoteJob.mockClear();
      const result = hubRouter.triggerSessionOnMessage('trig-sess', msg.id);
      expect(result.ok).toBe(true);
      expect(result.status).toBe('dispatched');

      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'trig-sess');
      expect(calls).toHaveLength(1);
      const prompt = calls[0][2];
      expect(prompt).toContain('Build the auth service');
      expect(prompt).toContain('EXPLICITLY TRIGGERED');
      // Triggered prompt MUST NOT contain the regular "respond with exactly SKIP" fallback
      expect(prompt).not.toContain('respond with exactly');
    });

    it('should include REPLY_TO_CHANNEL metadata in the dispatch prompt', () => {
      createSession({ sessionId: 'reply-to-sess', channels: ['ch1'] });
      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User', content: 'Do stuff', channelIds: ['ch1'],
      });

      mockExecuteRemoteJob.mockClear();
      hubRouter.triggerSessionOnMessage('reply-to-sess', msg.id);

      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'reply-to-sess');
      expect(calls).toHaveLength(1);
      const prompt = calls[0][2];
      expect(prompt).toContain('[REPLY_TO_CHANNEL][#ch1]');
      expect(prompt).toContain(`[%${msg.id}]`);
    });

    it('should include CHANNEL_REPLY guidance in triggered prompt', () => {
      createSession({ sessionId: 'cr-hint-sess', channels: ['ch1'] });
      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User', content: 'Work on it', channelIds: ['ch1'],
      });

      mockExecuteRemoteJob.mockClear();
      hubRouter.triggerSessionOnMessage('cr-hint-sess', msg.id);

      const prompt = mockExecuteRemoteJob.mock.calls.find((c: any) => c[0] === 'cr-hint-sess')![2];
      expect(prompt).toContain('[CHANNEL_REPLY]');
    });

    it('should queue the trigger when the session is busy', () => {
      createSession({ sessionId: 'busy-trig', channels: ['ch1'] });
      // Post a message while NOT busy so dispatch goes through normally
      const msg = hubRouter.postHubMessage({
        from: 'user', fromName: 'User', content: 'Work', channelIds: ['ch1'],
      });

      // Now flip to busy and trigger — should queue with 'triggered' engagement
      mockIsSessionBusy.mockReturnValue(true);
      // Clear any existing queue from prior dispatch path
      sessionStore.sessionStore.updateMeta('busy-trig', { hubQueue: [] });

      const result = hubRouter.triggerSessionOnMessage('busy-trig', msg.id);
      expect(result.ok).toBe(true);
      expect(result.status).toBe('queued');

      const queued = sessionStore.sessionStore.get('busy-trig')!.hubQueue;
      expect(queued).toBeDefined();
      expect(queued!.length).toBe(1);
      expect(queued![0].engagement).toBe('triggered');
    });

    it('should error on missing session', () => {
      const result = hubRouter.triggerSessionOnMessage('nope', 'fake-id');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('session');
    });

    it('should error on missing message', () => {
      createSession({ sessionId: 'has-sess' });
      const result = hubRouter.triggerSessionOnMessage('has-sess', 'fake-id');
      expect(result.ok).toBe(false);
      expect(result.error).toContain('message');
    });
  });

  describe('dispatch tracking', () => {
    it('should add running dispatch record when dispatching', () => {
      createSession({
        sessionId: 'tracked',
        channels: ['ch1'],
        interests: ['all'],
      });

      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'test',
        channelIds: ['ch1'],
        tags: ['all'],
      });

      const stored = hubStore.hubStore.getMessage(msg.id)!;
      expect(stored.dispatches.length).toBeGreaterThan(0);
      const dispatch = stored.dispatches.find(d => d.sessionId === 'tracked');
      expect(dispatch).toBeDefined();
      expect(dispatch!.status).toBe('running');
    });

    it('should register onJobComplete callback', () => {
      createSession({
        sessionId: 'callback-sess',
        channels: ['ch1'],
        interests: ['all'],
      });

      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'test',
        channelIds: ['ch1'],
        tags: ['all'],
      });

      expect(mockOnJobComplete).toHaveBeenCalled();
    });
  });

  describe('SKIP detection', () => {
    // Helper: dispatch a session, then fire its job-complete callback with a
    // synthetic agent reply so we can observe whether a skip message is
    // posted (with [SKIP][#REASON] tag) and dispatch marked "skipped".
    function runWithReply(replyText: string | unknown[]): {
      msgId: string;
      dispatchStatus: string | undefined;
      replyPosted: boolean;
      postedContent: string | undefined;
    } {
      createSession({ sessionId: 'skip-detect', channels: ['ch1'] });

      const msg = hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Original prompt',
        channelIds: ['ch1'],
      });

      // Find the registered onJobComplete callback for this session's job
      const allCalls = mockOnJobComplete.mock.calls;
      const lastCall = allCalls[allCalls.length - 1];
      expect(lastCall).toBeDefined();
      const callback = lastCall[1];

      // Fake the job's chunks to contain the agent's reply text or raw chunks
      const session = sessionStore.sessionStore.get('skip-detect')!;
      const job = session.jobs[session.jobs.length - 1];
      job.chunks = Array.isArray(replyText)
        ? replyText
        : [{ type: 'assistant', message: { content: [{ type: 'text', text: replyText }] } }];

      // Count messages in channel BEFORE callback fires
      const before = hubStore.hubStore.getByChannel('ch1').length;

      callback();

      const afterMsgs = hubStore.hubStore.getByChannel('ch1');
      const stored = hubStore.hubStore.getMessage(msg.id)!;
      const dispatch = stored.dispatches.find(d => d.sessionId === 'skip-detect');
      const newMsgs = afterMsgs.slice(before);
      const lastPosted = newMsgs.length > 0 ? newMsgs[newMsgs.length - 1] : undefined;

      return {
        msgId: msg.id,
        dispatchStatus: dispatch?.status,
        replyPosted: newMsgs.length > 0,
        postedContent: lastPosted?.content,
      };
    }

    it('should mark plain "SKIP" as skipped and post [SKIP][#LEGACY] to channel', () => {
      const r = runWithReply('SKIP');
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toContain('[SKIP][#LEGACY]');
    });

    it('should mark "SKIPSKIP" as skipped and post to channel', () => {
      const r = runWithReply('SKIPSKIP');
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toContain('[SKIP][#LEGACY]');
    });

    it('should mark "SKIP." as skipped and post to channel', () => {
      const r = runWithReply('SKIP.');
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toContain('[SKIP]');
    });

    it('should mark "skip - not relevant" as skipped with legacy reason', () => {
      const r = runWithReply('skip - not relevant');
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toContain('[SKIP][#LEGACY]');
      expect(r.postedContent).toContain('not relevant');
    });

    it('should mark empty reply as skipped', () => {
      const r = runWithReply('   ');
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toContain('[SKIP][#EMPTY]');
    });

    it('should parse structured [SKIP][#OUT_OF_DOMAIN] marker', () => {
      const r = runWithReply('[SKIP][#OUT_OF_DOMAIN]');
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toBe('[SKIP][#OUT_OF_DOMAIN]');
    });

    it('should parse structured [SKIP][#NO_ACTION_NEEDED] with explanation', () => {
      const r = runWithReply('[SKIP][#NO_ACTION_NEEDED] Already handled by dev-alice.');
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toBe('[SKIP][#NO_ACTION_NEEDED] Already handled by dev-alice.');
    });

    it('should NOT suppress real content that mentions skipping', () => {
      const r = runWithReply('Skipping the build step is risky because tests need to run first.');
      expect(r.dispatchStatus).toBe('acted');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).not.toContain('[SKIP]');
    });

    it('should NOT suppress short imperative starting with "Skip" (no separator)', () => {
      const r = runWithReply('Skip the cache and rebuild from source for accurate timing.');
      expect(r.dispatchStatus).toBe('acted');
      expect(r.replyPosted).toBe(true);
    });

    it('should NOT suppress long complex reply that begins with "skip"', () => {
      const longReply = [
        'Skip cache invalidation for now, here is the full plan:',
        '',
        '1. Run lint',
        '2. Build the bundle',
        '3. Run unit tests with --coverage',
        '4. Run the perf suite (this is the slow one)',
        '5. Compare against baseline',
        '6. Post results to #perf channel',
        '',
        'I will execute steps 1–4 in parallel where possible.',
      ].join('\n');
      const r = runWithReply(longReply);
      expect(r.dispatchStatus).toBe('acted');
      expect(r.replyPosted).toBe(true);
    });

    it('should NOT suppress multi-paragraph reply', () => {
      const r = runWithReply('skip the noise.\n\nHere is what I found in the logs.');
      expect(r.dispatchStatus).toBe('acted');
      expect(r.replyPosted).toBe(true);
    });

    it('should mark "skip: nothing to add" as skipped (legacy reason form)', () => {
      const r = runWithReply('skip: nothing to add here');
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toContain('[SKIP][#LEGACY]');
    });

    it('should mark "SKIP — out of scope" as skipped (em-dash reason)', () => {
      const r = runWithReply('SKIP — out of scope for me');
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toContain('[SKIP]');
    });

    it('should mark double SKIP via stream_event text_deltas as skipped', () => {
      const r = runWithReply([
        { type: 'system', subtype: 'init', session_id: 'cs-1' },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n\nSKIP' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '\n\nSKIP' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash' } },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"comm' } },
        },
        { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
        {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed', resetsAt: 1775829600, rateLimitType: 'five_hour' },
          uuid: 'aa0d76c5-46eb-474e-9174-5d37320dea50',
          session_id: 'a00e9fa2-7169-4309-b057-831e37d051df',
        },
      ]);
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toContain('[SKIP]');
    });

    it('should mark double SKIP via assistant snapshot as skipped', () => {
      const r = runWithReply([
        {
          type: 'assistant',
          message: {
            content: [
              { type: 'text', text: '\n\nSKIP' },
              { type: 'text', text: '\n\nSKIP' },
              { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} },
            ],
          },
        },
        { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
      ]);
      expect(r.dispatchStatus).toBe('skipped');
      expect(r.replyPosted).toBe(true);
      expect(r.postedContent).toContain('[SKIP]');
    });
  });

  describe('self-trigger marker', () => {
    function dispatchAndReply(replyText: string) {
      createSession({
        sessionId: 'self-trig-sess',
        channels: ['ch1'],
        screenName: 'self-trig',
      });
      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Original',
        channelIds: ['ch1'],
      });
      const allCalls = mockOnJobComplete.mock.calls;
      const callback = allCalls[allCalls.length - 1][1];
      const session = sessionStore.sessionStore.get('self-trig-sess')!;
      const job = session.jobs[session.jobs.length - 1];
      job.chunks = [
        { type: 'assistant', message: { content: [{ type: 'text', text: replyText }] } },
      ];
      mockExecuteRemoteJob.mockClear();
      callback();
    }

    it('should auto-trigger session when reply contains [BEGIN_WORK]', async () => {
      dispatchAndReply('I will handle the auth task. [BEGIN_WORK]');
      // setImmediate fires after current microtask queue
      await new Promise(resolve => setImmediate(resolve));

      // The self-trigger should result in a new executeRemoteJob call for this session
      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'self-trig-sess');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const triggeredPrompt = calls[calls.length - 1][2];
      expect(triggeredPrompt).toContain('EXPLICITLY TRIGGERED');
    });

    it('should NOT auto-trigger when no marker is present', async () => {
      dispatchAndReply('I think we should consider option A or B.');
      await new Promise(resolve => setImmediate(resolve));

      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'self-trig-sess');
      expect(calls).toHaveLength(0);
    });

    it('should strip [BEGIN_WORK] marker from posted message', async () => {
      dispatchAndReply('Plan: refactor auth module. [BEGIN_WORK]');
      await new Promise(resolve => setImmediate(resolve));

      const channelMsgs = hubStore.hubStore.getByChannel('ch1');
      const reply = channelMsgs.find(m => m.from === 'self-trig-sess');
      expect(reply).toBeDefined();
      expect(reply!.content).not.toContain('[BEGIN_WORK]');
      expect(reply!.content).toContain('Plan: refactor auth module');
    });
  });

  describe('talking-continuation marker', () => {
    function setupTalker() {
      createSession({
        sessionId: 'talk-sess',
        channels: ['talk-ch'],
        screenName: 'talker',
      });
      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'Original prompt',
        channelIds: ['talk-ch'],
      });
      // Return the original message for parent/depth assertions
      const channelMsgs = hubStore.hubStore.getByChannel('talk-ch');
      return channelMsgs.find(m => m.from === 'user')!;
    }

    /** Drives the most recent dispatch's completion callback with `replyText`. */
    function fireLastCallback(replyText: string) {
      const allCalls = mockOnJobComplete.mock.calls;
      const callback = allCalls[allCalls.length - 1][1];
      const session = sessionStore.sessionStore.get('talk-sess')!;
      const job = session.jobs[session.jobs.length - 1];
      job.chunks = [
        { type: 'assistant', message: { content: [{ type: 'text', text: replyText }] } },
      ];
      callback();
    }

    it('re-dispatches the same session when reply contains [IM_TALKING]', async () => {
      setupTalker();
      mockExecuteRemoteJob.mockClear();
      fireLastCallback('First beat. [IM_TALKING]');
      await new Promise(resolve => setImmediate(resolve));

      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'talk-sess');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const continuationPrompt = calls[calls.length - 1][2];
      expect(continuationPrompt).toContain('CONTINUING YOUR TRAIN OF THOUGHT');
      expect(continuationPrompt).toContain('round 1');
    });

    it('re-dispatches on [IM_THINKING] (alias)', async () => {
      setupTalker();
      mockExecuteRemoteJob.mockClear();
      fireLastCallback('Hmm let me think... [IM_THINKING]');
      await new Promise(resolve => setImmediate(resolve));

      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'talk-sess');
      expect(calls.length).toBeGreaterThanOrEqual(1);
    });

    it('strips [IM_TALKING] / [IM_THINKING] from posted reply', async () => {
      setupTalker();
      fireLastCallback('First beat. [IM_TALKING]');
      await new Promise(resolve => setImmediate(resolve));

      const channelMsgs = hubStore.hubStore.getByChannel('talk-ch');
      const reply = channelMsgs.find(m => m.from === 'talk-sess');
      expect(reply).toBeDefined();
      expect(reply!.content).not.toContain('[IM_TALKING]');
      expect(reply!.content).not.toContain('[IM_THINKING]');
      expect(reply!.content).toContain('First beat');
    });

    it('continuation reply is posted as a sibling (same parentId/depth)', async () => {
      const original = setupTalker();
      // Round 1 reply (with marker → triggers continuation)
      fireLastCallback('First beat. [IM_TALKING]');
      await new Promise(resolve => setImmediate(resolve));
      // Round 2 reply (no marker → loop ends)
      fireLastCallback('Final beat — done thinking.');
      await new Promise(resolve => setImmediate(resolve));

      const channelMsgs = hubStore.hubStore.getByChannel('talk-ch');
      const replies = channelMsgs.filter(m => m.from === 'talk-sess');
      expect(replies.length).toBe(2);

      // Both replies should be siblings: same parentId (= original) and same depth (=1)
      expect(replies[0].parentId).toBe(original.id);
      expect(replies[1].parentId).toBe(original.id);
      expect(replies[0].depth).toBe(1);
      expect(replies[1].depth).toBe(1);
    });

    it('loop terminates when reply has no marker', async () => {
      setupTalker();
      fireLastCallback('First beat. [IM_TALKING]');
      await new Promise(resolve => setImmediate(resolve));
      mockExecuteRemoteJob.mockClear();
      // Round 2 — no marker
      fireLastCallback('Done.');
      await new Promise(resolve => setImmediate(resolve));

      // No further dispatch should fire after the marker-free reply
      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'talk-sess');
      expect(calls).toHaveLength(0);
    });

    it('SKIP during continuation posts a [SKIP] message and stops talking', async () => {
      setupTalker();
      fireLastCallback('First beat. [IM_TALKING]');
      await new Promise(resolve => setImmediate(resolve));
      // Round 2 SKIPs
      fireLastCallback('SKIP');
      await new Promise(resolve => setImmediate(resolve));

      const channelMsgs = hubStore.hubStore.getByChannel('talk-ch');
      const replies = channelMsgs.filter(m => m.from === 'talk-sess');
      // First beat + visible SKIP message
      expect(replies.length).toBe(2);
      expect(replies[0].content).toContain('First beat');
      expect(replies[1].content).toContain('[SKIP]');
    });

    it('does NOT loop if reply also contains [BEGIN_WORK] (self-trigger wins)', async () => {
      setupTalker();
      mockExecuteRemoteJob.mockClear();
      fireLastCallback('I will do this. [IM_TALKING] [BEGIN_WORK]');
      await new Promise(resolve => setImmediate(resolve));

      // Self-trigger path uses triggerSessionOnMessage which dispatches with
      // 'triggered' engagement; the resulting prompt should mention that, NOT
      // the talking continuation header.
      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'talk-sess');
      expect(calls.length).toBe(1);
      const prompt = calls[0][2];
      expect(prompt).toContain('EXPLICITLY TRIGGERED');
      expect(prompt).not.toContain('CONTINUING YOUR TRAIN OF THOUGHT');
    });

    it('hard-caps continuation rounds to prevent infinite loops', async () => {
      setupTalker();
      mockExecuteRemoteJob.mockClear();
      // Default cap from mocked config is 10. Fire 12 rounds, all with marker.
      for (let i = 0; i < 12; i++) {
        fireLastCallback(`Beat ${i}. [IM_TALKING]`);
        await new Promise(resolve => setImmediate(resolve));
      }
      // First fire = original reply post + round 1 dispatch.
      // Subsequent fires = each continuation completes + (maybe) next dispatch.
      // We expect at most `cap` continuation dispatches total (10) — i.e. the
      // 11th + 12th attempts should NOT have triggered another executeRemoteJob.
      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'talk-sess');
      expect(calls.length).toBeLessThanOrEqual(10);
    });

    it('includes TALKING hint in dispatch prompt context', () => {
      createSession({
        sessionId: 'hint-sess',
        channels: ['hint-ch'],
      });
      hubRouter.postHubMessage({
        from: 'user',
        fromName: 'User',
        content: 'hi',
        channelIds: ['hint-ch'],
      });
      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'hint-sess');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const prompt = calls[0][2];
      expect(prompt).toContain('IM_TALKING');
      expect(prompt).toContain('Holding the floor');
    });
  });

  // ── Channel context: tasks + docs injection ────────────────────────────
  describe('channel context — tasks/docs', () => {
    it('includes Open Tasks section in dispatch prompt', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      taskStore._resetForTests();
      taskStore.createTask('ctx-ch', {
        title: 'Fix LCP > 4s',
        status: 'in_progress',
        assignee: 'qa-bob',
        tags: ['perf'],
      }, 'u');

      createSession({
        sessionId: 'ctx-sess',
        channels: ['ctx-ch'],
        interests: ['all'],
      });

      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'How is it going?',
        channelIds: ['ctx-ch'],
        tags: ['all'],
      });

      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'ctx-sess');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const prompt = calls[0][2];
      expect(prompt).toContain('Open bJira');
      expect(prompt).toContain('bJIRA-1');
      expect(prompt).toContain('Fix LCP');
      expect(prompt).toContain('qa-bob');
    });

    it('includes Recent Docs section in dispatch prompt', async () => {
      const { docStore } = await import('../../src/hub/docStore.js');
      docStore._resetForTests();
      docStore.createDoc('doc-ch', 'Auth Spec', '# Auth\nJWT', 'alice', ['auth']);

      createSession({
        sessionId: 'doc-sess',
        channels: ['doc-ch'],
        interests: ['all'],
      });

      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'recap?',
        channelIds: ['doc-ch'],
        tags: ['all'],
      });

      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'doc-sess');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const prompt = calls[0][2];
      expect(prompt).toContain('Recent bConfluence');
      expect(prompt).toContain('bCONF-1');
      expect(prompt).toContain('Auth Spec');
    });

    it('shows Tagged for you when interests overlap a task tag', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      taskStore._resetForTests();
      taskStore.createTask('tag-ch', {
        title: 'Cache JWT',
        tags: ['auth', 'backend'],
      }, 'u');

      createSession({
        sessionId: 'tag-sess',
        channels: ['tag-ch'],
        interests: ['auth'],
      });

      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Stuff',
        channelIds: ['tag-ch'],
        tags: ['auth'],
      });

      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'tag-sess');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const prompt = calls[0][2];
      expect(prompt).toContain('Tagged for you');
    });

    it('queued dispatch sees task added after enqueue (no stale cache)', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      taskStore._resetForTests();

      createSession({
        sessionId: 'stale-sess',
        channels: ['stale-ch'],
        interests: ['all'],
      });

      // First dispatch — session becomes "busy" before second post
      mockIsSessionBusy.mockReturnValue(false);
      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'first',
        channelIds: ['stale-ch'],
        tags: ['all'],
      });

      // Now session is busy — second post queues
      mockIsSessionBusy.mockReturnValue(true);
      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'second',
        channelIds: ['stale-ch'],
        tags: ['all'],
      });

      // Add a NEW task after the second post is enqueued
      taskStore.createTask('stale-ch', { title: 'Late Task' }, 'u');

      // Drain the queue: session becomes idle and processQueue runs
      mockIsSessionBusy.mockReturnValue(false);
      mockExecuteRemoteJob.mockClear();
      hubRouter.processQueue('stale-sess');

      const calls = mockExecuteRemoteJob.mock.calls.filter((c: any) => c[0] === 'stale-sess');
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const prompt = calls[calls.length - 1][2];
      // The freshly-added task must show up — proves context isn't cached
      expect(prompt).toContain('Late Task');
    });
  });

  // ── Marker extraction in onSessionJobComplete ──────────────────────────
  describe('artifact marker extraction', () => {
    function createReplyingSession(reply: string): { sessionId: string } {
      createSession({
        sessionId: 'mark-sess',
        channels: ['mark-ch'],
        screenName: 'mark-screen',
      });
      hubRouter.postHubMessage({
        from: 'user', fromName: 'User',
        content: 'Initial',
        channelIds: ['mark-ch'],
      });
      const allCalls = mockOnJobComplete.mock.calls;
      const callback = allCalls[allCalls.length - 1][1];
      const session = sessionStore.sessionStore.get('mark-sess')!;
      const job = session.jobs[session.jobs.length - 1];
      job.chunks = [
        { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } },
      ];
      mockExecuteRemoteJob.mockClear();
      callback();
      return { sessionId: 'mark-sess' };
    }

    it('bJIRA_CREATE marker creates a task and strips marker from posted content', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      taskStore._resetForTests();

      createReplyingSession(
        `Sure, I'll add this.\n\n[bJIRA_CREATE title="Caching Plan" tags=perf priority=high]\nUse Redis with 60s TTL.\n[/bJIRA_CREATE]\n\nDone.`,
      );
      await new Promise(resolve => setImmediate(resolve));

      const tasks = taskStore.getByChannel('mark-ch');
      expect(tasks).toHaveLength(1);
      expect(tasks[0].title).toBe('Caching Plan');
      expect(tasks[0].priority).toBe('high');
      expect(tasks[0].tags).toContain('perf');

      const channelMsgs = hubStore.hubStore.getByChannel('mark-ch');
      const reply = channelMsgs.find(m => m.from === 'mark-sess');
      expect(reply).toBeDefined();
      expect(reply!.content).not.toContain('bJIRA_CREATE');
      expect(reply!.content).toContain("I'll add this");
      expect(reply!.content).toContain('Done.');
    });

    it('bJIRA_UPDATE marker updates a task and strips marker', async () => {
      const { taskStore } = await import('../../src/hub/taskStore.js');
      taskStore._resetForTests();
      const t = taskStore.createTask('mark-ch', { title: 'Existing' }, 'u');

      createReplyingSession(`Marking it done. [bJIRA_UPDATE id=${t.id} status=done]`);
      await new Promise(resolve => setImmediate(resolve));

      const updated = taskStore.getTask(t.id)!;
      expect(updated.status).toBe('done');

      const channelMsgs = hubStore.hubStore.getByChannel('mark-ch');
      const reply = channelMsgs.find(m => m.from === 'mark-sess');
      expect(reply).toBeDefined();
      expect(reply!.content).not.toContain('bJIRA_UPDATE');
      expect(reply!.content).toContain('Marking it done.');
    });

    it('bCONF_WRITE marker creates a doc and strips marker', async () => {
      const { docStore } = await import('../../src/hub/docStore.js');
      docStore._resetForTests();

      createReplyingSession(
        `Wrote the spec.\n\n[bCONF_WRITE title="Perf Plan" tags=perf]\n# Perf\nLighthouse > 90\n[/bCONF_WRITE]`,
      );
      await new Promise(resolve => setImmediate(resolve));

      const docs = docStore.getByChannel('mark-ch');
      expect(docs).toHaveLength(1);
      expect(docs[0].title).toBe('Perf Plan');
      expect(docs[0].body).toContain('Lighthouse');
      expect(docs[0].version).toBe(1);

      const channelMsgs = hubStore.hubStore.getByChannel('mark-ch');
      const reply = channelMsgs.find(m => m.from === 'mark-sess');
      expect(reply!.content).not.toContain('bCONF_WRITE');
    });

    it('bCONF_APPEND marker appends and bumps version', async () => {
      const { docStore } = await import('../../src/hub/docStore.js');
      docStore._resetForTests();
      const d = docStore.createDoc('mark-ch', 'Plan', 'orig body', 'u');

      createReplyingSession(
        `Updated.\n\n[bCONF_APPEND id=${d.id}]\n## Update\nshipped\n[/bCONF_APPEND]`,
      );
      await new Promise(resolve => setImmediate(resolve));

      const updated = docStore.getDoc(d.id)!;
      expect(updated.version).toBe(2);
      expect(updated.body).toContain('orig body');
      expect(updated.body).toContain('## Update');
      expect(updated.history).toHaveLength(1);
    });

    it('[CHANNEL_REPLY] marker controls what gets posted to channel', () => {
      createReplyingSession(
        `Editing templates...\nRunning tests...\n\n[CHANNEL_REPLY]\nShipped GA4 fix — commit 16631b0. All tests pass.\n[/CHANNEL_REPLY]\n\nDone.`,
      );

      const channelMsgs = hubStore.hubStore.getByChannel('mark-ch');
      const reply = channelMsgs.find(m => m.from === 'mark-sess');
      expect(reply).toBeDefined();
      // Only the CHANNEL_REPLY content should appear, not the narration
      expect(reply!.content).toBe('Shipped GA4 fix — commit 16631b0. All tests pass.');
      expect(reply!.content).not.toContain('Editing templates');
      expect(reply!.content).not.toContain('Done.');
    });

    it('[CHANNEL_REPLY] absent → full text posted (existing behavior)', () => {
      createReplyingSession('All narration text goes to channel.');

      const channelMsgs = hubStore.hubStore.getByChannel('mark-ch');
      const reply = channelMsgs.find(m => m.from === 'mark-sess');
      expect(reply).toBeDefined();
      expect(reply!.content).toBe('All narration text goes to channel.');
    });
  });

  describe('extractTextFromChunks', () => {
    it('should prefer stream_event deltas over assistant snapshots to avoid duplication', () => {
      const chunks = [
        // Stream deltas (incremental)
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: ' world' } } },
        // Assistant snapshot (complete) — should be ignored when deltas exist
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
      ];
      const text = hubRouter.extractTextFromChunks(chunks);
      expect(text).toBe('Hello world');
    });

    it('should fall back to assistant snapshot when no stream deltas exist', () => {
      const chunks = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Only snapshot' }] } },
      ];
      const text = hubRouter.extractTextFromChunks(chunks);
      expect(text).toBe('Only snapshot');
    });

    it('should fall back to result.result when no text chunks exist', () => {
      const chunks = [
        { type: 'result', result: 'fallback text' },
      ];
      const text = hubRouter.extractTextFromChunks(chunks);
      expect(text).toBe('fallback text');
    });

    it('should return empty string for empty chunks', () => {
      expect(hubRouter.extractTextFromChunks([])).toBe('');
    });

    it('should NOT duplicate when both stream_event and assistant are present', () => {
      // This is the exact scenario that caused the bug: --include-partial-messages
      // emits both stream deltas and assistant snapshots
      const chunks = [
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Create ' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Jira ticket' } } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Create Jira ticket' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Create Jira ticket' }] } },
        { type: 'result', result: 'Create Jira ticket' },
      ];
      const text = hubRouter.extractTextFromChunks(chunks);
      expect(text).toBe('Create Jira ticket');
    });

    it('should NOT duplicate with cumulative assistant snapshots (no stream deltas)', () => {
      // When stream deltas are absent (e.g. some CLI versions), assistant
      // snapshots are used. Each snapshot is cumulative — contains the FULL
      // text up to that point. Only the LAST one should be used.
      const chunks = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world. Done.' }] } },
      ];
      const text = hubRouter.extractTextFromChunks(chunks);
      expect(text).toBe('Hello world. Done.');
    });

    it('should handle assistant snapshot with multiple text blocks (tool use interleaved)', () => {
      // After tool use, the assistant snapshot has multiple text blocks:
      // [text, tool_use, text]. We need all text blocks from the LAST snapshot.
      const chunks = [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Checking...' }] } },
        { type: 'assistant', message: { content: [
          { type: 'text', text: 'Checking...' },
          { type: 'tool_use', id: 'tool1', name: 'bash', input: {} },
        ] } },
        { type: 'assistant', message: { content: [
          { type: 'text', text: 'Checking...' },
          { type: 'tool_use', id: 'tool1', name: 'bash', input: {} },
          { type: 'text', text: 'All good. [CHANNEL_REPLY]Done.[/CHANNEL_REPLY]' },
        ] } },
      ];
      const text = hubRouter.extractTextFromChunks(chunks);
      expect(text).toBe('Checking...All good. [CHANNEL_REPLY]Done.[/CHANNEL_REPLY]');
      expect(text).not.toContain('Checking...Checking...');
    });

    it('should skip tool results when skipToolOutput is true', () => {
      const chunks = [
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Here is the plan:\n' } } },
        { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ls -la' } } },
        { type: 'stream_event', event: { type: 'content_block_stop' } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '[tool result] file1.txt\n' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done!\n' } } },
      ];
      const text = hubRouter.extractTextFromChunks(chunks, { skipToolOutput: true });
      expect(text).toBe('Here is the plan:\nDone!\n');
    });

    it('should include tool results when skipToolOutput is false', () => {
      const chunks = [
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Response\n' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '[tool result] output\n' } } },
      ];
      const text = hubRouter.extractTextFromChunks(chunks);
      expect(text).toBe('Response\n[tool result] output\n');
    });

    it('should skip thinking_delta when skipToolOutput is true', () => {
      const chunks = [
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', text: 'Let me think about this...\n' } } },
        { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Here is my answer.\n' } } },
      ];
      const text = hubRouter.extractTextFromChunks(chunks, { skipToolOutput: true });
      expect(text).toBe('Here is my answer.\n');
    });
  });
});
