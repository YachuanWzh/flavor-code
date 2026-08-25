import { runPalBroker } from "./broker-cli.js";

const address = process.argv[2];
if (address === undefined || address.length === 0 || address.length > 32_768 || address.includes("\0")) {
  throw new Error("A valid local pals broker address is required");
}

const broker = await runPalBroker({ address });
const close = () => { void broker.close(); };
process.once("SIGINT", close);
process.once("SIGTERM", close);
await broker.closed;
