import roomsSetup from "../e2e-rooms/global-setup";

import { ensureFixture } from "./fixture";

export default function globalSetup() {
  roomsSetup();
  ensureFixture();
}
