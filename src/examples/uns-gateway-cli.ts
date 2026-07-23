import { startUnsGateway } from "@uns-kit/core/uns-grpc/uns-gateway-server.js";

const addr = await startUnsGateway();
console.log(`UNS Gateway listening on ${addr.address} (UDS=${addr.isUDS})`);
// Keep alive
setInterval(() => {}, 1 << 30);
