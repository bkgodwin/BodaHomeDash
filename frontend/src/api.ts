export class ApiError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

export async function api<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api/v1${path}`, {
    ...options,
    headers,
    credentials: "same-origin"
  });
  if (!response.ok) {
    let message = response.statusText;
    try {
      const body = await response.json();
      message = body.detail || message;
    } catch {
      // Keep status text.
    }
    throw new ApiError(message, response.status);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const jsonBody = (value: unknown): Pick<RequestInit, "body"> => ({
  body: JSON.stringify(value)
});

export function openEventSocket(
  onEvent: (event: string, payload: unknown) => void
): () => void {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  let socket: WebSocket | null = null;
  let retry: number | undefined;
  let stopped = false;
  let delay = 1000;

  const connect = () => {
    if (stopped) return;
    socket = new WebSocket(`${protocol}://${location.host}/api/v1/events`);
    socket.addEventListener("open", () => {
      delay = 1000;
    });
    socket.addEventListener("message", (message) => {
      try {
        const data = JSON.parse(message.data);
        onEvent(data.event, data.payload);
      } catch {
        // Ignore malformed event frames and keep the live connection.
      }
    });
    socket.addEventListener("close", () => {
      if (stopped) return;
      retry = window.setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    });
  };

  const activity = () => {
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ event: "activity" }));
    }
  };
  connect();
  window.addEventListener("pointerdown", activity, { passive: true });
  return () => {
    stopped = true;
    if (retry) window.clearTimeout(retry);
    window.removeEventListener("pointerdown", activity);
    socket?.close();
  };
}
