export function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json; charset=utf-8" },
	});
}

export function cors(resp: Response): Response {
	resp.headers.set("Access-Control-Allow-Origin", "*");
	resp.headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
	resp.headers.set("Access-Control-Allow-Headers", "Content-Type");
	return resp;
}

export function uid(prefix: string): string {
	return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
