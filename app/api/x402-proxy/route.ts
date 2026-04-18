type ProxyRequestPayload = {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
};

const ALLOWED_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

function normalizeHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(headers)
      .filter(([key]) => key.trim().length > 0)
      .map(([key, value]) => [key.trim(), value ?? ""]),
  );
}

function validateTargetUrl(rawUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Invalid target URL.");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http/https endpoints are supported.");
  }

  return parsed;
}

function normalizeMethod(rawMethod: string): string {
  const normalized = String(rawMethod || "GET").toUpperCase();
  if (!ALLOWED_METHODS.has(normalized)) {
    throw new Error(`Unsupported HTTP method: ${normalized}`);
  }

  return normalized;
}

function methodCanHaveBody(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

export async function POST(request: Request): Promise<Response> {
  let payload: ProxyRequestPayload;

  try {
    payload = (await request.json()) as ProxyRequestPayload;
  } catch {
    return Response.json({ error: "Invalid JSON payload." }, { status: 400 });
  }

  let method: string;
  try {
    method = normalizeMethod(payload.method || "GET");
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Invalid HTTP method in proxy payload.",
      },
      { status: 400 },
    );
  }

  const headers = normalizeHeaders(payload.headers);
  const body = String(payload.body ?? "");

  let url: URL;
  try {
    url = validateTargetUrl(payload.url);
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "URL validation failed.",
      },
      { status: 400 },
    );
  }

  const includeBody = methodCanHaveBody(method);

  try {
    const upstreamResponse = await fetch(url, {
      method,
      headers,
      body: includeBody ? body : undefined,
    });

    const upstreamHeaders: Record<string, string> = {};
    upstreamResponse.headers.forEach((value, key) => {
      upstreamHeaders[key.toLowerCase()] = value;
    });

    const upstreamBody = await upstreamResponse.text();

    return Response.json({
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      headers: upstreamHeaders,
      body: upstreamBody,
    });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to reach target endpoint.",
      },
      { status: 502 },
    );
  }
}
