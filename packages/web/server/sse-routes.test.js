import { describe, expect, it, vi } from 'bun:test';

import { NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS, registerNotificationRoutes } from './lib/notifications/routes.js';
import { registerScheduledTaskRoutes } from './lib/scheduled-tasks/routes.js';

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(path, handler) {
        routes.set(`GET ${path}`, handler);
      },
      post(path, handler) {
        routes.set(`POST ${path}`, handler);
      },
      put(path, handler) {
        routes.set(`PUT ${path}`, handler);
      },
      patch(path, handler) {
        routes.set(`PATCH ${path}`, handler);
      },
      delete(path, handler) {
        routes.set(`DELETE ${path}`, handler);
      },
    },
    getRoute(method, path) {
      return routes.get(`${method} ${path}`);
    },
  };
};

const createMockRequest = () => {
  const listeners = new Map();

  return {
    headers: {},
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    emit(event) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
  };
};

const createMockResponse = () => {
  const headers = new Map();
  const listeners = new Map();
  let statusCode = 200;
  let body = '';
  let flushed = false;
  let bodyFlushCount = 0;

  return {
    on(event, handler) {
      listeners.set(event, handler);
      return this;
    },
    emit(event) {
      const handler = listeners.get(event);
      if (typeof handler === 'function') {
        handler();
      }
    },
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    flushHeaders() {
      flushed = true;
    },
    flush() {
      bodyFlushCount += 1;
    },
    write(chunk) {
      body += String(chunk);
      return true;
    },
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body += JSON.stringify(payload);
      return this;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
    get flushed() {
      return flushed;
    },
    get bodyFlushCount() {
      return bodyFlushCount;
    },
  };
};

describe('local SSE routes', () => {
  it('serves notification SSE with nginx-safe headers', async () => {
    vi.useFakeTimers();
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();

    try {
      registerNotificationRoutes(app, {
        uiAuthController: {
          ensureSessionToken: async () => 'ui-token',
        },
        getUiSessionTokenFromRequest: () => 'ui-token',
        getUiNotificationClients: () => clients,
        writeSseEvent(res, payload) {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        },
      });

      const handler = getRoute('GET', '/api/notifications/stream');
      const req = createMockRequest();
      const res = createMockResponse();

      await handler(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.getHeader('content-type')).toContain('text/event-stream');
      expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
      expect(res.getHeader('connection')).toBe('keep-alive');
      expect(res.getHeader('x-accel-buffering')).toBe('no');
      expect(res.flushed).toBe(true);
      expect(res.body).toContain('openchamber:notification-stream-ready');
      expect(clients.has(res)).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      expect(res.bodyFlushCount).toBe(1);

      vi.advanceTimersByTime(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
      expect(res.body).toContain(':heartbeat\n\n');
      expect(res.bodyFlushCount).toBe(2);

      res.emit('error');
      expect(clients.has(res)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);

      const bodyAfterClose = res.body;
      vi.advanceTimersByTime(NOTIFICATION_SSE_HEARTBEAT_INTERVAL_MS);
      expect(res.body).toBe(bodyAfterClose);
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits authenticated plugin notifications through the existing broadcaster', async () => {
    const { app, getRoute } = createRouteRegistry();
    const emitDesktopNotification = vi.fn(() => true);
    const broadcastUiNotification = vi.fn();
    const getUiSessionTokenFromRequest = vi.fn(() => 'cookie-token');

    registerNotificationRoutes(app, {
      uiAuthController: {
        ensureSessionToken: async () => 'cookie-token',
      },
      getUiSessionTokenFromRequest,
      readSettingsFromDiskMigrated: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'focus' }),
      emitDesktopNotification,
      broadcastUiNotification,
    });

    const handler = getRoute('POST', '/api/notifications/emit');
    const req = { body: { title: ' Build done ', body: ' Ready ', variant: 'success', tag: ' plugin-1 ', kind: ' plugin ' }, headers: {} };
    const res = createMockResponse();

    await handler(req, res);

    const payload = {
      title: 'Build done',
      body: 'Ready',
      variant: 'success',
      tag: 'plugin-1',
      kind: 'plugin',
      sessionId: undefined,
      directory: undefined,
      requireHidden: true,
    };
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, delivered: true, desktopNotificationDelivered: true });
    expect(getUiSessionTokenFromRequest).toHaveBeenCalledWith(req);
    expect(emitDesktopNotification).toHaveBeenCalledWith(payload);
    expect(broadcastUiNotification).toHaveBeenCalledWith(payload, { desktopNotificationDelivered: true });
  });

  it('rejects plugin notification emission that would create an anonymous UI session', async () => {
    const { app, getRoute } = createRouteRegistry();
    const setHeader = vi.fn();

    registerNotificationRoutes(app, {
      uiAuthController: {
        ensureSessionToken: async (_req, res) => {
          res.setHeader('Set-Cookie', 'openchamber=issued');
          return 'issued-token';
        },
      },
      getUiSessionTokenFromRequest: () => null,
      readSettingsFromDiskMigrated: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always' }),
      emitDesktopNotification: vi.fn(),
      broadcastUiNotification: vi.fn(),
    });

    const handler = getRoute('POST', '/api/notifications/emit');
    const res = createMockResponse();
    res.setHeader = setHeader;

    await handler({ body: { title: 'Nope' }, headers: {} }, res);

    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({ error: 'UI session missing' });
    expect(setHeader).not.toHaveBeenCalledWith('Set-Cookie', expect.any(String));
  });

  it('accepts the managed agent tool token for plugin notification emission', async () => {
    const { app, getRoute } = createRouteRegistry();
    const emitDesktopNotification = vi.fn(() => false);
    const broadcastUiNotification = vi.fn();

    registerNotificationRoutes(app, {
      uiAuthController: {
        ensureSessionToken: vi.fn(),
      },
      getUiSessionTokenFromRequest: () => null,
      readSettingsFromDiskMigrated: async () => ({ nativeNotificationsEnabled: true, notificationMode: 'always' }),
      emitDesktopNotification,
      broadcastUiNotification,
      isAgentToolRequestAuthorized: () => true,
    });

    const handler = getRoute('POST', '/api/notifications/emit');
    const res = createMockResponse();

    await handler({ body: { title: 'From plugin' }, headers: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, delivered: true, desktopNotificationDelivered: false });
    expect(broadcastUiNotification).toHaveBeenCalledWith(expect.objectContaining({ title: 'From plugin', kind: 'plugin' }), { desktopNotificationDelivered: false });
  });

  it('does not emit plugin notifications while native notifications are disabled', async () => {
    const { app, getRoute } = createRouteRegistry();
    const emitDesktopNotification = vi.fn();
    const broadcastUiNotification = vi.fn();
    const getUiSessionTokenFromRequest = vi.fn(() => 'cookie-token');

    registerNotificationRoutes(app, {
      uiAuthController: {
        ensureSessionToken: async () => 'cookie-token',
      },
      getUiSessionTokenFromRequest,
      readSettingsFromDiskMigrated: async () => ({ nativeNotificationsEnabled: false, notificationMode: 'always' }),
      emitDesktopNotification,
      broadcastUiNotification,
    });

    const handler = getRoute('POST', '/api/notifications/emit');
    const res = createMockResponse();

    await handler({ body: { title: 'Muted' }, headers: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, delivered: false, skipped: 'nativeNotificationsDisabled' });
    expect(emitDesktopNotification).not.toHaveBeenCalled();
    expect(broadcastUiNotification).not.toHaveBeenCalled();
  });

  it('serves OpenChamber SSE with nginx-safe headers', () => {
    const { app, getRoute } = createRouteRegistry();
    const clients = new Set();

    registerScheduledTaskRoutes(app, {
      getOpenChamberEventClients: () => clients,
      writeSseEvent(res, payload) {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
    });

    const handler = getRoute('GET', '/api/openchamber/events');
    const req = createMockRequest();
    const res = createMockResponse();

    handler(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.getHeader('content-type')).toContain('text/event-stream');
    expect(res.getHeader('cache-control')).toBe('no-cache, no-transform');
    expect(res.getHeader('connection')).toBe('keep-alive');
    expect(res.getHeader('x-accel-buffering')).toBe('no');
    expect(res.flushed).toBe(true);
    expect(res.body).toContain('openchamber:event-stream-ready');
    expect(clients.has(res)).toBe(true);

    req.emit('close');
    expect(clients.has(res)).toBe(false);
  });
});
