import { pollDeviceLogin } from "@/lib/device-login";

export const POST = (request: Request) => pollDeviceLogin(request);
