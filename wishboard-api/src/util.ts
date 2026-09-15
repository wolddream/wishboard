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

// UTF-8 safe base64 (btoa() alone mangles multi-byte chars like Korean nicknames).
export function toBase64Utf8(obj: unknown): string {
	const bytes = new TextEncoder().encode(JSON.stringify(obj));
	let binary = "";
	bytes.forEach((b) => (binary += String.fromCharCode(b)));
	return btoa(binary);
}

// user_id/name/avatar를 그대로 믿는다 - keongyu와 같은 신뢰 모델. 다만 실제로 온 값이 있으면
// users 테이블에 최신 이름/아바타로 upsert해둬서, 다른 사람이 그 user_id를 조회할 때(예: 알림에
// 표시할 이름) 최신 정보를 쓸 수 있게 한다.
export async function upsertUser(env: Env, id: string, name: string, avatar: string): Promise<void> {
	if (!id) return;
	await env.DB.prepare(
		`INSERT INTO users (id, name, avatar) VALUES (?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`
	)
		.bind(id, name || id, avatar || "😊")
		.run();
}
