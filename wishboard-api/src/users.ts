import { json } from "./util";

export async function handleGetUser(env: Env, userId: string): Promise<Response> {
	const row = await env.DB.prepare(`SELECT id, name, avatar FROM users WHERE id = ?`).bind(userId).first<{ id: string; name: string; avatar: string }>();
	if (!row) return json({ error: "user not found" }, 404);
	return json({ id: row.id, name: row.name, avatar: row.avatar });
}

export async function handlePatchUser(request: Request, env: Env, userId: string): Promise<Response> {
	const body = (await request.json()) as { name?: string; avatar?: string };
	await env.DB.prepare(
		`INSERT INTO users (id, name, avatar) VALUES (?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`
	)
		.bind(userId, body.name || userId, body.avatar || "😊")
		.run();
	return json({ ok: true });
}
