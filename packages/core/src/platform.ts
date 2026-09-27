export type Platform =
  | "desktop-web"
  | "mobile-web"
  | "in-app-browser"
  | "native-ios"
  | "native-android";

const MOBILE_UA = /(iphone|ipad|ipod|android|mobile)/i;

let override: Platform | null = null;

/**
 * Declare the platform the app runs on. React Native cannot be detected
 * reliably from `navigator` (its userAgent is absent or not a browser's), so
 * `@naculus/connect-native` calls this with `Platform.OS`. Pass null to go
 * back to detection.
 */
export function setPlatformOverride(platform: Platform | null): void {
  override = platform;
}

function userAgent(): string | null {
  if (typeof navigator === "undefined") return null;
  const ua = (navigator as { userAgent?: unknown }).userAgent;
  return typeof ua === "string" ? ua : null;
}

/** True inside a React Native runtime (Hermes / JSC with RN globals). */
export function isReactNative(): boolean {
  return (
    typeof navigator !== "undefined" &&
    (navigator as { product?: unknown }).product === "ReactNative"
  );
}

export function detectPlatform(): Platform {
  if (override) return override;
  const ua = userAgent();
  if (ua === null) return "desktop-web";
  return MOBILE_UA.test(ua) ? "mobile-web" : "desktop-web";
}

/** A browser on a phone. False on React Native, which is not a browser. */
export function isMobileBrowser(): boolean {
  if (override === "native-ios" || override === "native-android") {
    return false;
  }
  if (isReactNative()) return false;
  const ua = userAgent();
  return ua !== null && MOBILE_UA.test(ua);
}

/** A phone: a mobile browser, or a native app that declared its platform. */
export function isMobileDevice(): boolean {
  return (
    override === "native-ios" ||
    override === "native-android" ||
    isMobileBrowser()
  );
}
