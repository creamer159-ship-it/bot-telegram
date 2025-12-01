# Repository Guidelines

## Project Structure & Module Organization
Source lives in `src/index.ts`, which wires the Telegraf bot, cron scheduler, and shutdown hooks. Compiled assets are emitted to `dist/` by TypeScript (see `tsconfig.json`). Environment variables are loaded via `.env` using `dotenv/config`; keep secrets out of version control and document required keys (e.g., `BOT_TOKEN`) alongside any new module you add.

## Build, Test, and Development Commands
- `npm run dev` starts the bot with `tsx`, giving instant reloads for `.ts` edits.
- `npm run build` transpiles TypeScript into `dist/` using `tsc`; run it before packaging or deploying.
- `npm start` executes the compiled bot via Node.js and mirrors the production entry point.
- `npm test` currently fails intentionally; replace it with the real suite once tests are introduced so CI can block regressions.

## Coding Style & Naming Conventions
Use modern TypeScript with ES module syntax (`import`/`export`). Prefer `const` and arrow functions for handlers, mirroring `src/index.ts`. Keep indentation at two spaces, wrap long bot replies at ~100 columns, and name cron helpers or middleware with `camelCase` verbs (`registerDailyReminder`). Run `npm run build` to ensure the compiler catches typing issues whenever you touch bot logic.

## Testing Guidelines
There is no automated suite yet; plan for a lightweight test harness (e.g., Vitest) that can mock Telegraf contexts. Name files `*.spec.ts` and colocate them with the code they verify (`src/scheduler.spec.ts`). When adding tests, cover both command-parsing branches and failure modes (missing env, invalid cron) and update `npm test` to execute the suite. Target high-value branches first so CI stays fast (<1 minute).

## Commit & Pull Request Guidelines
With no history yet, adopt Conventional Commits (`feat: add scheduler command`, `fix: handle invalid cron`). Keep commits scoped to a single concern and mention env/config changes explicitly. Pull requests should include: purpose summary, manual/automated test evidence (`npm run build`, future `npm test`), any screenshots for bot output, and linked issue/task IDs when available.

## Security & Configuration Tips
Never commit `.env`; create `.env.example` entries when introducing new secrets. Rotate the Telegram token used in development if it was ever logged. Before deployment, confirm the process environment defines `BOT_TOKEN` and that cron expressions supplied by users are validated to avoid runaway jobs.
