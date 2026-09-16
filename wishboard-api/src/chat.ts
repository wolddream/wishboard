import { json, uid, upsertUser } from "./util";

// 위시 하나당 대화방이 하나다 - 위시 주인과 관심 있는 사람들이 모두 같은 방에서 이야기한다(1:N).
// peer_id 컬럼은 예전 1:1 스레드 구조의 흔적이라 항상 owner_id를 넣어 채워두기만 하고 더는
// 대화를 구분하는 데 쓰지 않는다(스키마 마이그레이션 없이 그대로 재사용하기 위함).
interface ChatRow {
	id: string;
	from_user_id: string;
	from_name: string;
	text: string;
	created_at: string;
}

export async function handleGetChat(request: Request, env: Env, wishId: string): Promise<Response> {
	const { results } = await env.DB.prepare(
		`SELECT id, from_user_id, from_name, text, created_at FROM chat_messages WHERE wish_id = ? ORDER BY created_at ASC LIMIT 200`
	)
		.bind(wishId)
		.all<ChatRow>();
	return json({
		messages: results.map((r) => ({ id: r.id, fromUserId: r.from_user_id, fromName: r.from_name, text: r.text, at: r.created_at })),
	});
}

export async function handlePostChat(request: Request, env: Env, wishId: string, ctx: ExecutionContext): Promise<Response> {
	const body = (await request.json()) as { from_user_id?: string; from_name?: string; from_avatar?: string; text?: string };
	const text = (body.text || "").trim();
	if (!body.from_user_id || !text) return json({ error: "from_user_id, text are required" }, 400);

	const wish = await env.DB.prepare(`SELECT owner_id, title FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string; title: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);

	const messageId = uid("m");
	const fromUserId = body.from_user_id;
	const fromName = body.from_name || "친구";

	// 보내는 사람이 화면에서 바로 자기 메시지를 보고 있으니, 응답은 메시지 저장이 끝나는 즉시
	// 돌려준다 - 프로필 동기화/알림 발송은 전송 체감 속도와 무관해서 응답 뒤로 미룬다.
	await env.DB.prepare(`INSERT INTO chat_messages (id, wish_id, owner_id, peer_id, from_user_id, from_name, text) VALUES (?, ?, ?, ?, ?, ?, ?)`)
		.bind(messageId, wishId, wish.owner_id, wish.owner_id, fromUserId, fromName, text.slice(0, 500))
		.run();

	ctx.waitUntil(
		(async () => {
			await upsertUser(env, fromUserId, fromName, body.from_avatar || "😊");

			// 방에 이미 참여한 사람 + 위시 주인 전원에게 알리되, 보낸 사람 본인은 뺀다.
			const { results: senders } = await env.DB.prepare(`SELECT DISTINCT from_user_id FROM chat_messages WHERE wish_id = ?`)
				.bind(wishId)
				.all<{ from_user_id: string }>();
			const recipients = new Set(senders.map((r) => r.from_user_id));
			recipients.add(wish.owner_id);
			recipients.delete(fromUserId);
			if (recipients.size === 0) return;

			const notifyText = `${fromName}님이 "${wish.title}" 대화방에 메시지를 보냈어요`;
			await env.DB.batch(
				Array.from(recipients).map((userId) =>
					env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'chat_message', ?, ?)`).bind(uid("n"), userId, wishId, notifyText)
				)
			);
		})()
	);

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
