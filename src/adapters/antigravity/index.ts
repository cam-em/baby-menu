import { runAdapter } from "../shared/acp-agent.js";
import { AntigravityDriver } from "./driver.js";

// acpx speaks ACP to this process; the driver speaks Antigravity stream-json to
// the installed, already-authenticated `agy` CLI in the exact ACP workspace.
runAdapter(new AntigravityDriver(), "antigravity-adapter");
