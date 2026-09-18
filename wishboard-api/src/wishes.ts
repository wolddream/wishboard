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
	is_private: number;
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
	pledge: string | null;
	goal_amount: number;
	current_amount: number;
	goal_type: string;
	goal_count: number | null;
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
	thanked_at: string | null;
}
interface CommentRow {
	id: string;
	wish_id: string;
	from_user_id: string | null;
	from_name: string;
	text: string;
	created_at: string;
}

// 아이템 하나의 진행률 - goal_type이 money면 그 아이템 자체의 금액을, hearts/comments면 이
// 위시 전체의 관심 등록 수/댓글 수를 공유해서 쓴다(아이템별로 따로 세지 않는다 - "하트 100개"
// 아이템이 여러 개라도 하트는 위시 하나에 대한 거라 실제로는 같은 수를 가리킨다).
function itemProgress(item: ItemRow, followerCount: number, commentCount: number) {
	const type = item.goal_type || "money";
	const current = type === "hearts" ? followerCount : type === "comments" ? commentCount : item.current_amount;
	const target = type === "money" ? item.goal_amount : item.goal_count || 0;
	const pct = target > 0 ? Math.min(100, Math.round((current / target) * 100)) : 0;
	return { type, current, target, pct };
}

// 위시 하나 = 아이템 여러 개로 이루어진 "위시 리스트"(예: 마라톤 대회 참가 위시 안에 런닝화,
// 유니폼 두 아이템). 예전엔 위시 전체가 목표 종류를 하나만 가졌는데, 아이템마다 다른 목표
// (예: 하나는 금액, 하나는 하트수)를 가질 수 있게 바뀌어서 카드에 보이는 "전체 진행률"은
// 아이템들의 진행률 %를 평균낸 값이다 - 아이템들이 전부 같은 종류면 그 종류 기준 합계를,
// 종류가 섞여있으면 평균 %와 "완료한 아이템 수"만 보여준다(단위가 다른 값은 못 더하니까).
function wishRowToClient(
	row: WishRow,
	members: MemberRow[],
	contributions: ContributionRow[],
	items: ItemRow[],
	followerCount: number,
	following: boolean,
	comments: CommentRow[]
) {
	const goalAmount = items.reduce((s, i) => s + i.goal_amount, 0);
	const currentAmount = items.reduce((s, i) => s + i.current_amount, 0);
	const itemProgresses = items.map((i) => itemProgress(i, followerCount, comments.length));
	const overallPct = itemProgresses.length ? Math.round(itemProgresses.reduce((s, p) => s + p.pct, 0) / itemProgresses.length) : 0;
	const uniqueTypes = new Set(itemProgresses.map((p) => p.type));
	const sameType = uniqueTypes.size <= 1;
	const wishProgress = sameType
		? {
				pct: overallPct,
				type: itemProgresses[0]?.type || "money",
				current: itemProgresses.reduce((s, p) => s + p.current, 0),
				target: itemProgresses.reduce((s, p) => s + p.target, 0),
		  }
		: {
				pct: overallPct,
				type: "mixed",
				completedItems: itemProgresses.filter((p) => p.pct >= 100).length,
				totalItems: itemProgresses.length,
		  };
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
		progress: wishProgress,
		followerCount,
		following,
		isPrivate: !!row.is_private,
		deadline: row.deadline,
		createdAt: row.created_at,
		comments: comments.map((c) => ({
			id: c.id,
			fromUserId: c.from_user_id,
			fromName: c.from_name,
			text: c.text,
			at: c.created_at,
		})),
		items: items.map((i, idx) => ({
			id: i.id,
			name: i.name,
			link: i.link || "",
			imageUrls: parseImageUrls(i.image_url),
			note: i.note || "",
			pledge: i.pledge || "",
			goalAmount: i.goal_amount,
			currentAmount: i.current_amount,
			goalType: i.goal_type || "money",
			goalCount: i.goal_count,
			progress: itemProgresses[idx],
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
			thanked: !!c.thanked_at,
		})),
	};
}

export async function handleGetWishes(env: Env, userId?: string | null): Promise<Response> {
	// owner_name/owner_avatar는 위시를 만들 당시의 스냅샷이라, 나중에 마이페이지에서 이름/아이콘을
	// 바꿔도 이미 만든 위시엔 반영이 안 됐다 - users 테이블(최신 정보)을 LEFT JOIN해서 있으면
	// 그 값을 우선 쓰고, 없으면(이론상 없을 일 없지만 방어적으로) 스냅샷으로 fallback한다.
	// 비공개(is_private) 위시는 만든 사람 본인에게만 보인다 - 전체가 하나의 공유 피드라는
	// 원칙의 유일한 예외라, 여기 한 곳에서만 걸러주면 된다(다른 사람 화면엔 아예 안 실려 온다).
	const { results: wishRows } = await env.DB.prepare(
		`SELECT w.id as id, w.owner_id as owner_id, COALESCE(u.name, w.owner_name) as owner_name,
		        COALESCE(u.avatar, w.owner_avatar) as owner_avatar, w.type as type, w.group_name as group_name,
		        w.title as title, w.subtitle as subtitle, w.story as story, w.emoji as emoji, w.category as category,
		        w.deadline as deadline, w.is_private as is_private, w.created_at as created_at
		 FROM wishes w
		 LEFT JOIN users u ON u.id = w.owner_id
		 WHERE w.is_private = 0 OR w.owner_id = ?
		 ORDER BY w.created_at DESC LIMIT 200`
	)
		.bind(userId || "")
		.all<WishRow>();

	if (wishRows.length === 0) return json({ wishes: [] });
	const ids = wishRows.map((w) => w.id);
	const placeholders = ids.map(() => "?").join(",");

	const [{ results: memberRows }, { results: contribRows }, { results: itemRows }, { results: followCountRows }, { results: myFollowRows }, { results: commentRows }] = await Promise.all([
		env.DB.prepare(
			`SELECT wm.wish_id as wish_id, wm.user_id as user_id, COALESCE(u.name, wm.user_name) as user_name,
			        COALESCE(u.avatar, wm.user_avatar) as user_avatar
			 FROM wish_members wm
			 LEFT JOIN users u ON u.id = wm.user_id
			 WHERE wm.wish_id IN (${placeholders})`
		)
			.bind(...ids)
			.all<MemberRow>(),
		env.DB.prepare(`SELECT id, wish_id, item_id, from_user_id, from_name, amount, message, anonymous, created_at, thanked_at FROM contributions WHERE wish_id IN (${placeholders}) ORDER BY created_at DESC`)
			.bind(...ids)
			.all<ContributionRow>(),
		env.DB.prepare(`SELECT id, wish_id, name, link, image_url, note, pledge, goal_amount, current_amount, goal_type, goal_count FROM wish_items WHERE wish_id IN (${placeholders}) ORDER BY sort_order, created_at`)
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
		env.DB.prepare(`SELECT id, wish_id, from_user_id, from_name, text, created_at FROM wish_comments WHERE wish_id IN (${placeholders}) ORDER BY created_at ASC`)
			.bind(...ids)
			.all<CommentRow>(),
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
	const commentsByWish = new Map<string, CommentRow[]>();
	for (const c of commentRows) {
		if (!commentsByWish.has(c.wish_id)) commentsByWish.set(c.wish_id, []);
		commentsByWish.get(c.wish_id)!.push(c);
	}

	const wishes = wishRows.map((w) =>
		wishRowToClient(
			w,
			membersByWish.get(w.id) || [],
			contribByWish.get(w.id) || [],
			itemsByWish.get(w.id) || [],
			followCountByWish.get(w.id) || 0,
			myFollowSet.has(w.id),
			commentsByWish.get(w.id) || []
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
		is_private?: boolean;
		items?: Array<{ name?: string; link?: string; image_urls?: string[]; note?: string; pledge?: string; goal_amount?: number; goal_type?: string; goal_count?: number }>;
	};
	// 목표 종류(금액/하트수/댓글수)는 위시 전체가 아니라 아이템별로 고른다 - 금액 아이템은
	// 1,000원 이상, 하트/댓글 아이템은 목표 개수 1개 이상이 있어야 유효한 아이템으로 친다.
	const items = (body.items || []).filter((i) => {
		if (!i || !i.name || !i.name.trim()) return false;
		const type = i.goal_type === "hearts" || i.goal_type === "comments" ? i.goal_type : "money";
		return type === "money" ? Number(i.goal_amount) >= 1000 : Number(i.goal_count) >= 1;
	});
	if (!body.owner_id || !body.title || !body.deadline || items.length === 0) {
		return json({ error: "owner_id, title, deadline, items(최소 1개, 이름+목표 필요) are required" }, 400);
	}
	const isGroup = body.type === "group";
	const wishId = uid("w");

	await upsertUser(env, body.owner_id, body.owner_name || body.owner_id, body.owner_avatar || "😊");

	// wishes.goal_amount/current_amount는 이제 실제로 쓰이지 않는다(진행률은 매번 아이템
	// 합계로 계산한다) - 다만 그 두 컬럼이 여전히 NOT NULL이라, 값을 안 채우면 INSERT 자체가
	// SQLITE_CONSTRAINT_NOTNULL로 실패한다. 하트/댓글 목표 아이템은 금액이 의미 없어 1000을
	// 기술적 자리채움값으로 넣는다(화면엔 goal_type이 money일 때만 가격으로 노출된다).
	const itemGoalTypes = items.map((item) => (item.goal_type === "hearts" || item.goal_type === "comments" ? item.goal_type : "money"));
	const itemGoalAmounts = items.map((item, idx) => (itemGoalTypes[idx] === "money" ? Math.max(1000, Math.round(Number(item.goal_amount) || 1000)) : 1000));
	const itemGoalCounts = items.map((item, idx) => (itemGoalTypes[idx] === "money" ? null : Math.max(1, Math.round(Number(item.goal_count) || 1))));
	const totalGoal = itemGoalAmounts.reduce((s, g) => s + g, 0);

	const statements = [
		env.DB.prepare(
			`INSERT INTO wishes (id, owner_id, owner_name, owner_avatar, type, group_name, title, subtitle, story, emoji, category, goal_amount, current_amount, deadline, is_private)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
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
			body.deadline,
			body.is_private ? 1 : 0
		),
	];
	items.forEach((item, idx) => {
		statements.push(
			env.DB.prepare(
				`INSERT INTO wish_items (id, wish_id, name, link, image_url, note, pledge, goal_amount, current_amount, sort_order, goal_type, goal_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
			).bind(
				uid("i"),
				wishId,
				(item.name || "").trim().slice(0, 80),
				(item.link || "").trim().slice(0, 500),
				serializeImageUrls(item.image_urls),
				(item.note || "").trim().slice(0, 500),
				(item.pledge || "").trim().slice(0, 300),
				itemGoalAmounts[idx],
				idx,
				itemGoalTypes[idx],
				itemGoalCounts[idx]
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
	// 위저드로 새로 만들 땐 "며칠 후"로만 받아서 마감일이 과거가 될 수 없는데, 수정은 날짜를
	// 직접 골라 넣다 보니 이 방어가 빠져 있었다 - 과거로 바꾸면 "마감 지남" 상태로 고정돼버린다.
	const todayStr = new Date().toISOString().slice(0, 10);
	if (body.deadline < todayStr) return json({ error: "마감일은 오늘 이후로 설정해주세요" }, 400);

	await env.DB.prepare(`UPDATE wishes SET title = ?, subtitle = ?, story = ?, deadline = ? WHERE id = ?`)
		.bind(body.title, body.subtitle || "", body.story || "", body.deadline, wishId)
		.run();

	return json({ ok: true });
}

// 공개/비공개 토글 - 편집 폼 전체를 열지 않고 위시 상세에서 스위치 하나로 바로 켜고 끌 수
// 있게 별도 엔드포인트로 뺐다.
export async function handleSetWishVisibility(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as { user_id?: string; is_private?: boolean };
	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== body.user_id) return json({ error: "권한이 없어요" }, 403);

	await env.DB.prepare(`UPDATE wishes SET is_private = ? WHERE id = ?`)
		.bind(body.is_private ? 1 : 0, wishId)
		.run();

	return json({ ok: true });
}

// 이미 등록된 위시에 아이템을 하나 더 추가한다(예: "마라톤 대회 참가"에 나중에 "양말" 추가) -
// 기존 아이템/선물에는 손대지 않으므로 handlePatchWish와 달리 안전하게 언제든 가능하다.
export async function handleAddWishItem(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as {
		user_id?: string;
		name?: string;
		link?: string;
		image_urls?: string[];
		note?: string;
		pledge?: string;
		goal_amount?: number;
		goal_type?: string;
		goal_count?: number;
	};
	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== body.user_id) return json({ error: "아이템 추가 권한이 없어요" }, 403);
	const goalType = body.goal_type === "hearts" || body.goal_type === "comments" ? body.goal_type : "money";
	if (!body.name || !body.name.trim()) return json({ error: "아이템 이름이 필요해요" }, 400);
	if (goalType === "money" && !(Number(body.goal_amount) >= 1000)) {
		return json({ error: "아이템 이름과 1,000원 이상의 가격이 필요해요" }, 400);
	}
	if (goalType !== "money" && !(Number(body.goal_count) >= 1)) {
		return json({ error: "하트/댓글 목표는 1개 이상의 목표 개수가 필요해요" }, 400);
	}

	const { results: countRows } = await env.DB.prepare(`SELECT COUNT(*) as c FROM wish_items WHERE wish_id = ?`).bind(wishId).all<{ c: number }>();
	const sortOrder = countRows[0]?.c ?? 0;
	const itemId = uid("i");
	await env.DB.prepare(
		`INSERT INTO wish_items (id, wish_id, name, link, image_url, note, pledge, goal_amount, current_amount, sort_order, goal_type, goal_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
	)
		.bind(
			itemId,
			wishId,
			body.name.trim().slice(0, 80),
			(body.link || "").trim().slice(0, 500),
			serializeImageUrls(body.image_urls),
			(body.note || "").trim().slice(0, 500),
			(body.pledge || "").trim().slice(0, 300),
			goalType === "money" ? Math.max(1000, Math.round(Number(body.goal_amount))) : 1000,
			sortOrder,
			goalType,
			goalType === "money" ? null : Math.max(1, Math.round(Number(body.goal_count)))
		)
		.run();

	return json({ ok: true, id: itemId }, 201);
}

// 아이템 하나를 수정한다(이름/링크/이미지/가격) - owner만. 이미 모인 금액보다 가격을 낮출 수는
// 없다(handlePatchWish의 목표금액 보호와 같은 이유).
export async function handlePatchWishItem(request: Request, env: Env, wishId: string, itemId: string): Promise<Response> {
	const body = (await request.json()) as {
		user_id?: string;
		name?: string;
		link?: string;
		image_urls?: string[];
		note?: string;
		pledge?: string;
		goal_amount?: number;
		goal_type?: string;
		goal_count?: number;
	};
	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== body.user_id) return json({ error: "수정 권한이 없어요" }, 403);
	const item = await env.DB.prepare(`SELECT current_amount FROM wish_items WHERE id = ? AND wish_id = ?`).bind(itemId, wishId).first<{ current_amount: number }>();
	if (!item) return json({ error: "item not found" }, 404);
	if (!body.name || !body.name.trim()) return json({ error: "아이템 이름이 필요해요" }, 400);
	const goalType = body.goal_type === "hearts" || body.goal_type === "comments" ? body.goal_type : "money";
	if (goalType !== "money" && !(Number(body.goal_count) >= 1)) {
		return json({ error: "하트/댓글 목표는 1개 이상의 목표 개수가 필요해요" }, 400);
	}

	const goalAmount = goalType === "money" ? Math.max(item.current_amount, Math.round(Number(body.goal_amount) || item.current_amount || 1000)) : Math.max(item.current_amount, 1000);
	const goalCount = goalType === "money" ? null : Math.max(1, Math.round(Number(body.goal_count)));
	await env.DB.prepare(`UPDATE wish_items SET name = ?, link = ?, image_url = ?, note = ?, pledge = ?, goal_amount = ?, goal_type = ?, goal_count = ? WHERE id = ?`)
		.bind(
			body.name.trim().slice(0, 80),
			(body.link || "").trim().slice(0, 500),
			serializeImageUrls(body.image_urls),
			(body.note || "").trim().slice(0, 500),
			(body.pledge || "").trim().slice(0, 300),
			goalAmount,
			goalType,
			goalCount,
			itemId
		)
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

	const item = await env.DB.prepare(`SELECT id, name, goal_amount, current_amount, goal_type FROM wish_items WHERE id = ? AND wish_id = ?`)
		.bind(body.item_id, wishId)
		.first<{ id: string; name: string; goal_amount: number; current_amount: number; goal_type: string }>();
	if (!item) return json({ error: "item not found" }, 404);

	// goal_type이 money가 아닌 아이템의 goal_amount는 1000짜리 기술적 자리채움값이라(진행률은
	// 하트/댓글로 계산되니까), 그 값으로 선물 금액을 캡핑하면 자리채움값을 넘는 순간부터 선물이
	// 전부 막혀버린다("돈+하트/댓글 병행"이 깨진다) - money 아이템만 목표금액으로 캡핑한다.
	const isMoneyGoal = (item.goal_type || "money") === "money";
	// 목표금액을 넘는 만큼은 반영하지 않는다 - 클라이언트에도 같은 로직이 있지만, 서버가 최종
	// 진실이어야 여러 사람이 거의 동시에 보태도 진행률이 100%를 넘지 않는다.
	const remaining = isMoneyGoal ? item.goal_amount - item.current_amount : amount;
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
		// current_amount = current_amount + ?가 아니라 MIN(goal_amount, current_amount + ?)로 자체
		// 제한한다 - applied는 위에서 미리 읽어둔(그새 stale해질 수 있는) current_amount로 계산했으니,
		// 두 사람이 거의 동시에 거의 다 찬 아이템에 보태면 둘 다 "여유 있음"으로 계산해 목표치를
		// 넘길 수 있다. UPDATE 시점의 실제(라이브) current_amount 기준으로 다시 한번 잘라내야
		// D1이 요청을 순서대로 처리해도 절대 목표금액을 못 넘는다. money 아이템만 해당 - 하트/
		// 댓글 아이템은 goal_amount가 자리채움값이라 그걸로 캡핑하면 안 된다.
		isMoneyGoal
			? env.DB.prepare(`UPDATE wish_items SET current_amount = MIN(goal_amount, current_amount + ?) WHERE id = ? RETURNING current_amount`).bind(applied, item.id)
			: env.DB.prepare(`UPDATE wish_items SET current_amount = current_amount + ? WHERE id = ? RETURNING current_amount`).bind(applied, item.id),
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

	const results = await env.DB.batch<{ current_amount: number }>(statements);
	// results[1]은 위 UPDATE...RETURNING 문의 결과 - 동시 요청으로 실제 반영량이 applied보다
	// 작게 잘렸더라도(위 주석 참고) 여기서 진짜 DB 값을 돌려준다.
	const newCurrentAmount = results[1]?.results?.[0]?.current_amount ?? item.current_amount + applied;
	return json({ ok: true, applied, itemId: item.id, newCurrentAmount });
}

// 위시 주인이 받은 후원(카카오페이로 보탠 금액)을 거절한다 - 기록을 지우고 그만큼 아이템
// 모금액에서 되돌린 뒤, 보낸 사람(있으면)에게 거절됐다고 알린다. 주인 본인 것만 처리 가능.
export async function handleRejectGift(request: Request, env: Env, wishId: string, contributionId: string): Promise<Response> {
	const userId = new URL(request.url).searchParams.get("user_id") || "";
	const wish = await env.DB.prepare(`SELECT owner_id, title FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string; title: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);

	const contribution = await env.DB.prepare(`SELECT item_id, amount, from_user_id, from_name FROM contributions WHERE id = ? AND wish_id = ?`)
		.bind(contributionId, wishId)
		.first<{ item_id: string | null; amount: number; from_user_id: string | null; from_name: string }>();
	if (!contribution) return json({ error: "contribution not found" }, 404);

	// 위시 주인(받은 걸 거절)이거나, 보낸 사람 본인(마이페이지 "보낸 선물 히스토리"에서 자기가
	// 보낸 걸 취소)이어야 한다.
	const isOwner = wish.owner_id === userId;
	const isSender = !!contribution.from_user_id && contribution.from_user_id === userId;
	if (!isOwner && !isSender) return json({ error: "권한이 없어요" }, 403);

	const statements = [env.DB.prepare(`DELETE FROM contributions WHERE id = ?`).bind(contributionId)];
	if (contribution.item_id) {
		statements.push(env.DB.prepare(`UPDATE wish_items SET current_amount = MAX(0, current_amount - ?) WHERE id = ?`).bind(contribution.amount, contribution.item_id));
	}
	if (isOwner && contribution.from_user_id && contribution.from_user_id !== wish.owner_id) {
		statements.push(
			env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'gift_rejected', ?, ?)`).bind(
				uid("n"),
				contribution.from_user_id,
				wishId,
				`"${wish.title}"에 보낸 ${contribution.amount.toLocaleString()}원 후원이 거절됐어요`
			)
		);
	}
	// 보낸 사람이 스스로 취소한 경우엔 반대로 주인에게 알려준다 - 모금액이 갑자기 줄어든
	// 이유를 알 수 있게.
	if (isSender && wish.owner_id !== userId) {
		statements.push(
			env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'gift_rejected', ?, ?)`).bind(
				uid("n"),
				wish.owner_id,
				wishId,
				`${contribution.from_name}님이 "${wish.title}"에 보냈던 ${contribution.amount.toLocaleString()}원 후원을 취소했어요`
			)
		);
	}

	await env.DB.batch(statements);
	return json({ ok: true });
}

// 위시 주인이 받은 후원 하나하나에 "고마워요"를 보낸다 - Zola의 땡큐노트 개념을 가볍게
// 옮긴 것으로, 이미 지웠다 되돌리는 거절과 달리 여기는 상태를 DB에 남기지 않는다(중복
// 전송 방지는 클라이언트에서 세션 동안만 막아준다 - 스키마 변경 없이 가려던 선택).
export async function handleThankGift(request: Request, env: Env, wishId: string, contributionId: string): Promise<Response> {
	const body = (await request.json()) as { user_id?: string };
	const wish = await env.DB.prepare(`SELECT owner_id, title FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string; title: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== body.user_id) return json({ error: "권한이 없어요" }, 403);

	const contribution = await env.DB.prepare(`SELECT from_user_id, thanked_at FROM contributions WHERE id = ? AND wish_id = ?`)
		.bind(contributionId, wishId)
		.first<{ from_user_id: string | null; thanked_at: string | null }>();
	if (!contribution) return json({ error: "contribution not found" }, 404);
	// 세션에만 남기던 "이미 보냈는지"를 서버에 영구 기록한다 - 새로고침해도 다시 누를 수 있게
	// 보이던(그래서 중복 알림이 갈 수 있던) 문제를 없앤다.
	if (contribution.thanked_at) return json({ ok: true, alreadyThanked: true });
	if (!contribution.from_user_id || contribution.from_user_id === wish.owner_id) {
		await env.DB.prepare(`UPDATE contributions SET thanked_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(contributionId).run();
		return json({ ok: true });
	}

	await env.DB.batch([
		env.DB.prepare(`UPDATE contributions SET thanked_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(contributionId),
		env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'thank_you', ?, ?)`).bind(
			uid("n"),
			contribution.from_user_id,
			wishId,
			`"${wish.title}"에 보낸 후원에 고마움을 전했어요 💌`
		),
	]);

	return json({ ok: true });
}

// 위시 주인이 관심 등록한 사람 + 단체 멤버 + 한 번이라도 후원한 사람 전원에게 진행 상황을
// 한 번에 알린다(와디즈/텀블벅의 "업데이트" 개념) - 별도 게시물 테이블 없이 기존
// notifications을 그대로 재사용한다(채팅과 달리 "전체 공지"라 성격이 다르다).
export async function handlePostWishUpdate(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as { user_id?: string; message?: string };
	const message = (body.message || "").trim();
	if (!message) return json({ error: "message is required" }, 400);

	const wish = await env.DB.prepare(`SELECT owner_id, title, type FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string; title: string; type: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);
	if (wish.owner_id !== body.user_id) return json({ error: "권한이 없어요" }, 403);

	const recipients = new Set<string>();
	const { results: followers } = await env.DB.prepare(`SELECT user_id FROM wish_follows WHERE wish_id = ?`).bind(wishId).all<{ user_id: string }>();
	followers.forEach((r) => recipients.add(r.user_id));
	const { results: backers } = await env.DB.prepare(`SELECT DISTINCT from_user_id FROM contributions WHERE wish_id = ? AND from_user_id IS NOT NULL`).bind(wishId).all<{
		from_user_id: string;
	}>();
	backers.forEach((r) => recipients.add(r.from_user_id));
	if (wish.type === "group") {
		const { results: members } = await env.DB.prepare(`SELECT user_id FROM wish_members WHERE wish_id = ?`).bind(wishId).all<{ user_id: string }>();
		members.forEach((r) => recipients.add(r.user_id));
	}
	recipients.delete(wish.owner_id);
	if (recipients.size === 0) return json({ ok: true, notified: 0 });

	const text = `"${wish.title}" 업데이트: ${message.slice(0, 200)}`;
	await env.DB.batch(
		Array.from(recipients).map((userId) =>
			env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'wish_update', ?, ?)`).bind(uid("n"), userId, wishId, text)
		)
	);
	return json({ ok: true, notified: recipients.size });
}

// goal_type='comments' 목표(예: "댓글 50개")를 위해 돈 없이도 남길 수 있는 댓글 - 기존
// "응원 방명록"은 선물(contributions)의 message라 돈을 안 보태면 댓글을 못 남겼다. 별도
// 테이블에 쌓고, 프론트에서 선물 메시지와 시간순으로 합쳐 하나의 방명록처럼 보여준다.
export async function handlePostWishComment(request: Request, env: Env, wishId: string): Promise<Response> {
	const body = (await request.json()) as { user_id?: string; name?: string; avatar?: string; text?: string };
	const text = (body.text || "").trim();
	if (!text) return json({ error: "댓글 내용을 입력해주세요" }, 400);

	const wish = await env.DB.prepare(`SELECT owner_id FROM wishes WHERE id = ?`).bind(wishId).first<{ owner_id: string }>();
	if (!wish) return json({ error: "wish not found" }, 404);

	if (body.user_id) await upsertUser(env, body.user_id, body.name || body.user_id, body.avatar || "😊");

	const commentId = uid("cm");
	await env.DB.prepare(`INSERT INTO wish_comments (id, wish_id, from_user_id, from_name, text) VALUES (?, ?, ?, ?, ?)`)
		.bind(commentId, wishId, body.user_id || null, body.name || "친구", text.slice(0, 300))
		.run();

	// 이미 예약돼있던 알림 타입(cheer_comment)을 그대로 쓴다 - 자기 위시에 자기가 남긴 댓글은
	// 알림을 안 보낸다.
	if (body.user_id && body.user_id !== wish.owner_id) {
		await env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'cheer_comment', ?, ?)`)
			.bind(uid("n"), wish.owner_id, wishId, `${body.name || "친구"}님이 댓글을 남겼어요: ${text.slice(0, 80)}`)
			.run();
	}

	return json({ ok: true, id: commentId }, 201);
}

// 댓글 삭제 - 채팅 메시지와 같은 신뢰 모델(작성자 본인만).
export async function handleDeleteWishComment(request: Request, env: Env, wishId: string, commentId: string): Promise<Response> {
	const userId = new URL(request.url).searchParams.get("user_id") || "";
	const comment = await env.DB.prepare(`SELECT from_user_id FROM wish_comments WHERE id = ? AND wish_id = ?`).bind(commentId, wishId).first<{ from_user_id: string | null }>();
	if (!comment) return json({ error: "comment not found" }, 404);
	if (!comment.from_user_id || comment.from_user_id !== userId) return json({ error: "삭제 권한이 없어요" }, 403);

	await env.DB.prepare(`DELETE FROM wish_comments WHERE id = ?`).bind(commentId).run();
	return json({ ok: true });
}

// Cron Trigger(매일 1회)로 호출된다 - 마감이 정확히 3일 남은 위시를 찾아 주인(+ 단체 위시면
// 멤버 전원)에게 dday_soon 알림을 보낸다. "정확히 3일"로만 매칭해서 하루에 한 번만 걸리게
// 하고, 이미 보냈는지 따로 기록해둘 컬럼 없이도 중복 발송을 피한다.
export async function handleDdaySoonCron(env: Env): Promise<void> {
	const target = new Date();
	target.setUTCDate(target.getUTCDate() + 3);
	const targetDeadline = target.toISOString().slice(0, 10);

	const { results: wishes } = await env.DB.prepare(`SELECT id, owner_id, title, type FROM wishes WHERE deadline = ?`)
		.bind(targetDeadline)
		.all<{ id: string; owner_id: string; title: string; type: string }>();
	if (!wishes.length) return;

	const statements = [];
	for (const w of wishes) {
		const text = `"${w.title}" 마감이 3일 남았어요!`;
		const recipients = new Set<string>([w.owner_id]);
		if (w.type === "group") {
			const { results: members } = await env.DB.prepare(`SELECT user_id FROM wish_members WHERE wish_id = ?`).bind(w.id).all<{ user_id: string }>();
			members.forEach((m) => recipients.add(m.user_id));
		}
		recipients.forEach((userId) => {
			statements.push(env.DB.prepare(`INSERT INTO notifications (id, user_id, type, wish_id, text) VALUES (?, ?, 'dday_soon', ?, ?)`).bind(uid("n"), userId, w.id, text));
		});
	}
	if (statements.length) await env.DB.batch(statements);
}
