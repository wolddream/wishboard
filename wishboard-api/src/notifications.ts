import { json } from "./util";

export async function handleGetNotifications(env: Env, userId: string): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT id, type, wish_id, text, is_read, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100`
	)
		.bind(userId)
		.all<{ id: string; type: string; wish_id: string | null; text: string; is_read: number; created_at: string }>();
	return json({
		notifications: results.map((n) => ({ id: n.id, type: n.type, wishId: n.wish_id, text: n.text, read: !!n.is_read, at: n.created_at })),
	});
}

export async function handleMarkNotificationRead(env: Env, notifId: string): Promise<Response> {
	await env.DB.prepare(`UPDATE notifications SET is_read = 1 WHERE id = ?`).bind(notifId).run();
	return json({ ok: true });
}
