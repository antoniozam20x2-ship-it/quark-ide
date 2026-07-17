import pg from 'pg';
const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id        SERIAL PRIMARY KEY,
      key       TEXT NOT NULL,
      content   TEXT NOT NULL,
      namespace TEXT NOT NULL DEFAULT 'quark-ide',
      timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (key, namespace)
    );

    CREATE TABLE IF NOT EXISTS conversations (
      id         SERIAL PRIMARY KEY,
      title      TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              SERIAL PRIMARY KEY,
      conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
      role            TEXT NOT NULL,
      content         TEXT NOT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS projects (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT,
      context     JSONB DEFAULT '{}',
      updated_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS board_items (
      id          SERIAL PRIMARY KEY,
      column_name TEXT NOT NULL,
      content     TEXT NOT NULL,
      position    INTEGER DEFAULT 0,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS editor_state (
      id SERIAL PRIMARY KEY,
      project_id TEXT NOT NULL UNIQUE,
      files JSONB NOT NULL DEFAULT '[]',
      active_file_name TEXT,
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS studio_projects (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      folder     TEXT NOT NULL DEFAULT 'Sin carpeta',
      html       TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS audit_history (
      audit_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      repo_name   VARCHAR(100) NOT NULL,
      audit_date  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      recommendations TEXT[] NOT NULL,
      status      VARCHAR(20) NOT NULL DEFAULT 'pending',
      review_date TIMESTAMPTZ NOT NULL,
      verdict     TEXT,
      results     TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS smart_read_log (
      id            BIGSERIAL PRIMARY KEY,
      session_id    TEXT        NOT NULL,
      repo          TEXT        NOT NULL,
      path          TEXT        NOT NULL,
      decision      TEXT        NOT NULL,     -- full | cached | diff | skeleton
      http_status   SMALLINT    NOT NULL,     -- 200 (new content) or 304 (not modified)
      tokens_before INT         NOT NULL,
      tokens_after  INT         NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_smart_read_log_session ON smart_read_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_smart_read_log_repo    ON smart_read_log(repo, created_at);

    CREATE TABLE IF NOT EXISTS symbol_index (
      id          BIGSERIAL PRIMARY KEY,
      repo        TEXT        NOT NULL,
      symbol_name TEXT        NOT NULL,
      file_path   TEXT        NOT NULL,
      line_number INTEGER     NOT NULL,
      symbol_type TEXT        NOT NULL DEFAULT 'unknown',
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS repo_sync_log (
      repo          TEXT        PRIMARY KEY,
      synced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      files_changed INTEGER     NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_symbol_index_repo_name ON symbol_index(repo, symbol_name);
    CREATE INDEX IF NOT EXISTS idx_symbol_index_repo_file ON symbol_index(repo, file_path);

    CREATE INDEX IF NOT EXISTS idx_audit_history_repo ON audit_history(repo_name);
    CREATE INDEX IF NOT EXISTS idx_audit_history_review_date ON audit_history(review_date);
    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace);
    CREATE INDEX IF NOT EXISTS idx_studio_projects_folder ON studio_projects(folder);
  `);
  console.log('✅ Database schema ready');
}

export default pool;
