import { tokenRoute } from "@/lib/auth-route";

export const POST = (request: Request) => tokenRoute("/auth/login/2fa", request);
