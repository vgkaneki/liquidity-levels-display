import bcrypt from "bcryptjs";

// bcryptjs is the pure-JS implementation. cost=10 is the OWASP-current
// recommendation for interactive logins (~80ms compute on this server,
// well within the budget for /api/auth/login while making offline brute
// force economically infeasible at small password-length tails).
const BCRYPT_COST = 10;

// Maximum input length to defend against algorithmic complexity attacks
// (uploading a 1MB "password" to make the hash CPU-bound). bcrypt itself
// silently truncates at 72 bytes, but we reject earlier with a clear
// 400 so the client sees a deterministic validation error.
export const MAX_PASSWORD_LENGTH = 200;
// Minimum length is enforced in the route layer; we keep it here as a
// shared constant for both register and password-change flows.
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(plaintext: string): Promise<string> {
  if (typeof plaintext !== "string") {
    throw new Error("password must be a string");
  }
  if (plaintext.length > MAX_PASSWORD_LENGTH) {
    throw new Error("password too long");
  }
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

export async function verifyPassword(
  plaintext: string,
  hash: string,
): Promise<boolean> {
  if (typeof plaintext !== "string" || typeof hash !== "string") return false;
  if (plaintext.length === 0 || plaintext.length > MAX_PASSWORD_LENGTH) {
    return false;
  }
  if (hash.length === 0) return false;
  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}
