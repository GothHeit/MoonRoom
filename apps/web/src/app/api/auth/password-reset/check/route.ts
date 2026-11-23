import { publicJsonRoute } from "@/lib/auth-route";

export const POST = (request: Request) => publicJsonRoute("/auth/password-reset/check", request);
