import assert from "node:assert";
import {
	DELETE,
	GET,
	MiniflareDurableObject,
	MiniflareDurableObjectCf,
	MiniflareDurableObjectEnv,
	POST,
	PUT,
	RouteHandler,
	SharedBindings,
	TimerHandle,
} from "miniflare:shared";
import type { Fetcher } from "@cloudflare/workers-types/experimental";

interface BrowserSessionEnv extends MiniflareDurableObjectEnv {
	[SharedBindings.MAYBE_SERVICE_LOOPBACK]: Fetcher;
}

interface Env {
	[SharedBindings.MAYBE_SERVICE_LOOPBACK]: Fetcher;
	BrowserSession: DurableObjectNamespace;
}

export type SessionInfo = {
	wsEndpoint: string;
	sessionId: string;
	startTime: number;
	connectionId?: string;
	connectionStartTime?: number;
};

function isClosed(ws: WebSocket | undefined): boolean {
	return !ws || ws.readyState === WebSocket.CLOSED;
}

function chromeBaseUrl(wsEndpoint: string): string {
	const u = new URL(wsEndpoint.replace("ws://", "http://"));
	return `http://${u.host}`;
}

// Reserved codes 1005 (No Status Received) and 1006 (Abnormal Closure) are
// valid in CloseEvent but throw InvalidAccessError when passed to .close().
function forwardClose(target?: WebSocket, e?: CloseEvent) {
	if (!target) {
		return;
	}
	if (!e?.code || e?.code === 1005 || e?.code === 1006) {
		target.close();
	} else {
		target.close(e.code, e.reason);
	}
}

export class BrowserSession extends MiniflareDurableObject<BrowserSessionEnv> {
	sessionInfo?: SessionInfo;
	chromeWs?: WebSocket;
	legacyServerWs?: WebSocket;
	wss: Array<{ chrome: WebSocket; server: WebSocket }> = [];
	#statusTimeout: TimerHandle | undefined;

	// --- Internal routes (called by module handler, not user-facing) ---

	@POST("/session-info")
	setSessionInfoRoute: RouteHandler = async (req) => {
		this.sessionInfo = await req.json();
		// Establish a persistent WebSocket to Chrome's DevTools endpoint.
		// This serves as the health indicator for the session and is reused
		// by the legacy chunked-framing client (/v1/connectDevtools).
		const wsUrl = this.sessionInfo.wsEndpoint.replace("ws://", "http://");
		const resp = await fetch(wsUrl, { headers: { Upgrade: "websocket" } });
		assert(resp.webSocket !== null, "Expected a WebSocket response");
		this.chromeWs = resp.webSocket;
		this.chromeWs.accept();
		this.#scheduleStatusCheck();
		return new Response(null, { status: 204 });
	};

	@GET("/session-info")
	getSessionInfoRoute: RouteHandler = async () => {
		if (isClosed(this.chromeWs)) {
			this.closeSession();
		}
		if (!this.sessionInfo) {
			return new Response(null, { status: 204 });
		}
		return Response.json(this.sessionInfo);
	};

	@GET("/v1/devtools/browser/:sessionId/json/version")
	jsonVersion: RouteHandler = async () => {
		return this.#proxyJsonRequest("/json/version");
	};

	@GET("/v1/devtools/browser/:sessionId/json/list")
	jsonList: RouteHandler = async () => {
		return this.#proxyJsonRequest("/json/list");
	};

	@GET("/v1/devtools/browser/:sessionId/json")
	jsonAlias: RouteHandler = async () => {
		return this.#proxyJsonRequest("/json/list");
	};

	@GET("/v1/devtools/browser/:sessionId/json/protocol")
	jsonProtocol: RouteHandler = async () => {
		return this.#proxyJsonRequest("/json/protocol");
	};

	@PUT("/v1/devtools/browser/:sessionId/json/new")
	jsonNew: RouteHandler = async (_req, _params, url) => {
		return this.#proxyJsonRequest(
			`/json/new?${new URLSearchParams({ url: url.searchParams.get("url") ?? "" })}`,
			"PUT"
		);
	};

	@GET("/v1/devtools/browser/:sessionId/json/activate/:targetId")
	jsonActivate: RouteHandler<{ targetId: string }> = async (_req, params) => {
		return this.#proxyJsonRequest(`/json/activate/${params?.targetId}`);
	};

	@GET("/v1/devtools/browser/:sessionId/json/close/:targetId")
	jsonClose: RouteHandler<{ targetId: string }> = async (_req, params) => {
		return this.#proxyJsonRequest(`/json/close/${params?.targetId}`);
	};

	@GET("/v1/devtools/browser/:sessionId/page/:pageId")
	pageWebSocket: RouteHandler<{ pageId: string }> = async (_req, params) => {
		if (!this.sessionInfo) {
			return Response.json({ error: "Browser not found" }, { status: 404 });
		}
		return this.#proxyRawWebSocket(
			`${chromeBaseUrl(this.sessionInfo.wsEndpoint).replace("http://", "ws://")}/devtools/page/${params?.pageId}`
		);
	};

	@DELETE("/v1/devtools/browser/:sessionId")
	closeBrowser: RouteHandler = async () => {
		// Browser.close CDP doesn't reliably kill Chrome, so we kill via loopback
		// instead. The DO returns immediately so it stays idle while the
		// module-level binding worker waits for Chrome to fully exit.
		if (this.sessionInfo) {
			const closeUrl = new URL("http://localhost/browser/close");
			closeUrl.searchParams.set("sessionId", this.sessionInfo.sessionId);
			void this.env[SharedBindings.MAYBE_SERVICE_LOOPBACK].fetch(closeUrl, {
				method: "POST",
			});
		}
		return Response.json({ status: "closed" });
	};

	@GET("/v1/devtools/session/:sessionId")
	sessionDetail: RouteHandler = async () => {
		if (!this.sessionInfo) {
			return Response.json({ error: "Session not found" }, { status: 404 });
		}
		return Response.json({
			sessionId: this.sessionInfo.sessionId,
			startTime: this.sessionInfo.startTime,
			connectionId: this.sessionInfo.connectionId,
			connectionStartTime: this.sessionInfo.connectionStartTime,
		});
	};

	@GET("/v1/devtools/browser/:sessionId")
	connect: RouteHandler = async (req) => {
		const url = new URL(req.url);

		if (url.searchParams.has("raw")) {
			return await this.connectWebSocket();
		}

		// Legacy path only supports one client at a time
		if (isClosed(this.legacyServerWs)) {
			forwardClose(this.legacyServerWs);
			this.legacyServerWs = undefined;
		} else if (this.legacyServerWs) {
			throw new Error("WebSocket already initialized");
		}
		return await this.connectWebSocketLegacy();
	};

	connectWebSocket = async () => {
		assert(
			this.sessionInfo !== undefined,
			"sessionInfo must be set before connecting"
		);

		const wsUrl = this.sessionInfo.wsEndpoint.replace("ws://", "http://");
		const resp = await this.#proxyRawWebSocket(wsUrl);

		this.sessionInfo.connectionId = crypto.randomUUID();
		this.sessionInfo.connectionStartTime = Date.now();

		return new Response(null, {
			status: resp.status,
			webSocket: resp.webSocket,
			headers: { "cf-browser-session-id": this.name },
		});
	};

	connectWebSocketLegacy = async () => {
		assert(
			this.sessionInfo !== undefined,
			"sessionInfo must be set before connecting"
		);
		assert(
			this.chromeWs !== undefined,
			"chromeWs must be established before connecting"
		);

		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		server.accept();

		this.chromeWs.addEventListener("message", (m) => {
			const string = new TextEncoder().encode(m.data as string);
			const data = new Uint8Array(string.length + 4);
			const view = new DataView(data.buffer);
			view.setUint32(0, string.length, true);
			data.set(string, 4);
			server.send(data);
		});

		server.addEventListener("message", (m) => {
			this.chromeWs?.send(
				new TextDecoder().decode((m.data as ArrayBuffer).slice(4))
			);
		});
		server.addEventListener("close", (e) => {
			this.closeWebSockets(e);
		});
		this.chromeWs.addEventListener("close", (e) => {
			this.closeSession(e);
		});
		this.legacyServerWs = server;
		this.sessionInfo.connectionId = crypto.randomUUID();
		this.sessionInfo.connectionStartTime = Date.now();

		return new Response(null, {
			status: 101,
			webSocket: client,
			headers: { "cf-browser-session-id": this.name },
		});
	};

	closeWebSockets(e?: CloseEvent) {
		forwardClose(this.legacyServerWs, e);
		for (const { chrome, server } of this.wss) {
			forwardClose(chrome, e);
			forwardClose(server, e);
		}
		this.legacyServerWs = undefined;
		this.wss = [];
		if (this.sessionInfo) {
			this.sessionInfo.connectionId = undefined;
			this.sessionInfo.connectionStartTime = undefined;
		}
	}

	closeSession(e?: CloseEvent) {
		if (this.#statusTimeout !== undefined) {
			this.timers.clearTimeout(this.#statusTimeout);
			this.#statusTimeout = undefined;
		}
		this.closeWebSockets(e);
		forwardClose(this.chromeWs, e);
		this.chromeWs = undefined;
	}

	async #proxyRawWebSocket(targetWsUrl: string): Promise<Response> {
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		server.accept();

		const response = await fetch(targetWsUrl.replace("ws://", "http://"), {
			headers: { Upgrade: "websocket" },
		});

		assert(response.webSocket !== null, "Expected a WebSocket response");
		const chrome = response.webSocket;
		chrome.accept();

		const pair = { chrome, server };
		this.wss.push(pair);

		chrome.addEventListener("message", (m) => server.send(m.data as string));
		server.addEventListener("message", (m) => chrome.send(m.data as string));
		server.addEventListener("close", (e) => {
			forwardClose(chrome, e);
			forwardClose(server, e);
			this.wss = this.wss.filter((p) => p !== pair);
		});
		chrome.addEventListener("close", (e) => {
			forwardClose(server, e);
			forwardClose(chrome, e);
			this.wss = this.wss.filter((p) => p !== pair);
		});

		return new Response(null, { status: 101, webSocket: client });
	}

	async #proxyJsonRequest(
		chromePath: string,
		method = "GET"
	): Promise<Response> {
		if (!this.sessionInfo) {
			return Response.json({ error: "Browser not found" }, { status: 404 });
		}
		const resp = await fetch(
			`${chromeBaseUrl(this.sessionInfo.wsEndpoint)}${chromePath}`,
			{ method }
		);
		return new Response(await resp.text(), {
			status: resp.status,
			headers: { "Content-Type": "application/json" },
		});
	}

	async #checkStatus() {
		if (this.sessionInfo) {
			const url = new URL("http://localhost/browser/status");
			url.searchParams.set("sessionId", this.sessionInfo.sessionId);
			const resp =
				await this.env[SharedBindings.MAYBE_SERVICE_LOOPBACK].fetch(url);
			if (!resp.ok) {
				this.closeSession();
			}
		}
	}

	#scheduleStatusCheck() {
		if (this.#statusTimeout !== undefined) {
			return;
		}
		this.#statusTimeout = this.timers.setTimeout(async () => {
			this.#statusTimeout = undefined;
			await this.#checkStatus();
			if (this.chromeWs) {
				this.#scheduleStatusCheck();
			}
		}, 1000);
	}
}

// Call a session's DO stub with the original request, just injecting cf.miniflare.name
function callSession(
	env: Env,
	sessionId: string,
	request: Request
): Promise<Response> {
	const cf: MiniflareDurableObjectCf = { miniflare: { name: sessionId } };
	const stub = env.BrowserSession.get(env.BrowserSession.idFromName(sessionId));
	return stub.fetch(request, { cf: cf as Record<string, unknown> });
}

function fetchSession(
	env: Env,
	sessionId: string,
	path: string,
	init?: RequestInit
): Promise<Response> {
	const cf: MiniflareDurableObjectCf = { miniflare: { name: sessionId } };
	const stub = env.BrowserSession.get(env.BrowserSession.idFromName(sessionId));
	return stub.fetch(`http://placeholder${path}`, {
		...init,
		cf: cf as Record<string, unknown>,
	});
}

async function acquireSession(env: Env): Promise<SessionInfo> {
	const sessionInfo: SessionInfo = await env[
		SharedBindings.MAYBE_SERVICE_LOOPBACK
	]
		.fetch("http://localhost/browser/launch")
		.then((r) => r.json());
	await fetchSession(env, sessionInfo.sessionId, "/session-info", {
		method: "POST",
		body: JSON.stringify(sessionInfo),
	});
	return sessionInfo;
}

async function getActiveSessions(env: Env) {
	const sessionIds = (await env[SharedBindings.MAYBE_SERVICE_LOOPBACK]
		.fetch("http://localhost/browser/sessionIds")
		.then((r) => r.json())) as string[];

	const sessions = await Promise.all(
		sessionIds.map(async (sessionId) => {
			const resp = await fetchSession(env, sessionId, "/session-info");
			if (resp.status === 204) {
				return null;
			}
			const sessionInfo: SessionInfo = await resp.json();
			return {
				sessionId: sessionInfo.sessionId,
				startTime: sessionInfo.startTime,
				connectionId: sessionInfo.connectionId,
				connectionStartTime: sessionInfo.connectionStartTime,
			};
		})
	);

	return sessions.filter(Boolean);
}

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);
		const path = url.pathname;

		switch (`${request.method} ${path}`) {
			case "GET /v1/acquire": {
				const sessionInfo = await acquireSession(env);
				return Response.json({ sessionId: sessionInfo.sessionId });
			}
			case "GET /v1/sessions":
				return Response.json({
					sessions: await getActiveSessions(env),
				});
			case "GET /v1/limits":
				return Response.json({
					maxConcurrentSessions: 6,
					allowedBrowserAcquisitions: 6,
					timeUntilNextAllowedBrowserAcquisition: 0,
				});
			case "GET /v1/history":
				return Response.json([]);
			case "GET /v1/devtools/session":
				return Response.json(await getActiveSessions(env));
			case "GET /v1/connectDevtools": {
				const sessionId = url.searchParams.get("browser_session");
				assert(sessionId !== null, "browser_session must be set");
				// Rewrite to the DO's /v1/devtools/browser/:sessionId route
				const doUrl = new URL(request.url);
				doUrl.pathname = `/v1/devtools/browser/${sessionId}`;
				const resp = await callSession(
					env,
					sessionId,
					new Request(doUrl, request)
				);
				if (resp.status >= 400) {
					throw new Error(await resp.text());
				}
				return resp;
			}
			case "POST /v1/devtools/browser": {
				const sessionInfo = await acquireSession(env);
				return Response.json({ sessionId: sessionInfo.sessionId });
			}
			case "GET /v1/devtools/browser": {
				const sessionInfo = await acquireSession(env);
				const doUrl = new URL(request.url);
				doUrl.pathname = `/v1/devtools/browser/${sessionInfo.sessionId}`;
				doUrl.searchParams.set("raw", "1");
				return callSession(
					env,
					sessionInfo.sessionId,
					new Request(doUrl, {
						method: request.method,
						headers: {
							...Object.fromEntries(request.headers),
							"x-session-id": sessionInfo.sessionId,
						},
					})
				);
			}
		}

		const sessionMatch = path.match(
			/^\/v1\/devtools\/session\/(?<sessionId>[^/]+)$/
		);
		if (sessionMatch?.groups) {
			return callSession(env, sessionMatch.groups.sessionId, request);
		}

		const browserMatch = path.match(
			/^\/v1\/devtools\/browser\/(?<sessionId>[^/]+)(?<rest>\/.*)?$/
		);
		if (browserMatch?.groups) {
			const { sessionId, rest } = browserMatch.groups;

			if (request.method === "DELETE" && !rest) {
				// The DO sends the kill signal and returns immediately, keeping
				// it idle so WebSocket close events can propagate to the user.
				await callSession(env, sessionId, request);
				// Poll until Chrome has exited so the session list is clean
				for (let i = 0; i < 50; i++) {
					const statusUrl = new URL("http://localhost/browser/status");
					statusUrl.searchParams.set("sessionId", sessionId);
					const statusResp =
						await env[SharedBindings.MAYBE_SERVICE_LOOPBACK].fetch(statusUrl);
					if (statusResp.status === 410) {
						break;
					}
					await new Promise((r) => setTimeout(r, 100));
				}
				return Response.json({ status: "closed" });
			}

			// For GET /v1/devtools/browser/:id (raw WebSocket connect), add raw param
			const doUrl = new URL(request.url);
			if (request.method === "GET" && !rest) {
				doUrl.searchParams.set("raw", "1");
			}
			return callSession(env, sessionId, new Request(doUrl, request));
		}

		return new Response("Not Found.", { status: 404 });
	},
};
