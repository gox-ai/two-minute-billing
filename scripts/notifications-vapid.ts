/**
 * Print a fresh VAPID key pair for Web Push as env lines. Writes nothing: copy the lines into
 * your .env (or the production environment). A new pair orphans every device subscription.
 *
 *   pnpm notifications:vapid
 */
import webpush from "web-push";

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("VAPID_SUBJECT=mailto:you@example.com");
