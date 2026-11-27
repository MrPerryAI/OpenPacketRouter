// Where the CLI finds the engine. In a repository checkout the engine sits next to the CLI; installed from npm it is
// the @openpacketrouter/engine dependency (which npm may place beside the CLI or inside its node_modules).
// Every engine module the CLI uses is loaded here, once, so the rest of the CLI imports from this file.
import {existsSync} from "node:fs";

const sibling = new URL("../../engine/src/", import.meta.url);
const load = (name) => existsSync(new URL(name, sibling))
  ? import(new URL(name, sibling).href)
  : import("@openpacketrouter/engine/src/" + name);

export const [addr, addr6, spec, yaml] = await Promise.all(["addr.js", "addr6.js", "spec.js", "yaml.js"].map(load));
