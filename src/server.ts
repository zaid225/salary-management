import closeWithGrace from "close-with-grace";
import { buildServer } from "./app.js";

async function start() {
  const app = await buildServer();

  closeWithGrace({ delay: 5000 }, async ({ err }) => {
    if (err) app.log.error({ err }, "closing due to error");
    await app.close();
  });

  const port = Number(app.config.PORT);
  if (!Number.isInteger(port)) {
    app.log.error({ PORT: app.config.PORT }, "PORT env var is not a valid integer");
    process.exit(1);
  }

  try {
    await app.listen({ host: app.config.HOST, port });
  } catch (err) {
    app.log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

start();
