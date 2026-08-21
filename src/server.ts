import closeWithGrace from "close-with-grace";
import { buildServer } from "./app.js";

async function start() {
  const app = await buildServer();

  closeWithGrace({ delay: 5000 }, async ({ err }) => {
    if (err) app.log.error({ err }, "closing due to error");
    await app.close();
  });

  try {
    await app.listen({ host: app.config.HOST, port: app.config.PORT });
  } catch (err) {
    app.log.error({ err }, "failed to start server");
    process.exit(1);
  }
}

start();
