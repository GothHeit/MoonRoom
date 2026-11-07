import { removeAccount } from "@/lib/tv-accounts";

export const POST = (request: Request) => removeAccount(request);
