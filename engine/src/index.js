export {stormAnalysis, stormEdges, STORM_DEFAULTS} from "./storm.js";
export {Network, Switch, IpNode} from "./network.js";
export {ping, traceroute, udpRequest, dns} from "./apps.js";
export * from "./addr.js";
export * from "./spec.js";

import {registerNodeKeys} from "./spec.js";
registerNodeKeys("switch", ["stp", "vlans"]);   // spanning tree and VLAN settings (engine/src/stp.js, Switch in network.js)
