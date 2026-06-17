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

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_memory_namespace ON memory_entries(namespace);
    CREATE INDEX IF NOT EXISTS idx_studio_projects_folder ON studio_projects(folder);
  `);
  console.log('✅ Database schema ready');
}

export default pool;
