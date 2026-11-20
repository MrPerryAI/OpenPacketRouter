// The default command set: every definition file in this folder. Works in Node and in browsers (JSON modules).
// A host that wants fewer commands can pass its own list to createSession({definitions}).
import base from "./base.json" with {type: "json"};
import interfaces from "./interfaces.json" with {type: "json"};
import ipRouting from "./ip-routing.json" with {type: "json"};
import switching from "./switching.json" with {type: "json"};
import services from "./services.json" with {type: "json"};
import show from "./show.json" with {type: "json"};

export const DEFINITIONS = [base, interfaces, ipRouting, switching, services, show];
