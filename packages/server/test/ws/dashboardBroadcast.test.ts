import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock ws module
vi.mock('ws', () => ({
  WebSocket: { OPEN: 1 },
}));

describe('dashboardBroadcast', () => {
  let mod: typeof import('../../src/ws/dashboardBroadcast.js');

  beforeEach(async () => {
    vi.resetModules();
    mod = await import('../../src/ws/dashboardBroadcast.js');
  });

  function mockWs(open = true) {
    return { readyState: open ? 1 : 3, send: vi.fn() } as any;
  }

  it('should broadcast to all connected dashboards', () => {
    const ws1 = mockWs();
    const ws2 = mockWs();
    mod.dashboardConnections.add(ws1);
    mod.dashboardConnections.add(ws2);

    mod.broadcastToDashboards({ type: 'TEST', data: 123 });

    expect(ws1.send).toHaveBeenCalledWith(JSON.stringify({ type: 'TEST', data: 123 }));
    expect(ws2.send).toHaveBeenCalledWith(JSON.stringify({ type: 'TEST', data: 123 }));
  });

  it('should skip closed connections', () => {
    const wsOpen = mockWs(true);
    const wsClosed = mockWs(false);
    mod.dashboardConnections.add(wsOpen);
    mod.dashboardConnections.add(wsClosed);

    mod.broadcastToDashboards({ test: true });

    expect(wsOpen.send).toHaveBeenCalled();
    expect(wsClosed.send).not.toHaveBeenCalled();
  });

  it('should handle empty set', () => {
    expect(() => mod.broadcastToDashboards({ test: true })).not.toThrow();
  });
});
