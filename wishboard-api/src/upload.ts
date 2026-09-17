import { json, uid } from "./util";

const MAX_BYTES = 15 * 1024 * 1024; // 15MB - 요즘 휴대폰 카메라 원본 사진은 5MB를 쉽게 넘는다
const ALLOWED_TYPES: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
};

// 위시 아이템 사진을 R2에 저장한다 - 파일 바이트를 그대로 요청 본문에 담아 보내면(멀티파트가
// 아니라) 받은 그대로 저장하고, 이 워커 자신이 서빙하는 URL을 돌려준다. R2 버킷 자체를
// public으로 열 필요가 없어 별도 도메인/설정 없이도 바로 동작한다.
export async function handleUploadImage(request: Request, env: Env): Promise<Response> {
	const contentType = (request.headers.get("content-type") || "").split(";")[0].trim();
	const ext = ALLOWED_TYPES[contentType];
	if (!ext) return json({ error: "jpeg/png/webp/gif 이미지만 올릴 수 있어요" }, 400);

	const buf = await request.arrayBuffer();
	if (buf.byteLength === 0) return json({ error: "빈 파일이에요" }, 400);
	if (buf.byteLength > MAX_BYTES) return json({ error: "이미지는 5MB 이하로 올려주세요" }, 400);

	const key = `${uid("img")}.${ext}`;
	await env.IMAGES.put(key, buf, { httpMetadata: { contentType } });

	const url = new URL(request.url);
	return json({ ok: true, url: `${url.origin}/r2/${key}` }, 201);
}

export async function handleServeImage(env: Env, key: string): Promise<Response> {
	const obj = await env.IMAGES.get(key);
	if (!obj) return new Response("Not found", { status: 404 });
	const headers = new Headers();
	obj.writeHttpMetadata(headers);
	headers.set("etag", obj.httpEtag);
	headers.set("cache-control", "public, max-age=31536000, immutable");
	return new Response(obj.body, { headers });
}
