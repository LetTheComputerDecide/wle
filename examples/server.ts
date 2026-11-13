import { createServer, type ServerResponse } from "node:http";

// A local server for the demos in this folder. It listens on two ports, because the
// per-host limit treats each host:port as a separate host.
//
//   pnpm demo-server
//
// Routes (`:id` is any value; it only makes each URL distinct):
//   /page/:id          small page with a few links
//   /slow/:id?ms=300   small page, sent after a delay
//   /big/:id           about 1.2 MB of HTML, which takes tens of milliseconds to parse
//   /flaky/:id         alternates: 503, then a normal page, then 503 again, and so on
//   /status/:code      an empty response with that HTTP status
//   /text              plain text, not HTML
//   /redirect-loop     redirects to itself forever
//   /hang              never responds

const PORTS = [8787, 8788];

const BIG_PAGE = `<!doctype html><title>Big page</title>${Array.from(
	{ length: 12_000 },
	(_, paragraph) =>
		`<p>Paragraph ${paragraph}, with enough text to look like real content.</p><a href="/page/${paragraph}">link ${paragraph}</a>`,
).join("\n")}`;

const smallPage = (id: string) =>
	`<!doctype html><title>Page ${id}</title><a href="/page/${id}/a">a</a> <a href="/page/${id}/b">b</a> <a href="https://example.com/">external</a>`;

const flakyRequests = new Map<string, number>();

function html(response: ServerResponse, body: string): void {
	response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
	response.end(body);
}

const server = (port: number) =>
	createServer((request, response) => {
		const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
		const [, route = "", id = ""] = url.pathname.split("/");
		switch (route) {
			case "page":
				return html(response, smallPage(id));
			case "slow": {
				const delayMs = Number(url.searchParams.get("ms") ?? 300);
				setTimeout(() => html(response, smallPage(id)), delayMs);
				return;
			}
			case "big":
				return html(response, BIG_PAGE);
			case "flaky": {
				// Alternating, rather than failing only once, so every demo run sees one 503
				// followed by a success, without restarting the server.
				const seen = flakyRequests.get(url.pathname) ?? 0;
				flakyRequests.set(url.pathname, seen + 1);
				if (seen % 2 === 0) {
					response.writeHead(503);
					response.end();
					return;
				}
				return html(response, smallPage(id));
			}
			case "status":
				response.writeHead(Number(id) || 500);
				response.end();
				return;
			case "text":
				response.writeHead(200, { "content-type": "text/plain" });
				response.end("Not HTML.");
				return;
			case "redirect-loop":
				response.writeHead(302, { location: url.pathname });
				response.end();
				return;
			case "hang":
				return; // Never respond; the client's timeout ends it.
			default:
				response.writeHead(404);
				response.end();
		}
	});

for (const port of PORTS) {
	server(port)
		.on("error", (error) => {
			console.error(`Cannot listen on port ${port}: ${error.message}`);
			process.exit(1);
		})
		.listen(port, "127.0.0.1", () => {
			console.log(`Demo server listening on http://127.0.0.1:${port}/`);
		});
}
console.log("Press Ctrl-C to stop.");
