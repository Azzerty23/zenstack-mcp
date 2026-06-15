import { SignJWT, jwtVerify } from 'jose'

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signToken(payload: unknown, secret: string, ttlSeconds: number): Promise<string> {
  return new SignJWT({ data: payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret))
}

export async function verifyToken(token: string, secret: string): Promise<unknown> {
  // Pin the accepted algorithm to HS256. jose already rejects `alg: none` and,
  // with a symmetric key, asymmetric algs — but pinning prevents a token signed
  // with HS384/HS512 from being accepted and makes the contract explicit.
  const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ['HS256'] })
  return (payload as Record<string, unknown>).data
}
