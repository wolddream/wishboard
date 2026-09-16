/**
 * WishBoard API Worker
 * (재배포 트리거용 주석 - 이전 커밋이 오랫동안 배포되지 않아 추가)
 *
 * Endpoints:
 *   GET    /api/wishes                 -> list all wishes (+ members, contributions)
 *   POST   /api/wishes                 -> create a wish (personal or group)
 *   DELETE /api/wishes/:id?user_id=    -> delete a wish (owner or group member only)
 *   PATCH  /api/wishes/:id             -> edit a wish's content (owner only)
 *   POST   /api/wishes/:id/items       -> add a new item to an existing wish (owner only)
 *   PATCH  /api/wishes/:id/items/:itemId -> edit one item (owner only, goal can't drop below what's raised)
 *   DELETE /api/wishes/:id/items/:itemId?user_id= -> delete one item (owner only; blocked if it has gifts, or is the last item)
 *   POST   /api/wishes/:id/gift        -> send a contribution (server caps at item's goal, fans out notifications)
 *   POST   /api/wishes/:id/join        -> join a group wish via its invite link (?join=id on the client)
 *   POST   /api/wishes/:id/follow      -> follow/favorite a wish
 *   DELETE /api/wishes/:id/follow?user_id= -> unfollow a wish
 *   GET    /api/wishes/:id/chat                -> the wish's shared chat room messages (1:N, everyone sees the same thread)
 *   POST   /api/wishes/:id/chat                -> send a chat message to the room
 *   DELETE /api/wishes/:id/chat/:messageId?user_id= -> delete a message you sent
 *   GET    /api/users/:id              -> profile lookup (name/avatar)
 *   PATCH  /api/users/:id              -> update profile (name/avatar) - upserts
 *   GET    /api/notifications?user_id= -> a user's notifications
 *   POST   /api/notifications/:id/read -> mark one notification read
 *   GET    /oauth/kakao/callback       -> Kakao OAuth code exchange (redirects back to frontend)
 *
 * Bindings (wrangler.jsonc): DB (D1)
 *
 * No real session auth: every endpoint trusts whatever user_id/name/avatar the client sends,
 * same trust model as keongyu-api. "친구" 관계 테이블은 없다 - keongyu의 공개 라우트 피드처럼,
 * 위시도 전체가 하나의 공유 피드다. Kakao login just picks the trusted user_id for the client
 * (kakao_<kakao id>) instead of a random anonymous one - it doesn't add a real session either.
 */
import "./types";
import { cors, json } from "./util";
import { handleGetWishes, handlePostWish, handleDeleteWish, handlePatchWish, handleAddWishItem, handlePatchWishItem, handleDeleteWishItem, handlePostGift, handleJoinWish, handleFollowWish, handleUnfollowWish } from "./wishes";
import { handleGetUser, handlePatchUser } from "./users";
import { handleGetNotifications, handleMarkNotificationRead } from "./notifications";
import { handleKakaoCallback } from "./kakao";
import { handleGetChat, handlePostChat, handleDeleteChat } from "./chat";

export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.method === "OPTIONS") {
			return cors(new Response(null, { status: 204 }));
		}

		const url = new URL(request.url);
		const segments = url.pathname.split("/").filter(Boolean); // e.g. ["api","wishes","w_123","gift"]

		try {
			if (url.pathname === "/api/wishes" && request.method === "GET") {
				return cors(await handleGetWishes(env, url.searchParams.get("user_id")));
			}
			if (url.pathname === "/api/wishes" && request.method === "POST") {
				return cors(await handlePostWish(request, env));
			}
			// /api/wishes/:id
			if (segments[0] === "api" && segments[1] === "wishes" && segments.length === 3 && request.method === "DELETE") {
				return cors(await handleDeleteWish(request, env, segments[2]));
			}
			if (segments[0] === "api" && segments[1] === "wishes" && segments.length === 3 && request.method === "PATCH") {
				return cors(await handlePatchWish(request, env, segments[2]));
			}
			// /api/wishes/:id/items
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "items" && segments.length === 4 && request.method === "POST") {
				return cors(await handleAddWishItem(request, env, segments[2]));
			}
			// /api/wishes/:id/items/:itemId
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "items" && segments.length === 5 && request.method === "PATCH") {
				return cors(await handlePatchWishItem(request, env, segments[2], segments[4]));
			}
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "items" && segments.length === 5 && request.method === "DELETE") {
				return cors(await handleDeleteWishItem(request, env, segments[2], segments[4]));
			}
			// /api/wishes/:id/gift
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "gift" && request.method === "POST") {
				return cors(await handlePostGift(request, env, segments[2]));
			}
			// /api/wishes/:id/join
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "join" && request.method === "POST") {
				return cors(await handleJoinWish(request, env, segments[2]));
			}
			// /api/wishes/:id/follow
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "follow" && request.method === "POST") {
				return cors(await handleFollowWish(request, env, segments[2]));
			}
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "follow" && request.method === "DELETE") {
				return cors(await handleUnfollowWish(request, env, segments[2]));
			}
			// /api/wishes/:id/chat
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "chat" && segments.length === 4 && request.method === "GET") {
				return cors(await handleGetChat(request, env, segments[2]));
			}
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "chat" && segments.length === 4 && request.method === "POST") {
				return cors(await handlePostChat(request, env, segments[2]));
			}
			// /api/wishes/:id/chat/:messageId
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "chat" && segments.length === 5 && request.method === "DELETE") {
				return cors(await handleDeleteChat(request, env, segments[2], segments[4]));
			}
			// /api/users/:id
			if (segments[0] === "api" && segments[1] === "users" && segments.length === 3 && request.method === "GET") {
				return cors(await handleGetUser(env, segments[2]));
			}
			if (segments[0] === "api" && segments[1] === "users" && segments.length === 3 && request.method === "PATCH") {
				return cors(await handlePatchUser(request, env, segments[2]));
			}
			if (url.pathname === "/api/notifications" && request.method === "GET") {
				const userId = url.searchParams.get("user_id");
				if (!userId) return cors(json({ error: "user_id is required" }, 400));
				return cors(await handleGetNotifications(env, userId));
			}
			// /api/notifications/:id/read
			if (segments[0] === "api" && segments[1] === "notifications" && segments[3] === "read" && request.method === "POST") {
				return cors(await handleMarkNotificationRead(env, segments[2]));
			}
			if (url.pathname === "/oauth/kakao/callback") {
				return await handleKakaoCallback(request, env);
			}
		} catch (err) {
			return cors(json({ error: (err as Error).message }, 500));
		}

		return cors(new Response("Not found", { status: 404 }));
	},
} satisfies ExportedHandler<Env>;
