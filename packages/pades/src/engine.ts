/** PKIjs needs a WebCrypto engine for signature verification. Set it once,
 *  lazily, from Node's built-in WebCrypto. */
import { webcrypto } from "crypto";
import { setEngine, CryptoEngine, type CryptoEngineParameters } from "pkijs";

let initialised = false;

export function ensureEngine(): void {
  if (initialised) return;
  const cryptoParam = webcrypto as unknown as CryptoEngineParameters["crypto"];
  const engine = new CryptoEngine({ name: "finesign", crypto: cryptoParam });
  setEngine("finesign", engine);
  initialised = true;
}
