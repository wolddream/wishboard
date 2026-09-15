import { json, uid } from "./util";

interface WishRow {
	id: string;
	owner_id: string;
	owner_name: string;
	owner_avatar: string | null;
	type: string;
	group_name: string | null;
	title: string;
	subtitle: string | null;
	story: string | null;
	emoji: string | null;
	category: string | null;
	goal_amount: number;
	current_amount: number;
	deadline: string;
	created_at: string;
}
interface MemberRow {
	wish_id: string;
	user_id: string;
	user_name: string;
	user_avatar: string | null;
}
interface ContributionRow {
	id: string;
	wish_id: string;
	from_user_id: string | null;
	from_name: string;
	amount: number;
	message: string | null;
	anonymous: number;
	created_at: string;
}

function wishRowToClient(row: WishRow, members: MemberRow[], contributions: ContributionRow[]) {
	return {
		id: row.id,
		ownerId: row.owner_id,
		ownerName: row.owner_name,
		ownerAvatar: row.owner_avatar,
		type: row.type,
		groupName: row.group_name || "",
		members: members.map((m) => ({ id: m.user_id, name: m.user_name, avatar: m.user_avatar })),
		title: row.title,
		subtitle: row.subtitle || "",
		story: row.story || "",
		emoji: row.emoji || "🎁",
		category: row.category || "",
		goalAmount: row.goal_amount,
		currentAmount: row.current_amount,
		deadline: row.deadline,
		createdAt: row.created_at,
		contributions: contributions.map((c) => ({
			id: c.id,
			fromUserId: c.from_user_id,
			fromName: c.anonymous ? "익명" : c.from_name,
			amount: c.amount,
			message: c.message || "",
			anonymous: !!c.anonymous,
			at: c.created_at,
		})),
	};
}

// user_id/name/avatar를 그대로 믿는다 - keongyu와 같은 신뢰 모델. 다만 실제로 온 값이 있으면
// users 테이블에 최신 이름/아바타로 upsert해둬서, 다른 사람이 그 user_id를 조회할 때(예: 알림에
// 표시할 이름) 최신 정보를 쓸 수 있게 한다.
async function upsertUser(env: Env, id: string, name: string, avatar: string): Promise<void> {
	if (!id) return;
	await env.DB.prepare(
		`INSERT INTO users (id, name, avatar) VALUES (?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET name = excluded.name, avatar = excluded.avatar`
	)
		.bind(id, name || id, avatar || "😊")
		.run();
}

export async function handleGetWishes(env: Env): Promise<Response> {
	const { results: wishRows } = await env.DB.prepare(
		`SELECT id, owner_id, owner_name, owner_avatar, type, group_name, title, subtitle, story, emoji, category,
		        goal_amount, current_amount, deadline, created_at
		 FROM wishes ORDER BY created_at DESC LIMIT 200`
	).all<WishRow>();

	if (wishRows.length === 0) return json({ wishes: [] });
	const ids = wishRows.map((w) => w.id);
	const placeholders = ids.map(() => "?").join(",");

	const [{ results: memberRows }, { results: contribRows }] = await Promise.all([
		env.DB.prepare(`SELECT wish_id, user_id, user_name, user_avatar FROM wish_members WHERE wish_id IN (${placeholders})`)
			.bind(...ids)
			.all<MemberRow>(),
		env.DB.prepare(`SELECT id, wish_id, from_user_id, from_name, amount, message, anonymous, created_at FROM contributions WHERE wish_id IN (${placeholders}) ORDER BY created_at DESC`)
			.bind(...ids)
			.all<ContributionRow>(),
	]);

	const membersByWish = new Map<string, MemberRow[]>();
	for (const m of memberRows) {
		if (!membersByWish.has(m.wish_id)) membersByWish.set(m.wish_id, []);
		membersByWish.get(m.wish_id)!.push(m);
	}
	const contribByWish = new Map<string, ContributionRow[]>();
	for (const c of contribRows) {
		if (!contribByWish.has(c.wish_id)) contribByWish.set(c.wish_id, []);
		contribByWish.get(c.wish_id)!.push(c);
	}

	const wishes = wishRows.map((w) => wishRowToClient(w, membersByWish.get(w.id) || [], contribByWish.get(w.id) || []));
	return json({ wishes });
}

export async function handlePostWish(request: Request, env: Env): Promise<Response> {
	const body = (await request.json()) as {
		owner_id?: string;
		owner_name?: string;
		owner_avatar?: string;
		type?: string;
		group_name?: string;
		members?: Array<{ id: string; name: string; avatar: string }>;
		title?: string;
		subtitle?: string;
		story?: string;
		emoji?: string;
		category?: string;
		goal_amount?: number;
		deadline?: string;
	};
	if (!body.owner_id || !body.title || !body.goal_amount || !body.deadline) {
		return json({ error: "owner_id, title, goal_amount, deadline are required" }, 400);
	}
	const isGroup = body.type === "group";
	const wishId = uid("w");

	await upsertUser(env, body.owner_id, body.owner_name || body.owner_id, body.owner_avatar || "😊");

	const statements = [
		env.DB.prepare(
			`INSERT INTO wishes (id, owner_id, owner_name, owner_avatar, type, group_name, title, subtitle, story, emoji, category, goal_amount, current_amount, deadline)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`
		).bind(
			wishId,
			body.owner_id,
			body.owner_name || body.owner_id,
			body.owner_avatar || "😊",
			isGroup ? "group" : "personal",
			isGroup ? body.group_name || "" : null,
			body.title,
			body.subtitle || "",
			body.story || "",
			body.emoji || "🎁",
			body.category || "",
			Math.max(1000, Math.round(Number(body.goal_amount) || 100000)),
			body.deadline
		),
	];
	if (isGroup && Array.isArray(body.members)) {
		for (const m of body.members) {
			if (!m || !m.id) continue;
			statements.push(
				env.DB.prepare(`INSERT INTO wish_members (wish_id, user_id, user_name, user_avatar) VALUES (?, ?, ?, ?)`).bind(wishId, m.id, m.name || m.id, m.avatar || "😊")
			);
		}
	}
	await env.DB.batch(statements);
	return json({ ok: true, id: wishId }, 201);
}

export async function handleDeleteWish(request: Request, env: Env, wishId: string): Promise<Response> {
	const userId = new URL(request.url).searchParams.get("user_id") || "";
	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	// 진짜 인증은 없지만(keongyu와 같은 신뢰 모델), 최소한 owner이거나 그 위시의 멤버인 사람만
	// 지울 수 있게는 확인한다.
	const isMember = await env.DB.prepare(`SELECT 1 FROM wish_members WHERE wish_id = ? AND user_id = ?`).bind(wishId, userId).first();
	if (wish.owner_id !== userId && !isMember) return json({ error: "삭제 권한이 없어요" }, 403);

	await env.DB.batch([
		env.DB.prepare(`DELETE FROM wishes WHERE id = ?`).bind(wishId),
		env.DB.prepare(`DELETE FROM wish_members WHERE wish_id = ?`).bind(wishId),
		env.DB.prepare(`DELETE FROM contributions WHERE wish_id = ?`).bind(wishId),
	]);
	return json({ ok: true });
}

// 단체 위시는 만들 때 멤버를 미리 고르지 않는다(진짜 친구 목록이 없어서) - 대신 만든 사람이
// "초대 링크"(?join=wishId)를 공유하면, 그 링크로 들어온 사람이 이 엔드포인트로 스스로 합류한다.
// keongyu의 "함께가기 참여 링크"와 같은 패턴.
export async function handleJoinWish(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as { user_id?: string; user_name?: string; user_avatar?: string };
	if (!body.user_id) return json({ error: "user_id is required" }, 400);
	const wish = await env.DB.prepare(`SELECT id, type FROM wishes WHERE id = ?`).bind(wishId).first<{ id: string; type: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.type !== "group") return json({ error: "단체 위시가 아니에요" }, 400);

	await env.DB.prepare(
		`INSERT INTO wish_members (wish_id, user_id, user_name, user_avatar) VALUES (?, ?, ?, ?)
		 ON CONFLICT(wish_id, user_id) DO UPDATE SET user_name = excluded.user_name, user_avatar = excluded.user_avatar`
	)
		.bind(wishId, body.user_id, body.user_name || body.user_id, body.user_avatar || "😊")
		.run();
	return json({ ok: true });
}

export async function handlePostGift(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as {
		from_user_id?: string;
		from_name?: string;
		from_avatar?: string;
		amount?: number;
		message?: string;
		anonymous?: boolean;
	};
	const amount = Math.floor(Number(body.amount));
	if (!amount || amount < 100) return json({ error: "amount must be at least 100" }, 400);

	const wish = await env.DB.prepare(`SELECT id, owner_id, owner_name, title, type, goal_amount, current_amount FROM wishes WHERE id = ?`)
		.bind(wishId)
		.first<{ id: string; owner_id: string; owner_name: string; title: string; type: string; goal_amount: number; current_amount: number }>();
	if (!wish) return json({ error: "wish not found" }, 404);

	// 목표금액을 넘는 만큼은 반영하지 않는다 - 클라이언트에도 같은 로직이 있지만, 서버가 최종
	// 진실이어야 여러 사람이 거의 동시에 보태도 진행률이 100%를 넘지 않는다.
	const remaining = wish.goal_amount - wish.current_amount;
	const applied = Math.min(amount, Math.max(0, remaining));
	if (applied <= 0) return json({ error: "이미 목표금액을 달성한 위시예요" }, 400);

	if (body.from_user_id) await upsertUser(env, body.from_user_id, body.from_name || body.from_user_id, body.from_avatar || "😊");

	const contributionId = uid("c");
	const fromName = body.anonymous ? "익명" : body.from_name || "친구";
	const statements = [
		env.DB.prepare(`INSERT INTO contributions (id, wish_id, from_user_id, from_name, amount, message, anonymous) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
			contributionId,
			wishId,
			body.from_user_id || null,
			body.from_name || "친구",
			applied,
			(body.message || "").slice(0, 300),
			body.anonymous ? 1 : 0
		),
		env.DB.prepare(`UPDATE wishes SET current_amount = current_amount + ? WHERE id = ?`).bind(applied, wishId),
	];

	// 위시 소유자(+ 단체 위시면 멤버 전원, 보낸 사람 본인은 제외)에게 알림을 남긴다.
	const notifyText = `${fromName}님이 "${wish.title}"에 ${applied.toLocaleString()}원을 보탰어요`;
	const notifyTargets = new Set<string>();
	if (wish.owner_id && wish.owner_id !== body.from_user_id) notifyTargets.add(wish.owner_id);
	if (wish.type === "group") {
		const { results: members } = await env.DB.prepare(`SELECT user_id FROM wish_members WHERE wish_id = ?`).bind(wishId).all<{ user_id: string }>();
		members.forEach((m) => {
			if (m.user_id !== body.from_user_id) notifyTargets.add(m.user_id);
		});
	}
	notifyTargets.forEach((targetId) => {
		statements.push(
			env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'gift_arrived', ?, ?)`).bind(uid("n"), targetId, wishId, notifyText)
		);
	});

	await env.DB.batch(statements);
	return json({ ok: true, applied, newCurrentAmount: wish.current_amount + applied });
}
