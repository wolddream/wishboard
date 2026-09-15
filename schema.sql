-- 위시보드 D1 스키마. keongyu의 "실 서버 없이 로그인만 익명" 신뢰 모델을 그대로 따른다 -
-- 클라이언트가 보내는 user_id/name/avatar를 그대로 믿고, 별도 세션/비밀번호 인증은 없다.
-- "친구" 관계 테이블은 두지 않았다 - keongyu의 routes가 전체 공개 피드인 것처럼, 위시도
-- 전체가 하나의 공유 피드다(친구 그래프를 새로 만드는 대신 이미 있는 패턴을 재사용).

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  avatar TEXT DEFAULT '😊',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wishes (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  owner_avatar TEXT,
  type TEXT NOT NULL DEFAULT 'personal', -- 'personal' | 'group'
  group_name TEXT,
  title TEXT NOT NULL,
  subtitle TEXT,
  story TEXT,
  emoji TEXT,
  category TEXT,
  goal_amount INTEGER NOT NULL,
  current_amount INTEGER NOT NULL DEFAULT 0,
  deadline TEXT NOT NULL, -- YYYY-MM-DD
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wishes_created ON wishes(created_at);

-- 단체 위시의 멤버 목록 - 개인 위시는 이 테이블에 아무 행도 없다.
CREATE TABLE IF NOT EXISTS wish_members (
  wish_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL,
  user_avatar TEXT,
  PRIMARY KEY (wish_id, user_id)
);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  wish_id TEXT NOT NULL,
  from_user_id TEXT,
  from_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  message TEXT,
  anonymous INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contributions_wish ON contributions(wish_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL, -- 'gift_arrived' | 'dday_soon' | 'cheer_comment'
  wish_id TEXT,
  text TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);
