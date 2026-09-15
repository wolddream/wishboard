export {};

declare global {
	interface Env {
		DB: D1Database;
		KAKAO_CLIENT_SECRET?: string;
	}
}
