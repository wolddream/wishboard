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

-- 위시 하나는 여러 개의 아이템으로 이루어진 "위시 리스트"다(예: 마라톤 대회 참가 위시 안에
-- 런닝화, 유니폼 두 아이템). 목표금액/모금액/선물은 전부 아이템 단위로 매겨지고, 위시 카드에
-- 보이는 전체 진행률은 이 아이템들의 합계를 그때그때 계산해서 보여준다.
CREATE TABLE IF NOT EXISTS wish_items (
  id TEXT PRIMARY KEY,
  wish_id TEXT NOT NULL,
  name TEXT NOT NULL,
  link TEXT,
  image_url TEXT,
  note TEXT, -- 이 아이템을 왜 원하는지/선정 배경 (선택)
  goal_amount INTEGER NOT NULL,
  current_amount INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_wish_items_wish ON wish_items(wish_id);

CREATE TABLE IF NOT EXISTS contributions (
  id TEXT PRIMARY KEY,
  wish_id TEXT NOT NULL,
  item_id TEXT,
  from_user_id TEXT,
  from_name TEXT NOT NULL,
  amount INTEGER NOT NULL,
  message TEXT,
  anonymous INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_contributions_wish ON contributions(wish_id, created_at);
CREATE INDEX IF NOT EXISTS idx_contributions_item ON contributions(item_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL, -- 'gift_arrived' | 'dday_soon' | 'cheer_comment' | 'chat_message'
  wish_id TEXT,
  text TEXT NOT NULL,
  is_read INTEGER DEFAULT 0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at);

-- 위시 하나당 대화방 하나(1:N) - 위시 주인과 관심 있는 사람들이 모두 같은 방에서 대화한다.
-- peer_id는 예전 1:1 스레드 구조의 흔적으로, 항상 owner_id를 채워 넣기만 하고 더는 쓰이지 않는다.
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  wish_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  peer_id TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  from_name TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_chat_thread ON chat_messages(wish_id, peer_id, created_at);

-- 위시 하나를 여러 사람이 "관심" 등록(찜/구독)할 수 있다 - 내가 만들지 않은 위시라도 마이페이지에
-- 모아보고 싶을 때 쓴다. 단순 다대다 관계라 별도 알림은 안 붙인다(그건 별개 기능).
CREATE TABLE IF NOT EXISTS wish_follows (
  wish_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (wish_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_wish_follows_user ON wish_follows(user_id);
