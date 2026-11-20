// Entry point. Configure the process-wide services from the environment, then
// start Colyseus. Environment variable NAMES (values live in the server's .env,
// never in this repo or in chat): see .env.example.

import { listen } from "@colyseus/tools";
import appConfig from "./app.config.ts";
import { configureRuntime, runtimeFromEnv } from "./runtime.ts";

configureRuntime(await runtimeFromEnv(process.env));

listen(appConfig);
