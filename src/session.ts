// The browser session (plan T9 local boundary). The launch link carries a
// secret in its fragment, which browsers never send to a server; the page
// exchanges it (the secret stays valid while the service runs) for a
// session and a media key, kept in this tab's
// sessionStorage (separate for every origin, port included) and never in a
// cookie, which browsers would also send to other ports of 127.0.0.1. API
// requests carry the session as a header; media elements, which cannot send
// headers, carry the media key, which only reads media.
type Session = { session: string; media: string };
const KEY = "yamakan.session";
const HEX = /^[a-f0-9]{64}$/;

function stored(): Session | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(KEY) ?? "null");
    return value && HEX.test(value.session) && HEX.test(value.media)
      ? value
      : null;
  } catch {
    return null;
  }
}
let current: Session | null = stored();

// Exchanges a launch secret in the address, if any, and removes it from the
// address bar and history first.
export async function startSession() {
  const launch = /(?:^#|&)launch=([a-f0-9]{64})(?:&|$)/.exec(
    location.hash,
  )?.[1];
  if (!launch) return;
  history.replaceState(null, "", location.pathname + location.search);
  try {
    const response = await fetch("/api/v1/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ launch }),
    });
    if (!response.ok) return;
    const value = await response.json();
    if (!HEX.test(value.session) || !HEX.test(value.media)) return;
    current = { session: value.session, media: value.media };
    try {
      sessionStorage.setItem(KEY, JSON.stringify(current));
    } catch {
      // Without storage the session lasts until this page reloads.
    }
  } catch {
    // The editor then shows the sign-in notice.
  }
}

export const sessionHeaders = (): Record<string, string> =>
  current ? { "X-Yamakan-Session": current.session } : {};

// A media address (asset, preview, export download) with the media key.
export const mediaUrl = (path: string) =>
  current
    ? `${path}${path.includes("?") ? "&" : "?"}media=${current.media}`
    : path;
