import { json, uid, upsertUser, parseImageUrls, serializeImageUrls } from "./util";

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
	deadline: string;
	created_at: string;
}
interface MemberRow {
	wish_id: string;
	user_id: string;
	user_name: string;
	user_avatar: string | null;
}
interface ItemRow {
	id: string;
	wish_id: string;
	name: string;
	link: string | null;
	image_url: string | null;
	note: string | null;
	goal_amount: number;
	current_amount: number;
}
interface ContributionRow {
	id: string;
	wish_id: string;
	item_id: string | null;
	from_user_id: string | null;
	from_name: string;
	amount: number;
	message: string | null;
	anonymous: number;
	created_at: string;
}

// 위시 하나 = 아이템 여러 개로 이루어진 "위시 리스트"(예: 마라톤 대회 참가 위시 안에 런닝화,
// 유니폼 두 아이템). 목표/모금액은 전부 아이템 단위로 매겨지므로, 위시 카드에 보이는 전체
// 진행률은 매번 아이템들의 합계로 계산한다(wishes 테이블엔 별도로 저장/동기화하지 않는다).
function wishRowToClient(
	row: WishRow,
	members: MemberRow[],
	contributions: ContributionRow[],
	items: ItemRow[],
	followerCount: number,
	following: boolean
) {
	const goalAmount = items.reduce((s, i) => s + i.goal_amount, 0);
	const currentAmount = items.reduce((s, i) => s + i.current_amount, 0);
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
		goalAmount,
		currentAmount,
		followerCount,
		following,
		deadline: row.deadline,
		createdAt: row.created_at,
		items: items.map((i) => ({
			id: i.id,
			name: i.name,
			link: i.link || "",
			imageUrls: parseImageUrls(i.image_url),
			note: i.note || "",
			goalAmount: i.goal_amount,
			currentAmount: i.current_amount,
		})),
		contributions: contributions.map((c) => ({
			id: c.id,
			itemId: c.item_id,
			fromUserId: c.from_user_id,
			fromName: c.anonymous ? "익명" : c.from_name,
			amount: c.amount,
			message: c.message || "",
			anonymous: !!c.anonymous,
			at: c.created_at,
		})),
	};
}

export async function handleGetWishes(env: Env, userId?: string | null): Promise<Response> {
	const { results: wishRows } = await env.DB.prepare(
		`SELECT id, owner_id, owner_name, owner_avatar, type, group_name, title, subtitle, story, emoji, category,
		        deadline, created_at
		 FROM wishes ORDER BY created_at DESC LIMIT 200`
	).all<WishRow>();

	if (wishRows.length === 0) return json({ wishes: [] });
	const ids = wishRows.map((w) => w.id);
	const placeholders = ids.map(() => "?").join(",");

	const [{ results: memberRows }, { results: contribRows }, { results: itemRows }, { results: followCountRows }, { results: myFollowRows }] = await Promise.all([
		env.DB.prepare(`SELECT wish_id, user_id, user_name, user_avatar FROM wish_members WHERE wish_id IN (${placeholders})`)
			.bind(...ids)
			.all<MemberRow>(),
		env.DB.prepare(`SELECT id, wish_id, item_id, from_user_id, from_name, amount, message, anonymous, created_at FROM contributions WHERE wish_id IN (${placeholders}) ORDER BY created_at DESC`)
			.bind(...ids)
			.all<ContributionRow>(),
		env.DB.prepare(`SELECT id, wish_id, name, link, image_url, note, goal_amount, current_amount FROM wish_items WHERE wish_id IN (${placeholders}) ORDER BY sort_order, created_at`)
			.bind(...ids)
			.all<ItemRow>(),
		env.DB.prepare(`SELECT wish_id, COUNT(*) as c FROM wish_follows WHERE wish_id IN (${placeholders}) GROUP BY wish_id`)
			.bind(...ids)
			.all<{ wish_id: string; c: number }>(),
		userId
			? env.DB.prepare(`SELECT wish_id FROM wish_follows WHERE user_id = ? AND wish_id IN (${placeholders})`)
					.bind(userId, ...ids)
					.all<{ wish_id: string }>()
			: Promise.resolve({ results: [] as Array<{ wish_id: string }> }),
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
	const itemsByWish = new Map<string, ItemRow[]>();
	for (const i of itemRows) {
		if (!itemsByWish.has(i.wish_id)) itemsByWish.set(i.wish_id, []);
		itemsByWish.get(i.wish_id)!.push(i);
	}
	const followCountByWish = new Map<string, number>();
	for (const f of followCountRows) followCountByWish.set(f.wish_id, f.c);
	const myFollowSet = new Set(myFollowRows.map((f) => f.wish_id));

	const wishes = wishRows.map((w) =>
		wishRowToClient(
			w,
			membersByWish.get(w.id) || [],
			contribByWish.get(w.id) || [],
			itemsByWish.get(w.id) || [],
			followCountByWish.get(w.id) || 0,
			myFollowSet.has(w.id)
		)
	);
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
		deadline?: string;
		items?: Array<{ name?: string; link?: string; image_urls?: string[]; note?: string; goal_amount?: number }>;
	};
	const items = (body.items || []).filter((i) => i && i.name && i.name.trim() && Number(i.goal_amount) >= 1000);
	if (!body.owner_id || !body.title || !body.deadline || items.length === 0) {
		return json({ error: "owner_id, title, deadline, items(최소 1개, 이름+1000원 이상) are required" }, 400);
	}
	const isGroup = body.type === "group";
	const wishId = uid("w");

	await upsertUser(env, body.owner_id, body.owner_name || body.owner_id, body.owner_avatar || "😊");

	// wishes.goal_amount/current_amount는 이제 실제로 쓰이지 않는다(진행률은 매번 아이템
	// 합계로 계산한다) - 다만 그 두 컬럼이 여전히 NOT NULL이라, 값을 안 채우면 INSERT 자체가
	// SQLITE_CONSTRAINT_NOTNULL로 실패한다. 아이템 목표금액 합계를 그대로 채워 넣는다.
	const itemGoals = items.map((item) => Math.max(1000, Math.round(Number(item.goal_amount) || 1000)));
	const totalGoal = itemGoals.reduce((s, g) => s + g, 0);

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
			totalGoal,
			body.deadline
		),
	];
	items.forEach((item, idx) => {
		statements.push(
			env.DB.prepare(`INSERT INTO wish_items (id, wish_id, name, link, image_url, note, goal_amount, current_amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`).bind(
				uid("i"),
				wishId,
				(item.name || "").trim().slice(0, 80),
				(item.link || "").trim().slice(0, 500),
				serializeImageUrls(item.image_urls),
				(item.note || "").trim().slice(0, 500),
				itemGoals[idx],
				idx
			)
		);
	});
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
		env.DB.prepare(`DELETE FROM wish_items WHERE wish_id = ?`).bind(wishId),
		env.DB.prepare(`DELETE FROM contributions WHERE wish_id = ?`).bind(wishId),
		env.DB.prepare(`DELETE FROM chat_messages WHERE wish_id = ?`).bind(wishId),
		env.DB.prepare(`DELETE FROM wish_follows WHERE wish_id = ?`).bind(wishId),
	]);
	return json({ ok: true });
}

// 삭제와 같은 신뢰 모델(owner만) - 단, 단체 위시 멤버는 수정 권한까지는 없다(내용은 만든
// 사람만 고칠 수 있고, 멤버는 초대 링크로 합류해 선물만 보태는 역할). 기존 아이템의 가격 변경/
// 삭제는 이미 들어온 선물과 얽혀 있어 여기서는 다루지 않고, 제목/소개/이유/마감일만 수정한다.
// 새 아이템 추가는 handleAddWishItem로 별도 처리(기존 선물과 무관하므로 안전).
export async function handlePatchWish(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as {
		user_id?: string;
		title?: string;
		subtitle?: string;
		story?: string;
		deadline?: string;
	};
	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== body.user_id) return json({ error: "수정 권한이 없어요" }, 403);
	if (!body.title || !body.deadline) return json({ error: "title, deadline are required" }, 400);

	await env.DB.prepare(`UPDATE wishes SET title = ?, subtitle = ?, story = ?, deadline = ? WHERE id = ?`)
		.bind(body.title, body.subtitle || "", body.story || "", body.deadline, wishId)
		.run();

	return json({ ok: true });
}

// 이미 등록된 위시에 아이템을 하나 더 추가한다(예: "마라톤 대회 참가"에 나중에 "양말" 추가) -
// 기존 아이템/선물에는 손대지 않으므로 handlePatchWish와 달리 안전하게 언제든 가능하다.
export async function handleAddWishItem(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as { user_id?: string; name?: string; link?: string; image_urls?: string[]; note?: string; goal_amount?: number };
	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== body.user_id) return json({ error: "아이템 추가 권한이 없어요" }, 403);
	if (!body.name || !body.name.trim() || !(Number(body.goal_amount) >= 1000)) {
		return json({ error: "아이템 이름과 1,000원 이상의 가격이 필요해요" }, 400);
	}

	const { results: countRows } = await env.DB.prepare(`SELECT COUNT(*) as c FROM wish_items WHERE wish_id = ?`).bind(wishId).all<{ c: number }>();
	const sortOrder = countRows[0]?.c ?? 0;
	const itemId = uid("i");
	await env.DB.prepare(`INSERT INTO wish_items (id, wish_id, name, link, image_url, note, goal_amount, current_amount, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`)
		.bind(
			itemId,
			wishId,
			body.name.trim().slice(0, 80),
			(body.link || "").trim().slice(0, 500),
			serializeImageUrls(body.image_urls),
			(body.note || "").trim().slice(0, 500),
			Math.max(1000, Math.round(Number(body.goal_amount))),
			sortOrder
		)
		.run();

	return json({ ok: true, id: itemId }, 201);
}

// 아이템 하나를 수정한다(이름/링크/이미지/가격) - owner만. 이미 모인 금액보다 가격을 낮출 수는
// 없다(handlePatchWish의 목표금액 보호와 같은 이유).
export async function handlePatchWishItem(request: Request, env: Env, wishId: string, itemId: string): Promise<Response> {
	const body = (await request.json()) as { user_id?: string; name?: string; link?: string; image_urls?: string[]; note?: string; goal_amount?: number };
	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== body.user_id) return json({ error: "수정 권한이 없어요" }, 403);
	const item = await env.DB.prepare(`SELECT current_amount FROM wish_items WHERE id = ? AND wish_id = ?`).bind(itemId, wishId).first<{ current_amount: number }>();
	if (!item) return json({ error: "item not found" }, 404);
	if (!body.name || !body.name.trim()) return json({ error: "아이템 이름이 필요해요" }, 400);

	const goalAmount = Math.max(item.current_amount, Math.round(Number(body.goal_amount) || item.current_amount || 1000));
	await env.DB.prepare(`UPDATE wish_items SET name = ?, link = ?, image_url = ?, note = ?, goal_amount = ? WHERE id = ?`)
		.bind(body.name.trim().slice(0, 80), (body.link || "").trim().slice(0, 500), serializeImageUrls(body.image_urls), (body.note || "").trim().slice(0, 500), goalAmount, itemId)
		.run();

	return json({ ok: true });
}

// 아이템 하나를 삭제한다 - owner만, 그리고 두 가지 안전장치를 둔다: (1) 마지막 남은 하나는 못
// 지운다(위시 전체를 지우게 유도), (2) 이미 선물을 받은 아이템은 돈이 허공에 뜨지 않도록 못
// 지운다.
export async function handleDeleteWishItem(request: Request, env: Env, wishId: string, itemId: string): Promise<Response> {
	const userId = new URL(request.url).searchParams.get("user_id") || "";
	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== userId) return json({ error: "삭제 권한이 없어요" }, 403);

	const item = await env.DB.prepare(`SELECT current_amount FROM wish_items WHERE id = ? AND wish_id = ?`).bind(itemId, wishId).first<{ current_amount: number }>();
	if (!item) return json({ error: "item not found" }, 404);
	if (item.current_amount > 0) return json({ error: "이미 선물을 받은 아이템은 삭제할 수 없어요" }, 400);

	const { results: countRows } = await env.DB.prepare(`SELECT COUNT(*) as c FROM wish_items WHERE wish_id = ?`).bind(wishId).all<{ c: number }>();
	if ((countRows[0]?.c ?? 0) <= 1) return json({ error: "마지막 남은 아이템은 삭제할 수 없어요. 위시 전체를 삭제해주세요." }, 400);

	await env.DB.prepare(`DELETE FROM wish_items WHERE id = ?`).bind(itemId).run();
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

// 위시 "관심" 등록/해제(찜) - 누구나(만든 사람 포함) 할 수 있고 owner 권한 확인이 필요 없다.
export async function handleFollowWish(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as { user_id?: string };
	if (!body.user_id) return json({ error: "user_id is required" }, 400);
	const wish = await env.DB.prepare(`SELECT id FROM wishes WHERE id = ?`).bind(wishId).first();
	if (!wish) return json({ error: "wish not found" }, 404);
	await env.DB.prepare(`INSERT INTO wish_follows (wish_id, user_id) VALUES (?, ?) ON CONFLICT(wish_id, user_id) DO NOTHING`).bind(wishId, body.user_id).run();
	return json({ ok: true });
}

export async function handleUnfollowWish(request: Request, env: Env, wishId: string): Promise<Response> {
	const userId = new URL(request.url).searchParams.get("user_id") || "";
	if (!userId) return json({ error: "user_id is required" }, 400);
	await env.DB.prepare(`DELETE FROM wish_follows WHERE wish_id = ? AND user_id = ?`).bind(wishId, userId).run();
	return json({ ok: true });
}

// 선물은 위시 전체가 아니라 그 안의 아이템 하나를 향한다(예: "런닝화"에만 보태기) - item_id로
// 어느 아이템인지 지정받는다.
export async function handlePostGift(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as {
		item_id?: string;
		from_user_id?: string;
		from_name?: string;
		from_avatar?: string;
		amount?: number;
		message?: string;
		anonymous?: boolean;
	};
	const amount = Math.floor(Number(body.amount));
	if (!amount || amount < 100) return json({ error: "amount must be at least 100" }, 400);
	if (!body.item_id) return json({ error: "item_id is required" }, 400);

	const wish = await env.DB.prepare(`SELECT id, owner_id, owner_name, title, type FROM wishes WHERE id = ?`)
		.bind(wishId)
		.first<{ id: string; owner_id: string; owner_name: string; title: string; type: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);

	const item = await env.DB.prepare(`SELECT id, name, goal_amount, current_amount FROM wish_items WHERE id = ? AND wish_id = ?`)
		.bind(body.item_id, wishId)
		.first<{ id: string; name: string; goal_amount: number; current_amount: number }>();
	if (!item) return json({ error: "item not found" }, 404);

	// 목표금액을 넘는 만큼은 반영하지 않는다 - 클라이언트에도 같은 로직이 있지만, 서버가 최종
	// 진실이어야 여러 사람이 거의 동시에 보태도 진행률이 100%를 넘지 않는다.
	const remaining = item.goal_amount - item.current_amount;
	const applied = Math.min(amount, Math.max(0, remaining));
	if (applied <= 0) return json({ error: "이미 목표금액을 달성한 아이템이에요" }, 400);

	if (body.from_user_id) await upsertUser(env, body.from_user_id, body.from_name || body.from_user_id, body.from_avatar || "😊");

	const contributionId = uid("c");
	const fromName = body.anonymous ? "익명" : body.from_name || "친구";
	const statements = [
		env.DB.prepare(`INSERT INTO contributions (id, wish_id, item_id, from_user_id, from_name, amount, message, anonymous) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
			contributionId,
			wishId,
			body.item_id,
			body.from_user_id || null,
			body.from_name || "친구",
			applied,
			(body.message || "").slice(0, 300),
			body.anonymous ? 1 : 0
		),
		env.DB.prepare(`UPDATE wish_items SET current_amount = current_amount + ? WHERE id = ?`).bind(applied, item.id),
	];

	// 위시 소유자(+ 단체 위시면 멤버 전원, 보낸 사람 본인은 제외)에게 알림을 남긴다.
	const notifyText = `${fromName}님이 "${wish.title} - ${item.name}"에 ${applied.toLocaleString()}원을 보탰어요`;
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
	return json({ ok: true, applied, itemId: item.id, newCurrentAmount: item.current_amount + applied });
}

// 위시 주인이 받은 후원(카카오페이로 보탠 금액)을 거절한다 - 기록을 지우고 그만큼 아이템
// 모금액에서 되돌린 뒤, 보낸 사람(있으면)에게 거절됐다고 알린다. 주인 본인 것만 처리 가능.
export async function handleRejectGift(request: Request, env: Env, wishId: string, contributionId: string): Promise<Response> {
	const userId = new URL(request.url).searchParams.get("user_id") || "";
	const wish = await env.DB.prepare(`SELECT owner_id, title FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string; title: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== userId) return json({ error: "권한이 없어요" }, 403);

	const contribution = await env.DB.prepare(`SELECT item_id, amount, from_user_id FROM contributions WHERE id = ? AND wish_id = ?`)
		.bind(contributionId, wishId)
		.first<{ item_id: string | null; amount: number; from_user_id: string | null }>();
	if (!contribution) return json({ error: "contribution not found" }, 404);

	const statements = [env.DB.prepare(`DELETE FROM contributions WHERE id = ?`).bind(contributionId)];
	if (contribution.item_id) {
		statements.push(env.DB.prepare(`UPDATE wish_items SET current_amount = MAX(0, current_amount - ?) WHERE id = ?`).bind(contribution.amount, contribution.item_id));
	}
	if (contribution.from_user_id && contribution.from_user_id !== wish.owner_id) {
		statements.push(
			env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'gift_rejected', ?, ?)`).bind(
				uid("n"),
				contribution.from_user_id,
				wishId,
				`"${wish.title}"에 보낸 ${contribution.amount.toLocaleString()}원 후원이 거절됐어요`
			)
		);
	}

	await env.DB.batch(statements);
	return json({ ok: true });
}
