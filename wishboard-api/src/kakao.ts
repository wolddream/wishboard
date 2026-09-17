import { toBase64Utf8, upsertUser } from "./util";

// Kakao OAuth (authorization code) redirect target - same server-side exchange flow as
// keongyu-api's handleKakaoCallback: Kakao.Auth.authorize() (full-page redirect to Kakao) ->
// Kakao redirects back here with ?code=... -> exchanged server-side (keeps any client secret off
// the client) -> redirect back to the frontend with the resulting profile in the URL hash, which
// index.html picks up on load.
//
// Wishboard's own Kakao Developers app (previously reused keongyu's key, which made shared
// KakaoTalk cards show "keongyu" as the sending app - that's controlled by the registered app,
// not this code).
const KAKAO_JS_KEY = "5e38652b6c0105e8d8461cd9f96c8e7f"; // public key, safe to hardcode - matches index.html

export async function handleKakaoCallback(request: Request, env: Env): Promise<Response> {
	const url = new URL(request.url);
	const code = url.searchParams.get("code");
	const errorParam = url.searchParams.get("error");
	const frontendOrigin = url.searchParams.get("state")
		? decodeURIComponent(url.searchParams.get("state") as string)
		: "https://wishboard-app.wolddream.workers.dev";
	const redirectUri = `${url.origin}/oauth/kakao/callback`;

	// frontendOrigin은 로그인 게이트 때문에 이제 쿼리스트링(예: ?join=...)까지 그대로 들고 올 수
	// 있다 - 문자열을 그냥 이어붙이면(`${frontendOrigin}/#...`) 그 쿼리값 끝에 "/"가 붙어버려
	// join id가 깨진다. URL 객체로 만들어 hash만 정확히 붙인다.
	const withLoginHash = (payload: unknown) => {
		const dest = new URL(frontendOrigin);
		dest.hash = `kakao_login=${encodeURIComponent(toBase64Utf8(payload))}`;
		return dest.toString();
	};

	const fail = (reason: string, detail?: unknown) => Response.redirect(withLoginHash({ error: reason, detail }), 302);

	if (errorParam || !code) return fail(errorParam || "no_code");

	try {
		const tokenBody = new URLSearchParams({
			grant_type: "authorization_code",
			client_id: KAKAO_JS_KEY,
			redirect_uri: redirectUri,
			code,
		});
		if (env.KAKAO_CLIENT_SECRET) tokenBody.set("client_secret", env.KAKAO_CLIENT_SECRET);

		const tokenRes = await fetch("https://kauth.kakao.com/oauth/token", {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded;charset=utf-8" },
			body: tokenBody,
		});
		const tokenData = (await tokenRes.json()) as {
			access_token?: string;
			expires_in?: number;
			error?: string;
			error_description?: string;
		};
		if (!tokenData.access_token) {
			return fail("token_exchange_failed", { status: tokenRes.status, error: tokenData.error, description: tokenData.error_description });
		}

		const profileRes = await fetch("https://kapi.kakao.com/v2/user/me", {
			headers: { Authorization: `Bearer ${tokenData.access_token}` },
		});
		const profile = (await profileRes.json()) as {
			id: number;
			kakao_account?: { email?: string; profile?: { nickname?: string; profile_image_url?: string } };
			properties?: { nickname?: string; profile_image?: string };
		};
		const account = profile.kakao_account || {};
		const p = account.profile || profile.properties || {};
		const nickname = p.nickname || "카카오유저";
		const profileImage = (p as { profile_image_url?: string; profile_image?: string }).profile_image_url || (p as { profile_image?: string }).profile_image || null;
		const userId = `kakao_${profile.id}`;

		// wishes/gifts already reference user_id everywhere - upsert here so a Kakao login
		// immediately shows the right name/avatar to other users (e.g. in a gift notification),
		// without waiting on the client's own opportunistic PATCH /api/users.
		await upsertUser(env, userId, nickname, "😊");

		const payload = {
			id: profile.id,
			userId,
			nickname,
			email: account.email || null,
			profileImage,
			accessToken: tokenData.access_token,
			expiresIn: tokenData.expires_in || null,
		};
		return Response.redirect(withLoginHash(payload), 302);
	} catch (err) {
		return fail("exchange_error", (err as Error).message);
	}
}
