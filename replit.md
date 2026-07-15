# Quark IDE

An AI-powered browser IDE with a React/Monaco frontend and an Express backend. Integrates Claude (Anthropic), Gemini, and GitHub for AI-assisted coding, chat, war room planning, debugging, and code editing directly against GitHub repos.

## Stack

- **Frontend**: React 18, Vite, Tailwind CSS, Monaco Editor (`quark-ide/frontend/`)
- **Backend**: Node.js, Express, TypeScript (`quark-ide/backend/`)
- **AI**: Anthropic Claude SDK, Google Gemini
- **Database**: PostgreSQL (via `pg`)
- **GitHub integration**: `@octokit/rest`

## Running the app

```bash
bash start.sh
```

This installs dependencies for both backend and frontend (if needed), then starts both concurrently:
- Backend: `quark-ide/backend` on port 3001 (tsx watch)
- Frontend: `quark-ide/frontend` on port 5173 (Vite)

## Required secrets / environment variables

Set these in Replit Secrets or a `.env` file in `quark-ide/backend/`:

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Google Gemini API (required) |
| `ANTHROPIC_API_KEY` | Claude agent features |
| `GITHUB_TOKEN` | Read/commit to GitHub repos |
| `DATABASE_URL` | PostgreSQL connection string |
| `PORT` | Backend port (default: 3001) |
| `FRONTEND_URL` | CORS origin (default: http://localhost:5173) |

## Project structure

```
quark-ide/
  backend/src/
    routes/       # Express routes (chat, warroom, editor, agent, etc.)
    services/     # GitHub, Gemini, DB, cost tracker, debugger, etc.
  frontend/src/
    pages/        # AgentPage, EditorPage, WarRoomPage, DebuggerPage, etc.
    components/   # Layout, Agent, etc.
```

## User preferences

_None recorded yet._
