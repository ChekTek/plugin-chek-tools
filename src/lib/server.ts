import streamDeck from "@elgato/streamdeck";
import { createReadStream, existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import store from "../plugin-store";
import refreshService from "../services/refresh-service";

/** Fixed local port the dashboard is served on. */
export const DASHBOARD_PORT = 48616;
export const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}/`;

// bin/plugin.js -> ../dashboard
const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dashboard");

const types: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png"
};

/**
 * Serves the dashboard page, the current state as JSON, and a server-sent-events stream
 * that pushes the state every time it changes.
 */
export function startDashboardServer(): void {
	const clients = new Set<ServerResponse>();

	store.on("change", (state) => {
		const payload = `data: ${JSON.stringify(state)}\n\n`;
		for (const res of clients) res.write(payload);
	});

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", DASHBOARD_URL);

		if (url.pathname === "/api/state") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end(JSON.stringify(store.state));
			return;
		}

		if (url.pathname === "/api/refresh" && req.method === "POST") {
			// Fire and forget: progress reaches the page through the event stream.
			refreshService.refreshAll();
			res.writeHead(202);
			res.end();
			return;
		}

		if (url.pathname === "/api/events") {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
			res.write(`data: ${JSON.stringify(store.state)}\n\n`);
			clients.add(res);
			req.on("close", () => clients.delete(res));
			return;
		}

		// Static files from the dashboard folder; "/" maps to index.html.
		const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
		const file = join(dashboardDir, rel);
		if (!file.startsWith(dashboardDir) || !existsSync(file)) {
			res.writeHead(404);
			res.end("Not found");
			return;
		}
		const ext = file.slice(file.lastIndexOf("."));
		res.writeHead(200, { "content-type": types[ext] ?? "application/octet-stream", "cache-control": "no-store" });
		createReadStream(file).pipe(res);
	});

	server.on("error", (err) => streamDeck.logger.error(`Dashboard server error: ${err.message}`));
	server.listen(DASHBOARD_PORT, "127.0.0.1", () => streamDeck.logger.info(`Dashboard at ${DASHBOARD_URL}`));
}
