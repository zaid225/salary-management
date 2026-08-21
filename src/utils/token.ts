import { randomBytes } from "node:crypto";

export function generateApiKey(prefix = "sk"): string {
  return `${prefix}_${randomBytes(24).toString("hex")}`;
}

export function maskToken(token: string, visible = 4): string {
  if (token.length <= visible * 2) return "*".repeat(token.length);
  return `${token.slice(0, visible)}${"*".repeat(token.length - visible * 2)}${token.slice(-visible)}`;
}
