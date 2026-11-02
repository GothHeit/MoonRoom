import { getImageProps } from "next/image";

const TVDB = "https://artworks.thetvdb.com/";
const QUALITY = 82;

type ArtImage = { src: string; srcSet?: string; sizes?: string };

/**
 * Attributes for an <img> of TheTVDB art that downloads the size the screen needs (WebP, resized by
 * the web server and cached). `sizes` says how wide the picture is shown, as in a normal <img>.
 * Other addresses are returned untouched.
 */
export function artImage(src: string, sizes: string): ArtImage {
  if (!src.startsWith(TVDB)) return { src };
  const { props } = getImageProps({ src, alt: "", fill: true, sizes, quality: QUALITY });
  return { src: props.src, srcSet: props.srcSet, sizes: props.sizes };
}
