const encoder = new TextEncoder();

export function isOperatorTokenConfigured(token: string): boolean {
  return token.length >= 32 && token.length <= 512 && !/\s/.test(token);
}

export function isOperatorRequestAuthorized(request: Request, configuredToken: string): boolean {
  if (!isOperatorTokenConfigured(configuredToken)) return false;
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return false;
  const suppliedToken = authorization.slice(7);
  if (suppliedToken.length > 512) return false;
  const expected = encoder.encode(configuredToken);
  const supplied = encoder.encode(suppliedToken);
  let difference = expected.length ^ supplied.length;
  const length = Math.max(expected.length, supplied.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (expected[index] ?? 0) ^ (supplied[index] ?? 0);
  }
  return difference === 0;
}
