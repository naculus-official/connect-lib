export type Platform = "desktop-web" | "mobile-web" | "in-app-browser";

export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") {
    return "desktop-web";
  }

  const ua = navigator.userAgent.toLowerCase();
  const mobilePattern = /(iphone|ipad|ipod|android|mobile)/i;

  if (mobilePattern.test(ua)) {
    return "mobile-web";
  }

  return "desktop-web";
}

export function isMobileBrowser(): boolean {
  if (typeof navigator === "undefined") {
    return false;
  }

  const ua = navigator.userAgent.toLowerCase();
  return /(iphone|ipad|ipod|android|mobile)/i.test(ua);
}
