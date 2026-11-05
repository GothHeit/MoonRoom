import { startDeviceLogin } from "@/lib/device-login";

export const POST = (request: Request) => startDeviceLogin(request);
