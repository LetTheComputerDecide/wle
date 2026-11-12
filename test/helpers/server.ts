import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type Handler = (
	request: IncomingMessage,
	response: ServerResponse,
	url: URL,
) => void;

export interface TestServer {
	/** Absolute URL for a path on this server. */
	url(path: string): string;
	/** Number of requests received per path. */
	hits: Map<string, number>;
	close(): Promise<void>;
}

const PAGE = `<!doctype html><title>t</title><a href="/a">a</a><a href="b">b</a>`;

const html = (response: ServerResponse, body = PAGE, status = 200) => {
	response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
	response.end(body);
};

/**
 * Routes that exercise every fetch outcome. Extra routes can be passed in per test.
 */
const routes: Record<string, Handler> = {
	"/html": (_, res) => html(res),
	"/a": (_, res) => html(res, `<a href="/html">back</a>`),
	"/b": (_, res) => html(res, "<p>no links</p>"),
	"/xhtml": (_, res) => {
		res.writeHead(200, { "content-type": "application/xhtml+xml" });
		res.end(PAGE);
	},
	"/no-content-type": (_, res) => {
		res.writeHead(200);
		res.end(PAGE);
	},
	"/latin1": (_, res) => {
		res.writeHead(200, { "content-type": `text/html; charset="ISO-8859-1"` });
		res.end(Buffer.from(`<a href="/café">café</a>`, "latin1"));
	},
	"/bogus-charset": (_, res) => {
		res.writeHead(200, {
			"content-type": "text/html; charset=no-such-charset",
		});
		res.end(`<a href="/ok">ok</a>`);
	},
	"/json": (_, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end("{}");
	},
	"/image": (_, res) => {
		res.writeHead(200, { "content-type": "image/png" });
		res.end(Buffer.alloc(64));
	},
	"/redirect": (_, res) => {
		res.writeHead(302, { location: "/sub/target" });
		res.end();
	},
	"/sub/target": (_, res) => html(res, `<a href="sibling">s</a>`),
	"/redirect-loop": (_, res) => {
		res.writeHead(302, { location: "/redirect-loop" });
		res.end();
	},
	"/status": (_, res, url) => {
		const headers: Record<string, string> = { "content-type": "text/html" };
		const retryAfter = url.searchParams.get("retry-after");
		if (retryAfter) {
			headers["retry-after"] = retryAfter;
		}
		res.writeHead(Number(url.searchParams.get("code")), headers);
		res.end(PAGE);
	},
	"/slow": (_, res, url) => {
		setTimeout(() => html(res), Number(url.searchParams.get("ms") ?? 100));
	},
	"/hang": () => {
		// Never responds.
	},
	"/hang-body": (_, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.write("<a href='/partial'>");
		// Never finishes the body.
	},
	"/huge-declared": (_, res) => {
		res.writeHead(200, {
			"content-type": "text/html",
			"content-length": "10000000",
		});
		res.write("<p>");
		// The body is never sent; the declared length alone should be rejected.
	},
	"/huge-stream": (_, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		const chunk = Buffer.alloc(16 * 1024, "a");
		const write = () => {
			while (res.write(chunk)) {
				// Keep writing until the socket applies backpressure.
			}
			res.once("drain", write);
		};
		write();
	},
};

export async function startServer(
	extra: Record<string, Handler> = {},
): Promise<TestServer> {
	const all = { ...routes, ...extra };
	const hits = new Map<string, number>();
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		hits.set(url.pathname, (hits.get(url.pathname) ?? 0) + 1);
		const handler = all[url.pathname];
		if (handler) {
			handler(request, response, url);
		} else {
			html(response, "not found", 404);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;

	return {
		url: (path) => `http://127.0.0.1:${port}${path}`,
		hits,
		close: () =>
			new Promise<void>((resolve, reject) => {
				server.closeAllConnections();
				server.close((error) => (error ? reject(error) : resolve()));
			}),
	};
}
