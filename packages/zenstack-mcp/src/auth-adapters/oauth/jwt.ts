import { SignJWT, jwtVerify } from 'jose'

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret)
}

export async function signToken(
  payload: unknown,
  secret: string,
  ttlSeconds: number,
  audience?: string,
): Promise<string> {
  const jwt = new SignJWT({ data: payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
  if (audience) jwt.setAudience(audience)
  return jwt.sign(secretKey(secret))
}

export async function verifyToken(
  token: string,
  secret: string,
  audience?: string,
): Promise<unknown> {
  // Pin the accepted algorithm to HS256. jose already rejects `alg: none` and,
  // with a symmetric key, asymmetric algs — but pinning prevents a token signed
  // with HS384/HS512 from being accepted and makes the contract explicit.
  //
  // When `audience` is provided, jose also rejects tokens whose `aud` claim is
  // absent or different — the RFC 8707 resource binding that stops a token
  // minted for another server from being replayed here.
  const { payload } = await jwtVerify(token, secretKey(secret), {
    algorithms: ['HS256'],
    ...(audience ? { audience } : {}),
  })
  return (payload as Record<string, unknown>).data
}
