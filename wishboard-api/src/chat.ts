import { json, uid, upsertUser } from "./util";

// 위시 하나에 여러 사람이 각자 위시 주인과 1:1로 대화한다 - "누구와의 대화인지"는 wish_id +
// peer_id(대화 상대가 되는 그 "다른 사람"의 id, 항상 owner가 아닌 쪽)로 구분한다. owner가
// 여러 사람과 대화 중이면 peer_id별로 스레드가 나뉘고, peer 쪽에서는 자기 자신의 id가 곧
// peer_id라 스레드가 하나뿐이다(위시 주인과의 대화 하나).
interface ChatRow {
	id: string;
	from_user_id: string;
	from_name: string;
	text: string;
	created_at: string;
}

export async function handleGetChat(request: Request, env: Env, wishId: string): Promise<Response> {
	const url = new URL(request.url);
	const peerId = url.searchParams.get("peer_id");
	if (!peerId) return json({ error: "peer_id is required" }, 400);
	const { results } = await env.DB.prepare(
		`SELECT id, from_user_id, from_name, text, created_at FROM chat_messages WHERE wish_id = ? AND peer_id = ? ORDER BY created_at ASC LIMIT 200`
	)
		.bind(wishId, peerId)
		.all<ChatRow>();
	return json({
		messages: results.map((r) => ({ id: r.id, fromUserId: r.from_user_id, fromName: r.from_name, text: r.text, at: r.created_at })),
	});
}

export async function handlePostChat(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as { from_user_id?: string; from_name?: string; from_avatar?: string; peer_id?: string; text?: string };
	const text = (body.text || "").trim();
	if (!body.from_user_id || !text) return json({ error: "from_user_id, text are required" }, 400);

	const wish = await env.DB.prepare(`SELECT owner_id, title FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string; title: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);

	// 위시 주인이 보내는 거면 어느 대화 상대(peer_id)에게 보내는지 클라이언트가 지정해야 하고,
	// 위시 주인이 아닌 사람이 보내는 거면 그 사람 자신이 곧 peer_id다(위시 주인과만 대화 가능).
	const isOwnerSending = body.from_user_id === wish.owner_id;
	const peerId = isOwnerSending ? body.peer_id : body.from_user_id;
	if (!peerId) return json({ error: "peer_id is required" }, 400);

	await upsertUser(env, body.from_user_id, body.from_name || body.from_user_id, body.from_avatar || "😊");

	const messageId = uid("m");
	const targetUserId = isOwnerSending ? peerId : wish.owner_id;
	const notifyText = `${body.from_name || "누군가"}님이 "${wish.title}"에 메시지를 보냈어요`;

	await env.DB.batch([
		env.DB.prepare(`INSERT INTO chat_messages (id, wish_id, owner_id, peer_id, from_user_id, from_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
			messageId,
			wishId,
			wish.owner_id,
			peerId,
			body.from_user_id,
			body.from_name || "친구",
			text.slice(0, 500)
		),
		env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'chat_message', ?, ?)`).bind(uid("n"), targetUserId, wishId, notifyText),
	]);

	return json({ ok: true, id: messageId }, 201);
}

// 보낸 사람 본인만 자기 메시지를 지울 수 있다(대화 상대 메시지는 못 지움).
export async function handleDeleteChat(request: Request, env: Env, wishId: string, messageId: string): Promise<Response> {
	const userId = new URL(request.url).searchParams.get("user_id") || "";
	const msg = await env.DB.prepare(`SELECT from_user_id FROM chat_messages WHERE id = ? AND wish_id = ?`).bind(messageId, wishId).first<{ from_user_id: string }>();
	if (!msg) return json({ error: "message not found" }, 404);
	if (msg.from_user_id !== userId) return json({ error: "삭제 권한이 없어요" }, 403);
	await env.DB.prepare(`DELETE FROM chat_messages WHERE id = ?`).bind(messageId).run();
	return json({ ok: true });
}

// 위시 주인이 자기 위시에 걸린 모든 1:1 대화 목록(상대방 목록)을 본다.
export async function handleGetChatThreads(request: Request, env: Env, wishId: string): Promise<Response> {
	const url = new URL(request.url);
	const userId = url.searchParams.get("user_id");
	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== userId) return json({ error: "권한이 없어요" }, 403);

	const { results } = await env.DB.prepare(
		`SELECT cm.peer_id as peer_id, u.name as peer_name, u.avatar as peer_avatar, cm.text as last_text, cm.created_at as last_at
		 FROM chat_messages cm
		 LEFT JOIN users u ON u.id = cm.peer_id
		 WHERE cm.wish_id = ? AND cm.created_at = (SELECT MAX(created_at) FROM chat_messages WHERE wish_id = cm.wish_id AND peer_id = cm.peer_id)
		 ORDER BY cm.created_at DESC`
	)
		.bind(wishId)
		.all<{ peer_id: string; peer_name: string | null; peer_avatar: string | null; last_text: string; last_at: string }>();

	return json({
		threads: results.map((r) => ({ peerId: r.peer_id, peerName: r.peer_name || "친구", peerAvatar: r.peer_avatar || "😊", lastText: r.last_text, lastAt: r.last_at })),
	});
}
