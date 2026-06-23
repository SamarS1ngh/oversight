import { sign, verify } from "hono/jwt";
import { env } from "../env";

export type JwtPayload = {
  sub: string; // user id
  username: string;
  exp: number; // unix seconds
};

const SEVEN_DAYS = 60 * 60 * 24 * 7;

export async function signToken(
  userId: string,
  username: string,
): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SEVEN_DAYS;
  return sign({ sub: userId, username, exp }, env.JWT_SECRET, "HS256");
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  return (await verify(token, env.JWT_SECRET, "HS256")) as JwtPayload;
}
