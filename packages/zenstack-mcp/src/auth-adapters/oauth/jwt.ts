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
  const { payload } = await jwtVerify(token, secretKey(secret))
  return (payload as Record<string, unknown>).data
}
