/**
 * `TRUST_PROXY_HOPS` as a Fastify `trustProxy` function: believe the last `hops`
 * entries of `X-Forwarded-For`, never more.
 *
 * Not the bare number. Fastify ≥5.12 reads a numeric `trustProxy` as "trust nothing"
 * (a hop count cannot check who the immediate peer is), which would resolve every
 * `req.ip` to nginx's loopback address and put the whole internet on one rate-limit
 * bucket. A count is safe here only because the API listens on 127.0.0.1, so the
 * nearest peer is always our own proxy — see `deploy/pm2/tmbilling-api.json`.
 */
export function trustProxyHops(hops: number): (address: string, hop: number) => boolean {
  return (_address, hop) => hop < hops;
}
