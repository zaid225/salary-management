# Swades Hackathon Backend

Fastify + TypeScript backend. MVC layout, Postgres (Drizzle) + MongoDB (Mongoose), Clerk auth, OpenRouter/Unsplash/Parallel API wrappers.

## Structure

```
src/
├── config/       # env schema (@fastify/env)
├── plugins/      # fastify plugins: db connections, cors, auth, third-party clients
├── models/       # postgres (drizzle) schemas + mongo (mongoose) models
├── controllers/  # request handlers
├── routes/       # route definitions, mounted in routes/index.ts
├── services/     # db helpers + external API clients (ai, media, data)
├── middlewares/  # error handler
└── server.ts     # entry point
```

## Run

```bash
npm install
cp .env.example .env   # fill in real keys/connection strings
npm run dev             # tsx watch
```

## Scripts

- `npm run dev` — watch mode
- `npm run build` / `npm start` — compile & run
- `npm run typecheck` — no-emit type check
- `npm run db:generate` / `db:migrate` / `db:push` / `db:studio` — Drizzle migrations
