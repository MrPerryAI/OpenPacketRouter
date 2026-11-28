// Where the CLI finds the engine. In a repository checkout the engine sits next to the CLI; installed from npm it is
// the @openpacketrouter/engine dependency (which npm may place beside the CLI or inside its node_modules).
// Every engine module the CLI uses is loaded here, once, so the rest of the CLI imports from this file.
// No node: imports here: the Studio loads the CLI in a browser too, where the sibling path always resolves.

const load = (name) => import("../../engine/src/" + name).catch(() => import("@openpacketrouter/engine/src/" + name));

export const [addr, addr6, spec, yaml] = await Promise.all(["addr.js", "addr6.js", "spec.js", "yaml.js"].map(load));
