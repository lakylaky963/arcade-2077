// Adapted from colyseus/turnbased-cards-demo (server/src/app.config.ts), MIT,
// Copyright (c) 2026 Endel Dreyer. See ../LICENSE-turnbased-cards-demo.
// Changed: room name `wildcard`, a /healthz endpoint, and the playground and
// monitor (which the demo mounts on /) only when ENABLE_DEBUG_UI=1, because
// this server is reachable from the internet through the arcade.

import { defineServer, defineRoom, playground, monitor } from "colyseus";
import { WildcardRoom } from "./rooms/WildcardRoom.ts";

export default defineServer({
  rooms: {
    wildcard: defineRoom(WildcardRoom),
  },
  express: (app) => {
    app.get("/healthz", (_req: unknown, res: { json(body: unknown): void }) => {
      res.json({ ok: true, game: "wildcard" });
    });
    if (process.env.ENABLE_DEBUG_UI === "1") {
      app.use("/", playground());
      app.use("/monitor", monitor());
    }
  },
});
