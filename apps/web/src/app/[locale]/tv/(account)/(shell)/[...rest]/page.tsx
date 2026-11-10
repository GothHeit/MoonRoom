import { notFound } from "next/navigation";

// Unknown addresses under /tv render the TV's own not-found screen, not the website's.
export default function TvCatchAll() {
  notFound();
}
