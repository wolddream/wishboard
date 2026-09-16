export {};

declare global {
	interface Env {
		DB: D1Database;
		IMAGES: R2Bucket;
		KAKAO_CLIENT_SECRET?: string;
	}
}
