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
 *   DELETE /api/wishes/:id/gift/:contributionId?user_id= -> reject a received contribution (owner only; refunds the item's total, notifies the giver)
 *   POST   /api/wishes/:id/gift/:contributionId/thanks -> owner sends a "thank you" notification to that contribution's giver
 *   POST   /api/wishes/:id/update      -> owner broadcasts a text update to followers + backers + group members (notifications only, no new table)
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
 *   DELETE /api/notifications/:id?user_id= -> delete one notification
 *   DELETE /api/notifications?user_id= -> delete all of a user's notifications
 *   POST   /api/upload                 -> upload a wish item photo (raw image bytes, content-type set) -> R2, returns its URL
 *   GET    /r2/:key                    -> serve an uploaded image back out of R2
 *   GET    /oauth/kakao/callback       -> Kakao OAuth code exchange (redirects back to frontend)
 *
 * Cron Trigger (wrangler.jsonc "triggers.crons", daily) -> handleDdaySoonCron: notifies owners
 * (+ group members) of wishes whose deadline is exactly 3 days away.
 *
 * Bindings (wrangler.jsonc): DB (D1), IMAGES (R2 bucket "wishboard-images" - create it once with
 * `wrangler r2 bucket create wishboard-images` before this deploys; no public-access toggle needed,
 * this worker serves uploaded images itself via GET /r2/:key)
 *
 * No real session auth: every endpoint trusts whatever user_id/name/avatar the client sends,
 * same trust model as keongyu-api. "친구" 관계 테이블은 없다 - keongyu의 공개 라우트 피드처럼,
 * 위시도 전체가 하나의 공유 피드다. Kakao login just picks the trusted user_id for the client
 * (kakao_<kakao id>) instead of a random anonymous one - it doesn't add a real session either.
 */
import "./types";
import { cors, json } from "./util";
import { handleGetWishes, handlePostWish, handleDeleteWish, handlePatchWish, handleAddWishItem, handlePatchWishItem, handleDeleteWishItem, handlePostGift, handleRejectGift, handleThankGift, handlePostWishUpdate, handleJoinWish, handleFollowWish, handleUnfollowWish, handleDdaySoonCron } from "./wishes";
import { handleGetUser, handlePatchUser } from "./users";
import { handleGetNotifications, handleMarkNotificationRead, handleDeleteNotification, handleDeleteAllNotifications } from "./notifications";
import { handleKakaoCallback } from "./kakao";
import { handleGetChat, handlePostChat, handleDeleteChat } from "./chat";
import { handleUploadImage, handleServeImage } from "./upload";

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
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "gift" && segments.length === 4 && request.method === "POST") {
				return cors(await handlePostGift(request, env, segments[2]));
			}
			// /api/wishes/:id/gift/:contributionId
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "gift" && segments.length === 5 && request.method === "DELETE") {
				return cors(await handleRejectGift(request, env, segments[2], segments[4]));
			}
			// /api/wishes/:id/gift/:contributionId/thanks
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "gift" && segments[5] === "thanks" && request.method === "POST") {
				return cors(await handleThankGift(request, env, segments[2], segments[4]));
			}
			// /api/wishes/:id/update (owner broadcast to followers/backers/members)
			if (segments[0] === "api" && segments[1] === "wishes" && segments[3] === "update" && request.method === "POST") {
				return cors(await handlePostWishUpdate(request, env, segments[2]));
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
				return cors(await handlePostChat(request, env, segments[2], ctx));
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
			// /api/notifications?user_id= (전체 삭제) - /api/notifications/:id 보다 먼저 체크
			if (url.pathname === "/api/notifications" && request.method === "DELETE") {
				return cors(await handleDeleteAllNotifications(request, env));
			}
			// /api/notifications/:id/read
			if (segments[0] === "api" && segments[1] === "notifications" && segments[3] === "read" && request.method === "POST") {
				return cors(await handleMarkNotificationRead(env, segments[2]));
			}
			// /api/notifications/:id?user_id=
			if (segments[0] === "api" && segments[1] === "notifications" && segments.length === 3 && request.method === "DELETE") {
				return cors(await handleDeleteNotification(request, env, segments[2]));
			}
			if (url.pathname === "/api/upload" && request.method === "POST") {
				return cors(await handleUploadImage(request, env));
			}
			// /r2/:key - R2에 올린 이미지를 그대로 서빙
			if (segments[0] === "r2" && segments.length === 2 && request.method === "GET") {
				return cors(await handleServeImage(env, segments[1]));
			}
			if (url.pathname === "/oauth/kakao/callback") {
				return await handleKakaoCallback(request, env);
			}
		} catch (err) {
			return cors(json({ error: (err as Error).message }, 500));
		}

		return cors(new Response("Not found", { status: 404 }));
	},
	async scheduled(_event, env, ctx) {
		ctx.waitUntil(handleDdaySoonCron(env));
	},
} satisfies ExportedHandler<Env>;
