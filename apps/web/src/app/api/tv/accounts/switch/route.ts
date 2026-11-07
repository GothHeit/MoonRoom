import { switchAccount } from "@/lib/tv-accounts";

export const POST = (request: Request) => switchAccount(request);
