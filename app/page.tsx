"use client";

import { useMemo, useState } from "react";

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type StepStatus = "idle" | "active" | "done" | "error";
type EventKind = "info" | "success" | "warning" | "error";
type PaymentView = "decoded" | "raw";
type PaymentEncoding = "base64" | "base64url";
type SignatureMethod = "personal_sign" | "eth_signTypedData_v4";

type HeaderRow = {
  id: string;
  key: string;
  value: string;
};

type DecodedPayment = {
  raw: string;
  parsed: Record<string, unknown> | null;
  recipient: string;
  amount: string;
  token: string;
  chain: string;
  chainId: string;
  nonce: string;
  nonceMode: "request" | "authorization";
  primaryType: string;
  expiration: string;
  domain: string;
  metadata: string;
  facilitator: string;
  warnings: string[];
  notes: string[];
  unknownFields: Array<{ key: string; value: string }>;
};

type PaymentChallenge = {
  id: string;
  source: string;
  raw: string;
  decoded: DecodedPayment;
};

type RequestAttempt = {
  id: string;
  attemptNumber: number;
  phase: "initial" | "retry";
  timestamp: string;
  method: HttpMethod;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  responseStatus: number | null;
  responseStatusText: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
  is402: boolean;
  paymentChallenges: PaymentChallenge[];
  errorMessage: string;
};

type ActivityEvent = {
  id: string;
  timestamp: string;
  kind: EventKind;
  title: string;
  detail: string;
};

type WalletState = {
  status: "disconnected" | "connecting" | "connected" | "error";
  address: string;
  chainId: string;
  errorMessage: string;
};

type ChallengeInContext = {
  attemptNumber: number;
  responseStatus: number | null;
  challenge: PaymentChallenge;
};

type ProxyFetchResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  error?: string;
};

type SigningPreparation = {
  payload: unknown;
  generatedNonce?: string;
  validAfter?: string;
  validBefore?: string;
};

declare global {
  interface Window {
    ethereum?: {
      request: (args: {
        method: string;
        params?: unknown[] | object;
      }) => Promise<unknown>;
    };
  }
}

const METHODS: HttpMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function createId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { hour12: false });
}

function safeString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function prettyJson(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return safeString(value);
  }
}

function tryParseJson(raw: string): unknown | null {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function looksLikeBase64(raw: string): boolean {
  if (raw.length < 16 || raw.length % 4 !== 0) {
    return false;
  }

  return /^[A-Za-z0-9+/=\n\r]+$/.test(raw);
}

function tryDecodeBase64Json(raw: string): unknown | null {
  if (typeof window === "undefined" || !looksLikeBase64(raw)) {
    return null;
  }

  try {
    const decoded = window.atob(raw.replace(/\s+/g, ""));
    return tryParseJson(decoded);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function collectObjects(value: unknown): Record<string, unknown>[] {
  const objects: Record<string, unknown>[] = [];
  const stack: unknown[] = [value];
  const visited = new Set<object>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }

    if (Array.isArray(current)) {
      for (const entry of current) {
        stack.push(entry);
      }
      continue;
    }

    if (visited.has(current)) {
      continue;
    }
    visited.add(current);

    const record = current as Record<string, unknown>;
    objects.push(record);

    for (const nested of Object.values(record)) {
      stack.push(nested);
    }
  }

  return objects;
}

function findField(
  objects: Record<string, unknown>[],
  candidates: string[],
): string {
  const wanted = new Set(candidates.map((value) => value.toLowerCase()));

  for (const object of objects) {
    for (const [key, value] of Object.entries(object)) {
      if (wanted.has(key.toLowerCase())) {
        return safeString(value);
      }
    }
  }

  return "";
}

function detectExpirationWarning(expiration: string): string {
  if (!expiration) {
    return "";
  }

  const parsedNumber = Number(expiration);
  if (!Number.isNaN(parsedNumber) && Number.isFinite(parsedNumber)) {
    if (parsedNumber >= 1_000_000_000_000) {
      if (Date.now() > parsedNumber) {
        return "Payment challenge appears expired.";
      }
      return "";
    }

    if (parsedNumber >= 1_000_000_000) {
      const asMilliseconds = parsedNumber * 1000;
      if (Date.now() > asMilliseconds) {
        return "Payment challenge appears expired.";
      }
      return "";
    }

    // Small numeric values are likely TTL durations (e.g. maxTimeoutSeconds), not epoch timestamps.
    return "";
  }

  const parsedDate = Date.parse(expiration);
  if (!Number.isNaN(parsedDate) && Date.now() > parsedDate) {
    return "Payment challenge appears expired.";
  }

  return "";
}

function decodePaymentPayload(rawPayload: string): DecodedPayment {
  const raw = rawPayload.trim();
  let parsed = tryParseJson(raw);
  if (!parsed) {
    parsed = tryDecodeBase64Json(raw);
  }

  const objects = collectObjects(parsed);
  const parsedRecord = asRecord(parsed);

  const decoded: DecodedPayment = {
    raw: rawPayload,
    parsed: parsedRecord,
    recipient: findField(objects, [
      "recipient",
      "recipientAddress",
      "payTo",
      "to",
      "receiver",
    ]),
    amount: findField(objects, [
      "amount",
      "price",
      "value",
      "maxAmount",
      "maxAmountRequired",
    ]),
    token: findField(objects, ["token", "asset", "currency", "symbol"]),
    chain: findField(objects, ["chain", "network", "networkName"]),
    chainId: findField(objects, ["chainId", "chain_id", "networkId"]),
    nonce: findField(objects, ["nonce", "salt", "challengeNonce"]),
    nonceMode: "request",
    primaryType: findField(objects, ["primaryType"]),
    expiration: findField(objects, [
      "expiration",
      "expiresAt",
      "expiry",
      "deadline",
      "maxTimeoutSeconds",
    ]),
    domain: findField(objects, ["domain", "resource", "resourceUrl", "aud"]),
    metadata: findField(objects, ["metadata", "meta", "description", "memo"]),
    facilitator: findField(objects, [
      "facilitator",
      "facilitatorAddress",
      "settlement",
      "settler",
    ]),
    warnings: [],
    notes: [],
    unknownFields: [],
  };

  const normalizedPrimaryType = decoded.primaryType.toLowerCase();
  const usesAuthorizationNonce =
    normalizedPrimaryType === "transferwithauthorization" ||
    normalizedPrimaryType === "receivewithauthorization" ||
    normalizedPrimaryType === "permit" ||
    normalizedPrimaryType === "permit2";

  if (usesAuthorizationNonce) {
    decoded.nonceMode = "authorization";
    if (!decoded.nonce) {
      decoded.nonce = "Generated client-side at signing";
    }

    decoded.notes.push(
      "Authorization flow detected: nonce is generated client-side during signing and verified onchain.",
    );
  }

  const requiredFields = [
    { label: "recipient", value: decoded.recipient },
    { label: "amount", value: decoded.amount },
  ];

  if (decoded.nonceMode === "request") {
    requiredFields.push({ label: "nonce", value: decoded.nonce });
  }

  for (const field of requiredFields) {
    if (!field.value) {
      decoded.warnings.push(`Missing ${field.label} in payment payload.`);
    }
  }

  const expirationWarning = detectExpirationWarning(decoded.expiration);
  if (expirationWarning) {
    decoded.warnings.push(expirationWarning);
  }

  if (!parsedRecord) {
    decoded.warnings.push("Payload is not JSON-decoded; showing raw content only.");
  } else {
    const knownKeys = new Set(
      [
        "recipient",
        "payto",
        "to",
        "receiver",
        "recipientaddress",
        "amount",
        "price",
        "value",
        "maxamount",
        "maxamountrequired",
        "token",
        "asset",
        "currency",
        "symbol",
        "chain",
        "network",
        "networkname",
        "chainid",
        "chain_id",
        "networkid",
        "nonce",
        "salt",
        "challengenonce",
        "expiration",
        "expiresat",
        "expiry",
        "deadline",
        "maxtimeoutseconds",
        "domain",
        "resource",
        "resourceurl",
        "aud",
        "metadata",
        "meta",
        "description",
        "memo",
        "facilitator",
        "facilitatoraddress",
        "settlement",
        "settler",
      ].map((key) => key.toLowerCase()),
    );

    decoded.unknownFields = Object.entries(parsedRecord)
      .filter(([key]) => !knownKeys.has(key.toLowerCase()))
      .map(([key, value]) => ({ key, value: safeString(value) }));
  }

  return decoded;
}

function generateHexNonce(byteLength = 32): string {
  const buffer = new Uint8Array(byteLength);
  crypto.getRandomValues(buffer);
  return `0x${Array.from(buffer, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function applyAuthorizationDefaults(value: unknown, auth: Record<string, string>): unknown {
  const record = asRecord(value);
  if (!record) {
    return value;
  }

  const output: Record<string, unknown> = { ...record };
  if (!output.nonce) {
    output.nonce = auth.nonce;
  }
  if (!output.validAfter) {
    output.validAfter = auth.validAfter;
  }
  if (!output.validBefore) {
    output.validBefore = auth.validBefore;
  }

  return output;
}

function buildSigningChallengePayload(challenge: PaymentChallenge): SigningPreparation {
  const parsed = challenge.decoded.parsed;
  if (!parsed) {
    return { payload: challenge.raw };
  }

  if (challenge.decoded.nonceMode !== "authorization") {
    return { payload: parsed };
  }

  // Preserve server-issued authorization fields. Some facilitators reject client-mutated nonce values.
  if (hasAnyDeepKey(parsed, ["nonce"])) {
    return { payload: parsed };
  }

  const timeoutRaw = challenge.decoded.expiration;
  const timeoutSeconds = Number(timeoutRaw);
  const ttlSeconds =
    Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 && timeoutSeconds < 604800
      ? Math.floor(timeoutSeconds)
      : 3600;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const validAfter = nowSeconds.toString();
  const validBefore = (nowSeconds + ttlSeconds).toString();
  const nonce = generateHexNonce(32);
  const authDefaults = {
    nonce,
    validAfter,
    validBefore,
  };

  const root = applyAuthorizationDefaults(parsed, authDefaults);
  const rootRecord = asRecord(root);
  if (!rootRecord) {
    return {
      payload: root,
      generatedNonce: nonce,
      validAfter,
      validBefore,
    };
  }

  if (Array.isArray(rootRecord.accepts)) {
    rootRecord.accepts = rootRecord.accepts.map((item) => {
      const enriched = applyAuthorizationDefaults(item, authDefaults);
      const enrichedRecord = asRecord(enriched);
      if (!enrichedRecord) {
        return enriched;
      }

      if (enrichedRecord.extra) {
        enrichedRecord.extra = applyAuthorizationDefaults(enrichedRecord.extra, authDefaults);
      }

      if (enrichedRecord.message) {
        enrichedRecord.message = applyAuthorizationDefaults(
          enrichedRecord.message,
          authDefaults,
        );
      }

      if (enrichedRecord.authorization) {
        enrichedRecord.authorization = applyAuthorizationDefaults(
          enrichedRecord.authorization,
          authDefaults,
        );
      }

      return enrichedRecord;
    });
  }

  if (rootRecord.extra) {
    rootRecord.extra = applyAuthorizationDefaults(rootRecord.extra, authDefaults);
  }

  if (rootRecord.message) {
    rootRecord.message = applyAuthorizationDefaults(rootRecord.message, authDefaults);
  }

  if (rootRecord.authorization) {
    rootRecord.authorization = applyAuthorizationDefaults(
      rootRecord.authorization,
      authDefaults,
    );
  }

  return {
    payload: rootRecord,
    generatedNonce: nonce,
    validAfter,
    validBefore,
  };
}

function getPaymentCandidates(
  status: number,
  responseHeaders: Record<string, string>,
  responseBody: string,
): Array<{ source: string; raw: string }> {
  const candidates: Array<{ source: string; raw: string }> = [];
  const normalizedHeaders = Object.fromEntries(
    Object.entries(responseHeaders).map(([key, value]) => [key.toLowerCase(), value]),
  );

  const headerNames = [
    "payment-required",
    "x-payment-required",
    "x402-payment",
    "x-payment",
    "www-authenticate",
  ];

  for (const headerName of headerNames) {
    const headerValue = normalizedHeaders[headerName];
    if (headerValue) {
      candidates.push({
        source: `Header: ${headerName}`,
        raw: headerValue,
      });
    }
  }

  const parsedBody = tryParseJson(responseBody);
  const parsedObject = asRecord(parsedBody);
  if (parsedObject) {
    const bodyPaths = [
      "payment",
      "challenge",
      "x402",
      "paymentRequired",
      "paymentRequirements",
      "requirements",
    ];

    for (const key of bodyPaths) {
      const bodyValue = parsedObject[key];
      if (Array.isArray(bodyValue)) {
        for (const item of bodyValue) {
          candidates.push({
            source: `Body: ${key}`,
            raw: prettyJson(item),
          });
        }
      } else if (bodyValue !== undefined && bodyValue !== null) {
        candidates.push({
          source: `Body: ${key}`,
          raw: prettyJson(bodyValue),
        });
      }
    }
  }

  if (status === 402 && candidates.length === 0 && responseBody.trim()) {
    candidates.push({
      source: "Body: raw",
      raw: responseBody,
    });
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.source}:${candidate.raw}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function statusBadgeClass(kind: EventKind): string {
  if (kind === "success") {
    return "bg-(--accent) text-black";
  }

  if (kind === "warning") {
    return "bg-(--warning) text-black";
  }

  if (kind === "error") {
    return "bg-(--danger) text-black";
  }

  return "bg-white text-black";
}

function shortAddress(value: string): string {
  if (!value || value.length < 12) {
    return value || "-";
  }

  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatStatus(status: number | null, statusText: string): string {
  if (!status) {
    return "network error";
  }

  return `${status} ${statusText || ""}`.trim();
}

function mergeHeaders(rows: HeaderRow[]): Record<string, string> {
  const output: Record<string, string> = {};

  for (const row of rows) {
    if (row.key.trim()) {
      output[row.key.trim()] = row.value;
    }
  }

  return output;
}

function jsonToDownload(value: unknown, fileName: string) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json",
  });

  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(link.href);
}

function normalizeChainId(value: string): string {
  if (!value) {
    return "";
  }

  if (value.startsWith("0x")) {
    return value.toLowerCase();
  }

  const asNumber = Number(value);
  if (Number.isFinite(asNumber)) {
    return `0x${asNumber.toString(16)}`;
  }

  return value.toLowerCase();
}

function methodCanHaveBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD";
}

function extractHeaderNameFromSource(source: string): string {
  const prefix = "Header:";
  if (!source.startsWith(prefix)) {
    return "";
  }

  return source.slice(prefix.length).trim();
}

function hasAnyDeepKey(value: unknown, wantedKeys: string[]): boolean {
  const wanted = new Set(wantedKeys.map((key) => key.toLowerCase()));
  const objects = collectObjects(value);

  for (const object of objects) {
    for (const key of Object.keys(object)) {
      if (wanted.has(key.toLowerCase())) {
        return true;
      }
    }
  }

  return false;
}

function findTypedDataCandidate(value: unknown): Record<string, unknown> | null {
  for (const object of collectObjects(value)) {
    const hasTypes = Boolean(object.types && typeof object.types === "object");
    const hasDomain = Boolean(object.domain && typeof object.domain === "object");
    const hasMessage = Boolean(object.message && typeof object.message === "object");
    const hasPrimaryType = typeof object.primaryType === "string";

    if (hasTypes && hasDomain && hasMessage && hasPrimaryType) {
      return object;
    }
  }

  return null;
}

function encodeUtf8Base64(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const chunkSize = 0x8000;
  let binary = "";

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return window.btoa(binary);
}

function encodePaymentHeaderPayload(
  value: unknown,
  encoding: PaymentEncoding,
): string {
  const base64 = encodeUtf8Base64(JSON.stringify(value));

  if (encoding === "base64url") {
    return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  return base64;
}

function buildPaymentHeaders(
  encodedHeader: string,
  preferredHeaderName: string,
  walletAddress: string,
): Record<string, string> {
  const headerName = preferredHeaderName.trim() || "X-PAYMENT";

  return {
    [headerName]: encodedHeader,
    "X-PAYMENT": encodedHeader,
    "PAYMENT-SIGNATURE": encodedHeader,
    "X-PAYMENT-ADDRESS": walletAddress,
  };
}

export default function Home() {
  const [targetUrl, setTargetUrl] = useState("");
  const [method, setMethod] = useState<HttpMethod>("GET");
  const [showHeadersEditor, setShowHeadersEditor] = useState(false);
  const [showBodyEditor, setShowBodyEditor] = useState(false);
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>([
    { id: createId("header"), key: "", value: "" },
  ]);
  const [requestBody, setRequestBody] = useState("");

  const [attempts, setAttempts] = useState<RequestAttempt[]>([]);
  const [activityLog, setActivityLog] = useState<ActivityEvent[]>([]);
  const [paymentView, setPaymentView] = useState<PaymentView>("decoded");
  const [selectedChallengeId, setSelectedChallengeId] = useState("");
  const [preferredPaymentHeader, setPreferredPaymentHeader] = useState("");
  const [paymentEncoding, setPaymentEncoding] = useState<PaymentEncoding>("base64");

  const [walletState, setWalletState] = useState<WalletState>({
    status: "disconnected",
    address: "",
    chainId: "",
    errorMessage: "",
  });

  const [signature, setSignature] = useState("");
  const [paymentHeader, setPaymentHeader] = useState("");
  const [signatureMethod, setSignatureMethod] = useState<SignatureMethod | "">("");
  const [signedPayloadPreview, setSignedPayloadPreview] = useState<unknown | null>(
    null,
  );
  const [generatedAuthorizationNonce, setGeneratedAuthorizationNonce] = useState("");
  const [generatedValidAfter, setGeneratedValidAfter] = useState("");
  const [generatedValidBefore, setGeneratedValidBefore] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const allChallenges = useMemo<ChallengeInContext[]>(() => {
    return attempts.flatMap((attempt) =>
      attempt.paymentChallenges.map((challenge) => ({
        attemptNumber: attempt.attemptNumber,
        responseStatus: attempt.responseStatus,
        challenge,
      })),
    );
  }, [attempts]);

  const selectedChallenge = useMemo(() => {
    if (!allChallenges.length) {
      return null;
    }

    if (!selectedChallengeId) {
      return allChallenges[0];
    }

    return (
      allChallenges.find((item) => item.challenge.id === selectedChallengeId) ??
      allChallenges[0]
    );
  }, [allChallenges, selectedChallengeId]);

  const latestAttempt = attempts.at(-1) ?? null;
  const latest402 = [...attempts].reverse().find((attempt) => attempt.is402) ?? null;
  const inferredPaymentHeader = selectedChallenge
    ? extractHeaderNameFromSource(selectedChallenge.challenge.source)
    : "";
  const effectivePaymentHeader =
    preferredPaymentHeader.trim() || inferredPaymentHeader || "X-PAYMENT";
  const retryBaseAttempt = useMemo(() => {
    if (selectedChallenge) {
      const selectedAttempt = attempts.find(
        (attempt) => attempt.attemptNumber === selectedChallenge.attemptNumber,
      );

      if (selectedAttempt) {
        return selectedAttempt;
      }
    }

    return latest402;
  }, [attempts, latest402, selectedChallenge]);

  const workflowStatus = {
    walletConnected: walletState.status === "connected",
    endpointTested: attempts.length > 0,
    captured402: attempts.some((attempt) => attempt.is402),
    paymentSigned: Boolean(signature),
    retrySucceeded: attempts.some(
      (attempt) =>
        attempt.phase === "retry" &&
        attempt.responseStatus !== null &&
        attempt.responseStatus >= 200 &&
        attempt.responseStatus < 300,
    ),
  };

  const expectedChainId = selectedChallenge
    ? normalizeChainId(
        selectedChallenge.challenge.decoded.chainId ||
          selectedChallenge.challenge.decoded.chain,
      )
    : "";
  const walletChainId = normalizeChainId(walletState.chainId);
  const chainMismatch =
    walletState.status === "connected" &&
    Boolean(expectedChainId && walletChainId && expectedChainId !== walletChainId);

  const steps: Array<{ label: string; status: StepStatus; detail: string }> = [
    {
      label: "Enter URL",
      status: targetUrl.trim() ? "done" : "active",
      detail: targetUrl.trim() ? "Target provided" : "Awaiting endpoint",
    },
    {
      label: "Send request",
      status: workflowStatus.endpointTested ? "done" : targetUrl.trim() ? "active" : "idle",
      detail: workflowStatus.endpointTested
        ? `${attempts.length} attempt${attempts.length > 1 ? "s" : ""}`
        : "No request sent",
    },
    {
      label: "Inspect payment",
      status: workflowStatus.captured402
        ? "done"
        : workflowStatus.endpointTested
          ? "active"
          : "idle",
      detail: workflowStatus.captured402
        ? `${allChallenges.length} challenge${allChallenges.length > 1 ? "s" : ""}`
        : "Waiting for 402",
    },
    {
      label: "Sign and retry",
      status: workflowStatus.retrySucceeded
        ? "done"
        : workflowStatus.paymentSigned
          ? "active"
          : workflowStatus.captured402
            ? "active"
            : "idle",
      detail: workflowStatus.retrySucceeded
        ? "Retry succeeded"
        : workflowStatus.paymentSigned
          ? "Retry pending"
          : "Not signed",
    },
  ];

  function addActivity(kind: EventKind, title: string, detail: string) {
    setActivityLog((previous) => [
      ...previous,
      {
        id: createId("event"),
        timestamp: new Date().toISOString(),
        kind,
        title,
        detail,
      },
    ]);
  }

  async function copyText(text: string, label: string) {
    if (!text.trim()) {
      addActivity("warning", `Copy ${label}`, "No data available to copy.");
      return;
    }

    try {
      await navigator.clipboard.writeText(text);
      addActivity("success", `Copy ${label}`, `${label} copied to clipboard.`);
    } catch {
      addActivity("error", `Copy ${label}`, "Clipboard write failed.");
    }
  }

  function buildCurlRequest(extraHeaders?: Record<string, string>): string {
    const mergedHeaders = {
      ...mergeHeaders(headerRows),
      ...(extraHeaders ?? {}),
    };

    const escapedUrl = targetUrl.replace(/"/g, '\\"');
    const parts = [`curl -i -X ${method} "${escapedUrl}"`];
    for (const [key, value] of Object.entries(mergedHeaders)) {
      const safeKey = key.replace(/"/g, '\\"');
      const safeValue = value.replace(/"/g, '\\"');
      parts.push(`-H "${safeKey}: ${safeValue}"`);
    }

    if (method !== "GET" && requestBody.trim()) {
      const escapedBody = requestBody.replace(/'/g, `'\\''`);
      parts.push(`--data-raw '${escapedBody}'`);
    }

      return parts.join(" \\\n  ");
  }

  async function sendRequest(
    phase: "initial" | "retry",
    extraHeaders: Record<string, string> = {},
  ) {
    const baseAttempt = phase === "retry" ? retryBaseAttempt : null;
    const requestMethod = baseAttempt ? baseAttempt.method : method;
    const urlCandidate = baseAttempt ? baseAttempt.url.trim() : targetUrl.trim();
    const requestBodyValue = baseAttempt ? baseAttempt.requestBody : requestBody;
    const baseHeaders = baseAttempt
      ? { ...baseAttempt.requestHeaders }
      : mergeHeaders(headerRows);

    if (!urlCandidate) {
      addActivity("warning", "Request blocked", "Please enter an endpoint URL.");
      return;
    }

    try {
      new URL(urlCandidate);
    } catch {
      addActivity("error", "Invalid URL", "The endpoint URL is not valid.");
      return;
    }

    const requestHeaders = {
      ...baseHeaders,
      ...extraHeaders,
    };

    const canHaveBody = methodCanHaveBody(requestMethod);
    const normalizedBody = canHaveBody ? requestBodyValue : "";

    if (normalizedBody.trim().length > 0 && !requestHeaders["Content-Type"]) {
      requestHeaders["Content-Type"] = "application/json";
    }

    const attemptNumber = attempts.length + 1;
    const timestamp = new Date().toISOString();

    addActivity(
      "info",
      phase === "initial" ? "Request sent" : "Retry sent",
      phase === "retry" && baseAttempt
        ? `Replaying attempt #${baseAttempt.attemptNumber}: ${requestMethod} ${urlCandidate}`
        : `${requestMethod} ${urlCandidate}`,
    );

    if (phase === "initial") {
      setIsSubmitting(true);
    } else {
      setIsRetrying(true);
    }

    try {
      const proxyResponse = await fetch("/api/x402-proxy", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: urlCandidate,
          method: requestMethod,
          headers: requestHeaders,
          body: normalizedBody,
        }),
      });

      const proxyData = (await proxyResponse.json()) as ProxyFetchResponse;
      if (!proxyResponse.ok || proxyData.error) {
        throw new Error(
          proxyData.error || `Proxy request failed with status ${proxyResponse.status}.`,
        );
      }

      const responseBody = proxyData.body;
      const responseHeaders = proxyData.headers;
      const responseStatus = proxyData.status;
      const responseStatusText = proxyData.statusText;

      const paymentChallenges = getPaymentCandidates(
        responseStatus,
        responseHeaders,
        responseBody,
      ).map((candidate) => ({
        id: createId("challenge"),
        source: candidate.source,
        raw: candidate.raw,
        decoded: decodePaymentPayload(candidate.raw),
      }));

      const attempt: RequestAttempt = {
        id: createId("attempt"),
        attemptNumber,
        phase,
        timestamp,
        method: requestMethod,
        url: urlCandidate,
        requestHeaders,
        requestBody: normalizedBody,
        responseStatus,
        responseStatusText,
        responseHeaders,
        responseBody,
        is402: responseStatus === 402,
        paymentChallenges,
        errorMessage: "",
      };

      setAttempts((previous) => [...previous, attempt]);

      if (responseStatus === 402) {
        addActivity(
          "warning",
          "402 captured",
          "Payment required challenge received.",
        );

        if (paymentChallenges.length === 0) {
          addActivity(
            "warning",
            "No payment payload found",
            "402 response received but no payment payload was found in server-observed headers/body. Ensure PAYMENT-REQUIRED (or x402 header/body fields) is returned by the endpoint.",
          );
        }

        if (!selectedChallengeId && paymentChallenges.length > 0) {
          setSelectedChallengeId(paymentChallenges[0].id);
        }
      } else if (phase === "retry" && responseStatus >= 200 && responseStatus < 300) {
        addActivity("success", "Final response received", `Status ${responseStatus}.`);
      } else if (phase === "retry") {
        addActivity(
          "error",
          "Retry failed",
          `Status ${responseStatus} ${responseStatusText}`,
        );
      } else {
        addActivity(
          responseStatus >= 200 && responseStatus < 300 ? "success" : "warning",
          "Response received",
          `Status ${responseStatus} ${responseStatusText}`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown request error";

      const attempt: RequestAttempt = {
        id: createId("attempt"),
        attemptNumber,
        phase,
        timestamp,
        method: requestMethod,
        url: urlCandidate,
        requestHeaders,
        requestBody: normalizedBody,
        responseStatus: null,
        responseStatusText: "",
        responseHeaders: {},
        responseBody: "",
        is402: false,
        paymentChallenges: [],
        errorMessage: message,
      };

      setAttempts((previous) => [...previous, attempt]);
      addActivity("error", "Request failed", message);
    } finally {
      if (phase === "initial") {
        setIsSubmitting(false);
      } else {
        setIsRetrying(false);
      }
    }
  }

  async function connectWallet() {
    if (!window.ethereum) {
      setWalletState({
        status: "error",
        address: "",
        chainId: "",
        errorMessage: "No injected wallet found.",
      });
      addActivity(
        "error",
        "Wallet unavailable",
        "Install a browser wallet to connect and sign.",
      );
      return;
    }

    setWalletState((previous) => ({
      ...previous,
      status: "connecting",
      errorMessage: "",
    }));

    try {
      const accounts = (await window.ethereum.request({
        method: "eth_requestAccounts",
      })) as string[];
      const chainId = (await window.ethereum.request({
        method: "eth_chainId",
      })) as string;

      setWalletState({
        status: "connected",
        address: accounts[0] ?? "",
        chainId,
        errorMessage: "",
      });

      addActivity(
        "success",
        "Wallet connected",
        `${shortAddress(accounts[0] ?? "unknown")} on ${chainId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Wallet connection failed";
      setWalletState({
        status: "error",
        address: "",
        chainId: "",
        errorMessage: message,
      });
      addActivity("error", "Wallet error", message);
    }
  }

  async function signPayment() {
    if (!selectedChallenge) {
      addActivity("warning", "Signing blocked", "No payment challenge selected.");
      return;
    }

    if (walletState.status !== "connected" || !walletState.address || !window.ethereum) {
      addActivity("error", "Signing blocked", "Connect a wallet before signing.");
      return;
    }

    try {
      const signingPreparation = buildSigningChallengePayload(selectedChallenge.challenge);
      const signingChallenge = signingPreparation.payload;
      const typedDataPayload = findTypedDataCandidate(signingChallenge);

      let usedSignatureMethod: SignatureMethod = "personal_sign";
      let signatureValue = "";

      if (typedDataPayload) {
        usedSignatureMethod = "eth_signTypedData_v4";
        signatureValue = (await window.ethereum.request({
          method: "eth_signTypedData_v4",
          params: [walletState.address, JSON.stringify(typedDataPayload)],
        })) as string;
      } else {
        const messageToSign =
          typeof signingChallenge === "string"
            ? signingChallenge
            : JSON.stringify(signingChallenge);

        signatureValue = (await window.ethereum.request({
          method: "personal_sign",
          params: [messageToSign, walletState.address],
        })) as string;
      }

      const headerPayload = {
        scheme: "x402",
        signedAt: new Date().toISOString(),
        address: walletState.address,
        chainId: walletState.chainId,
        signatureMethod: usedSignatureMethod,
        signature: signatureValue,
        challenge: signingChallenge,
      };

      const encodedHeader = encodePaymentHeaderPayload(headerPayload, paymentEncoding);

      setSignature(signatureValue);
      setPaymentHeader(encodedHeader);
      setSignatureMethod(usedSignatureMethod);
      setSignedPayloadPreview(signingChallenge);
      setGeneratedAuthorizationNonce(signingPreparation.generatedNonce ?? "");
      setGeneratedValidAfter(signingPreparation.validAfter ?? "");
      setGeneratedValidBefore(signingPreparation.validBefore ?? "");

      if (selectedChallenge.challenge.decoded.nonceMode === "authorization") {
        addActivity(
          "info",
          "Nonce generated",
          "Client-side nonce and validity window added to authorization payload before signing.",
        );
      }

      addActivity("success", "Signature created", "Payment header prepared.");

      addActivity(
        "info",
        "Signature method",
        `Used ${usedSignatureMethod} (${paymentEncoding} header encoding).`,
      );

      await sendRequest(
        "retry",
        buildPaymentHeaders(encodedHeader, effectivePaymentHeader, walletState.address),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Signing failed";
      addActivity("error", "Signing failed", message);
    }
  }

  function resetSession() {
    setAttempts([]);
    setActivityLog([]);
    setSelectedChallengeId("");
    setPreferredPaymentHeader("");
    setPaymentEncoding("base64");
    setSignature("");
    setPaymentHeader("");
    setSignatureMethod("");
    setSignedPayloadPreview(null);
    setGeneratedAuthorizationNonce("");
    setGeneratedValidAfter("");
    setGeneratedValidBefore("");
    setRequestBody("");
    setHeaderRows([{ id: createId("header"), key: "", value: "" }]);
    addActivity("info", "Session reset", "Trace and payload state cleared.");
  }

  function addHeaderRow() {
    setHeaderRows((previous) => [
      ...previous,
      { id: createId("header"), key: "", value: "" },
    ]);
  }

  function clearTraceOnly() {
    setAttempts([]);
    setSelectedChallengeId("");
    setPreferredPaymentHeader("");
    setSignature("");
    setPaymentHeader("");
    setSignatureMethod("");
    setSignedPayloadPreview(null);
    setGeneratedAuthorizationNonce("");
    setGeneratedValidAfter("");
    setGeneratedValidBefore("");
    addActivity("info", "Trace cleared", "Attempt history removed.");
  }

  const canSign = Boolean(selectedChallenge) && walletState.status === "connected";
  const canRetry = Boolean(paymentHeader && signature);

  const paymentInspectorHint = useMemo(() => {
    if (!latest402 || allChallenges.length > 0) {
      return "";
    }

    const visibleHeaderNames = Object.keys(latest402.responseHeaders).map((key) =>
      key.toLowerCase(),
    );

    const hasVisiblePaymentHeader = visibleHeaderNames.some((headerName) =>
      ["payment-required", "x-payment-required", "x402-payment", "x-payment"].includes(
        headerName,
      ),
    );

    const bodyPreview = latest402.responseBody.trim();
    const bodyLooksEmpty = !bodyPreview || bodyPreview === "{}" || bodyPreview === "null";

    if (!hasVisiblePaymentHeader && bodyLooksEmpty) {
      return "No payment payload was found in server-observed headers/body. Ensure the endpoint returns PAYMENT-REQUIRED (or X-PAYMENT-REQUIRED / X402-PAYMENT) or includes challenge data in JSON body.";
    }

    if (!hasVisiblePaymentHeader) {
      return "402 was received, but no supported payment header was visible. Ensure the challenge is sent in PAYMENT-REQUIRED / X-PAYMENT-REQUIRED / X402-PAYMENT or in the response body.";
    }

    return "A payment header was found but was not decoded as expected. Inspect the raw response and verify payload encoding (base64 JSON or JSON).";
  }, [allChallenges.length, latest402]);

  return (
    <div className="mx-auto flex w-full max-w-400 flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <header className="surface-panel flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="space-y-2">
          <p className="text-xs font-black uppercase tracking-[0.2em] text-(--accent-ink)">
            x402-debug
          </p>
          <h1 className="text-2xl font-black leading-tight sm:text-3xl">
            x402 Endpoint Debugger
          </h1>
          <p className="max-w-3xl text-sm font-medium text-black/70">
            Inspect request attempts, decode payment challenges, sign headers, and retry
            with full traceability.
          </p>
        </div>

        <div className="flex flex-col gap-3 lg:items-end">
          <button
            type="button"
            className="action-button"
            onClick={connectWallet}
            disabled={walletState.status === "connecting"}
          >
            {walletState.status === "connecting"
              ? "Connecting..."
              : walletState.status === "connected"
                ? `Wallet ${shortAddress(walletState.address)}`
                : "Connect Wallet"}
          </button>

          <div className="flex flex-wrap gap-2 text-xs font-bold uppercase tracking-widest">
            <StatusChip label="wallet" value={workflowStatus.walletConnected} />
            <StatusChip label="endpoint" value={workflowStatus.endpointTested} />
            <StatusChip label="402" value={workflowStatus.captured402} />
            <StatusChip label="signed" value={workflowStatus.paymentSigned} />
            <StatusChip label="retry" value={workflowStatus.retrySucceeded} />
          </div>

          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider">
            <span className="inline-block h-2 w-2 bg-(--accent)" />
            <span>
              {walletState.status === "connected"
                ? `Chain ${walletState.chainId}`
                : "Wallet disconnected"}
            </span>
          </div>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="surface-panel h-fit p-4 lg:sticky lg:top-6">
          <h2 className="text-sm font-black uppercase tracking-[0.2em]">Flow</h2>
          <ol className="mt-4 space-y-3">
            {steps.map((step, index) => (
              <li key={step.label} className="border-2 border-black bg-white p-3">
                <p className="text-xs font-bold uppercase tracking-[0.2em]">
                  {index + 1}. {step.label}
                </p>
                <p className="mt-2 text-sm font-semibold">{step.detail}</p>
                <p
                  className={`mt-2 inline-block border-2 border-black px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.2em] ${
                    step.status === "done"
                      ? "bg-(--accent)"
                      : step.status === "error"
                        ? "bg-(--danger)"
                        : step.status === "active"
                          ? "bg-(--warning)"
                          : "bg-white"
                  }`}
                >
                  {step.status}
                </p>
              </li>
            ))}
          </ol>
        </aside>

        <main className="grid gap-4">
          <section className="surface-panel space-y-4 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
              <div className="flex-1 space-y-2">
                <label htmlFor="endpoint" className="input-label">
                  Endpoint URL
                </label>
                <input
                  id="endpoint"
                  value={targetUrl}
                  onChange={(event) => setTargetUrl(event.target.value)}
                  placeholder="https://api.example.com/paid"
                  className="input-brutal"
                />
              </div>

              <div className="w-full space-y-2 sm:w-40">
                <label htmlFor="method" className="input-label">
                  Method
                </label>
                <select
                  id="method"
                  className="input-brutal"
                  value={method}
                  onChange={(event) => setMethod(event.target.value as HttpMethod)}
                >
                  {METHODS.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="action-button"
                onClick={() => setShowHeadersEditor((previous) => !previous)}
              >
                {showHeadersEditor ? "Hide headers" : "Custom headers"}
              </button>
              <button
                type="button"
                className="action-button"
                onClick={() => setShowBodyEditor((previous) => !previous)}
              >
                {showBodyEditor ? "Hide body" : "Request body"}
              </button>
            </div>

            <p className="text-xs font-semibold uppercase tracking-[0.15em] text-black/70">
              Transport: server proxy (captures full upstream headers for x402 inspection)
            </p>

            {showHeadersEditor && (
              <div className="space-y-2 border-2 border-black bg-white p-3">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-black uppercase tracking-[0.2em]">
                    Custom Headers
                  </p>
                  <button type="button" className="action-button-mini" onClick={addHeaderRow}>
                    Add Header
                  </button>
                </div>
                {headerRows.map((row, rowIndex) => (
                  <div key={row.id} className="grid gap-2 sm:grid-cols-[1fr_1fr_auto]">
                    <input
                      className="input-brutal"
                      placeholder="Header name"
                      value={row.key}
                      onChange={(event) => {
                        const value = event.target.value;
                        setHeaderRows((previous) =>
                          previous.map((entry) =>
                            entry.id === row.id ? { ...entry, key: value } : entry,
                          ),
                        );
                      }}
                    />
                    <input
                      className="input-brutal"
                      placeholder="Header value"
                      value={row.value}
                      onChange={(event) => {
                        const value = event.target.value;
                        setHeaderRows((previous) =>
                          previous.map((entry) =>
                            entry.id === row.id ? { ...entry, value } : entry,
                          ),
                        );
                      }}
                    />
                    <button
                      type="button"
                      className="action-button-mini"
                      onClick={() => {
                        if (headerRows.length === 1) {
                          setHeaderRows([{ id: createId("header"), key: "", value: "" }]);
                          return;
                        }

                        setHeaderRows((previous) =>
                          previous.filter((entry) => entry.id !== row.id),
                        );
                      }}
                      aria-label={`Remove header ${rowIndex + 1}`}
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {showBodyEditor && (
              <div className="space-y-2 border-2 border-black bg-white p-3">
                <label htmlFor="request-body" className="input-label">
                  Request Body (JSON)
                </label>
                <textarea
                  id="request-body"
                  className="code-brutal min-h-28"
                  value={requestBody}
                  onChange={(event) => setRequestBody(event.target.value)}
                  placeholder='{"prompt":"hello"}'
                />
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="action-button"
                onClick={() => void sendRequest("initial")}
                disabled={isSubmitting}
              >
                {isSubmitting ? "Sending..." : "Send Request"}
              </button>
              <button type="button" className="action-button-secondary" onClick={resetSession}>
                Reset Session
              </button>
              <button
                type="button"
                className="action-button-secondary"
                onClick={() => void copyText(buildCurlRequest(), "cURL")}
              >
                Copy cURL
              </button>
              <button
                type="button"
                className="action-button-secondary"
                onClick={() =>
                  void copyText(
                    prettyJson({
                      method,
                      url: targetUrl,
                      headers: mergeHeaders(headerRows),
                      body: requestBody,
                    }),
                    "request",
                  )
                }
              >
                Copy Request
              </button>
            </div>
          </section>

          <section className="surface-panel p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-black uppercase tracking-[0.2em]">
                Request / Response Timeline
              </h2>
              <span className="text-xs font-bold uppercase tracking-[0.2em]">
                {attempts.length} attempt{attempts.length === 1 ? "" : "s"}
              </span>
            </div>

            {attempts.length === 0 ? (
              <EmptyState text="No attempts yet. Send a request to begin inspection." />
            ) : (
              <div className="space-y-3">
                {attempts.map((attempt) => (
                  <article key={attempt.id} className="border-2 border-black bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-black uppercase tracking-[0.2em]">
                        Attempt #{attempt.attemptNumber} {attempt.phase === "retry" ? "(retry)" : ""}
                      </p>
                      <p className="text-xs font-bold uppercase tracking-[0.15em]">
                        {formatStatus(attempt.responseStatus, attempt.responseStatusText)}
                      </p>
                    </div>
                    <p className="mt-2 text-xs font-semibold text-black/70">
                      {formatTime(attempt.timestamp)} | {attempt.method} {attempt.url}
                    </p>

                    <div className="mt-3 grid gap-3 lg:grid-cols-2">
                      <div className="space-y-2">
                        <h3 className="text-xs font-black uppercase tracking-[0.2em]">
                          Outgoing Request
                        </h3>
                        <pre className="code-brutal">
                          {prettyJson({
                            method: attempt.method,
                            url: attempt.url,
                            timestamp: attempt.timestamp,
                            headers: attempt.requestHeaders,
                            body: attempt.requestBody || null,
                          })}
                        </pre>
                      </div>

                      <div className="space-y-2">
                        <h3 className="text-xs font-black uppercase tracking-[0.2em]">
                          Raw Response
                        </h3>
                        {attempt.errorMessage ? (
                          <div className="border-2 border-black bg-(--danger) p-3 text-sm font-semibold">
                            {attempt.errorMessage}
                          </div>
                        ) : (
                          <pre className="code-brutal">
                            {prettyJson({
                              status: attempt.responseStatus,
                              statusText: attempt.responseStatusText,
                              headers: attempt.responseHeaders,
                              body: attempt.responseBody,
                            })}
                          </pre>
                        )}
                      </div>
                    </div>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="surface-panel p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-black uppercase tracking-[0.2em]">
                Payment Inspector
              </h2>
              <div className="flex gap-2">
                <button
                  type="button"
                  className={paymentView === "decoded" ? "action-button-mini" : "action-button-ghost"}
                  onClick={() => setPaymentView("decoded")}
                >
                  Decoded
                </button>
                <button
                  type="button"
                  className={paymentView === "raw" ? "action-button-mini" : "action-button-ghost"}
                  onClick={() => setPaymentView("raw")}
                >
                  Raw
                </button>
              </div>
            </div>

            {latest402 ? (
              <div className="space-y-3">
                <div className="border-2 border-black bg-(--warning) p-3">
                  <p className="text-xs font-black uppercase tracking-[0.2em]">HTTP 402 Payment Required</p>
                  <p className="mt-1 text-sm font-semibold">
                    Endpoint requires payment before delivering the protected resource.
                  </p>
                  <p className="mt-2 text-xs font-semibold uppercase tracking-[0.15em]">
                    {formatStatus(latest402.responseStatus, latest402.responseStatusText)}
                  </p>
                </div>

                {allChallenges.length === 0 ? (
                  <div className="space-y-3 border-2 border-black bg-white p-3">
                    <p className="text-xs font-black uppercase tracking-[0.2em]">
                      Payload not detected
                    </p>
                    <p className="text-sm font-semibold">
                      {paymentInspectorHint ||
                        "No decodable payment payload was found in this 402 response."}
                    </p>
                    <pre className="code-brutal">
                      {prettyJson({
                        visibleResponseHeaders: Object.keys(latest402.responseHeaders),
                        responseBody: latest402.responseBody,
                      })}
                    </pre>
                  </div>
                ) : (
                  <div className="grid gap-3 lg:grid-cols-[320px_minmax(0,1fr)]">
                  <div className="space-y-2">
                    <h3 className="text-xs font-black uppercase tracking-[0.2em]">
                      Challenges
                    </h3>
                    {allChallenges.map((item) => {
                      const isActive = selectedChallenge?.challenge.id === item.challenge.id;
                      return (
                        <button
                          key={item.challenge.id}
                          type="button"
                          onClick={() => setSelectedChallengeId(item.challenge.id)}
                          className={`w-full border-2 border-black p-3 text-left ${
                            isActive ? "bg-(--accent)" : "bg-white"
                          }`}
                        >
                          <p className="text-xs font-black uppercase tracking-[0.2em]">
                            Attempt {item.attemptNumber}
                          </p>
                          <p className="mt-1 text-xs font-semibold">{item.challenge.source}</p>
                          <p className="mt-2 text-xs font-semibold uppercase tracking-[0.15em]">
                            Status {item.responseStatus ?? "n/a"}
                          </p>
                        </button>
                      );
                    })}
                  </div>

                  <div className="space-y-3">
                    {!selectedChallenge ? (
                      <EmptyState text="No payment payload selected." />
                    ) : paymentView === "raw" ? (
                      <div className="space-y-2">
                        <h3 className="text-xs font-black uppercase tracking-[0.2em]">
                          Raw Payment Payload
                        </h3>
                        <pre className="code-brutal">{selectedChallenge.challenge.raw}</pre>
                      </div>
                    ) : (
                      <div className="space-y-3">
                        <h3 className="text-xs font-black uppercase tracking-[0.2em]">
                          Decoded Payment Payload
                        </h3>

                        <div className="grid gap-2 sm:grid-cols-2">
                          <DecodedField
                            label="Recipient"
                            value={selectedChallenge.challenge.decoded.recipient}
                            onCopy={() =>
                              void copyText(
                                selectedChallenge.challenge.decoded.recipient,
                                "recipient",
                              )
                            }
                          />
                          <DecodedField
                            label="Amount"
                            value={selectedChallenge.challenge.decoded.amount}
                            onCopy={() =>
                              void copyText(selectedChallenge.challenge.decoded.amount, "amount")
                            }
                          />
                          <DecodedField
                            label="Token"
                            value={selectedChallenge.challenge.decoded.token}
                          />
                          <DecodedField
                            label="Chain"
                            value={
                              selectedChallenge.challenge.decoded.chainId ||
                              selectedChallenge.challenge.decoded.chain
                            }
                            onCopy={() =>
                              void copyText(
                                selectedChallenge.challenge.decoded.chainId ||
                                  selectedChallenge.challenge.decoded.chain,
                                "chain",
                              )
                            }
                          />
                          <DecodedField
                            label="Nonce"
                            value={selectedChallenge.challenge.decoded.nonce}
                            onCopy={
                              selectedChallenge.challenge.decoded.nonceMode === "request"
                                ? () =>
                                    void copyText(
                                      selectedChallenge.challenge.decoded.nonce,
                                      "nonce",
                                    )
                                : undefined
                            }
                          />
                          <DecodedField
                            label="Expiration"
                            value={selectedChallenge.challenge.decoded.expiration}
                          />
                          <DecodedField
                            label="Domain"
                            value={selectedChallenge.challenge.decoded.domain}
                          />
                          <DecodedField
                            label="Facilitator"
                            value={selectedChallenge.challenge.decoded.facilitator}
                          />
                        </div>

                        {selectedChallenge.challenge.decoded.metadata ? (
                          <div className="border-2 border-black bg-white p-3">
                            <p className="text-xs font-black uppercase tracking-[0.2em]">
                              Metadata
                            </p>
                            <pre className="code-brutal mt-2">
                              {selectedChallenge.challenge.decoded.metadata}
                            </pre>
                          </div>
                        ) : null}

                        {selectedChallenge.challenge.decoded.warnings.length > 0 ? (
                          <div className="border-2 border-black bg-(--danger) p-3">
                            <p className="text-xs font-black uppercase tracking-[0.2em]">
                              Warnings
                            </p>
                            <ul className="mt-2 space-y-1 text-sm font-semibold">
                              {selectedChallenge.challenge.decoded.warnings.map((warning) => (
                                <li key={warning}>{warning}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {selectedChallenge.challenge.decoded.notes.length > 0 ? (
                          <div className="border-2 border-black bg-(--warning) p-3">
                            <p className="text-xs font-black uppercase tracking-[0.2em]">
                              Notes
                            </p>
                            <ul className="mt-2 space-y-1 text-sm font-semibold">
                              {selectedChallenge.challenge.decoded.notes.map((note) => (
                                <li key={note}>{note}</li>
                              ))}
                            </ul>
                          </div>
                        ) : null}

                        {selectedChallenge.challenge.decoded.unknownFields.length > 0 ? (
                          <div className="border-2 border-black bg-white p-3">
                            <p className="text-xs font-black uppercase tracking-[0.2em]">
                              Unknown / Unmapped Fields
                            </p>
                            <div className="mt-2 space-y-2">
                              {selectedChallenge.challenge.decoded.unknownFields.map((field) => (
                                <div key={field.key} className="border-2 border-black bg-background p-2">
                                  <p className="text-xs font-black uppercase tracking-[0.15em]">
                                    {field.key}
                                  </p>
                                  <pre className="code-brutal mt-1">{field.value}</pre>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    )}
                  </div>
                </div>
                )}
              </div>
            ) : (
              <EmptyState text="No 402 challenge captured yet." />
            )}
          </section>

          <section className="surface-panel p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-sm font-black uppercase tracking-[0.2em]">
                Sign Payment
              </h2>
              <span className="text-xs font-bold uppercase tracking-[0.15em]">
                {walletState.status === "connected"
                  ? `Ready: ${shortAddress(walletState.address)}`
                  : walletState.status === "error"
                    ? "Wallet error"
                    : "Wallet not connected"}
              </span>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="space-y-3 border-2 border-black bg-white p-3">
                <p className="text-xs font-black uppercase tracking-[0.2em]">Wallet State</p>
                <p className="text-sm font-semibold">
                  Address: {walletState.address ? shortAddress(walletState.address) : "Not connected"}
                </p>
                <p className="text-sm font-semibold">
                  Chain: {walletState.chainId || "Unknown"}
                </p>
                {walletState.errorMessage ? (
                  <p className="border-2 border-black bg-(--danger) p-2 text-sm font-semibold">
                    {walletState.errorMessage}
                  </p>
                ) : null}
                {chainMismatch ? (
                  <p className="border-2 border-black bg-(--danger) p-2 text-sm font-semibold">
                    Chain mismatch: challenge expects {expectedChainId}, wallet is {walletChainId}.
                  </p>
                ) : null}
              </div>

              <div className="space-y-3 border-2 border-black bg-white p-3">
                <p className="text-xs font-black uppercase tracking-[0.2em]">Signature Preview</p>
                {selectedChallenge ? (
                  <pre className="code-brutal">
                    {prettyJson({
                      recipient: selectedChallenge.challenge.decoded.recipient || "unknown",
                      amount: selectedChallenge.challenge.decoded.amount || "unknown",
                      token: selectedChallenge.challenge.decoded.token || "unknown",
                      nonce: selectedChallenge.challenge.decoded.nonce || "unknown",
                      expiration:
                        selectedChallenge.challenge.decoded.expiration || "not provided",
                      domain: selectedChallenge.challenge.decoded.domain || "not provided",
                    })}
                  </pre>
                ) : (
                  <EmptyState text="Capture a 402 payload before signing." />
                )}
              </div>
            </div>

            <div className="mt-3 flex flex-wrap gap-2">
              <div className="grid w-full gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="payment-header-name" className="input-label">
                    Payment header name
                  </label>
                  <input
                    id="payment-header-name"
                    className="input-brutal"
                    value={preferredPaymentHeader}
                    onChange={(event) => setPreferredPaymentHeader(event.target.value)}
                    placeholder={inferredPaymentHeader || "X-PAYMENT"}
                  />
                </div>

                <div>
                  <label htmlFor="payment-encoding" className="input-label">
                    Header encoding
                  </label>
                  <select
                    id="payment-encoding"
                    className="input-brutal"
                    value={paymentEncoding}
                    onChange={(event) =>
                      setPaymentEncoding(event.target.value as PaymentEncoding)
                    }
                  >
                    <option value="base64">Base64</option>
                    <option value="base64url">Base64URL</option>
                  </select>
                </div>
              </div>

              <button
                type="button"
                className="action-button"
                onClick={() => void signPayment()}
                disabled={!canSign || isRetrying}
              >
                {isRetrying ? "Signing + Retrying..." : "Sign Payment"}
              </button>
              <button
                type="button"
                className="action-button-secondary"
                onClick={() => {
                  setSignature("");
                  setPaymentHeader("");
                  setSignedPayloadPreview(null);
                  setGeneratedAuthorizationNonce("");
                  setGeneratedValidAfter("");
                  setGeneratedValidBefore("");
                  addActivity("info", "Signature cancelled", "Cleared current signature state.");
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="action-button-secondary"
                onClick={() =>
                  void sendRequest(
                    "retry",
                    buildPaymentHeaders(
                      paymentHeader,
                      effectivePaymentHeader,
                      walletState.address,
                    ),
                  )
                }
                disabled={!canRetry || isRetrying}
              >
                {isRetrying ? "Retrying..." : "Retry Request"}
              </button>
              <button
                type="button"
                className="action-button-secondary"
                onClick={() => void copyText(paymentHeader, "payment header")}
                disabled={!paymentHeader}
              >
                Copy Payment Header
              </button>
            </div>

            {(signature || paymentHeader) && (
              <div className="mt-3 grid gap-3 lg:grid-cols-1">
                <div>
                  <p className="input-label">Signature Method</p>
                  <pre className="code-brutal mt-2">{signatureMethod || "Not selected"}</pre>
                </div>
                <div>
                  <p className="input-label">Generated Signature</p>
                  <pre className="code-brutal mt-2">{signature || "Not signed"}</pre>
                </div>
                <div>
                  <p className="input-label">Encoded Payment Header</p>
                  <pre className="code-brutal mt-2">{paymentHeader || "Not generated"}</pre>
                </div>
                <div>
                  <p className="input-label">Signed Payload</p>
                  <pre className="code-brutal mt-2">
                    {signedPayloadPreview ? prettyJson(signedPayloadPreview) : "Not generated"}
                  </pre>
                </div>
                {(generatedAuthorizationNonce || generatedValidAfter || generatedValidBefore) && (
                  <div className="grid gap-2 sm:grid-cols-3">
                    <DecodedField
                      label="Generated Nonce"
                      value={generatedAuthorizationNonce}
                      onCopy={() =>
                        void copyText(generatedAuthorizationNonce, "generated nonce")
                      }
                    />
                    <DecodedField label="Valid After" value={generatedValidAfter} />
                    <DecodedField label="Valid Before" value={generatedValidBefore} />
                  </div>
                )}
              </div>
            )}
          </section>

          <section className="surface-panel p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h2 className="text-sm font-black uppercase tracking-[0.2em]">Retry Result</h2>
              <span className="text-xs font-bold uppercase tracking-[0.15em]">
                {workflowStatus.retrySucceeded ? "Success" : "Pending / failed"}
              </span>
            </div>

            {!latestAttempt ? (
              <EmptyState text="No response yet." />
            ) : (
              <div className="space-y-3">
                <div
                  className={`border-2 border-black p-3 ${
                    latestAttempt.responseStatus !== null &&
                    latestAttempt.responseStatus >= 200 &&
                    latestAttempt.responseStatus < 300
                      ? "bg-(--accent)"
                      : latestAttempt.responseStatus === 402
                        ? "bg-(--warning)"
                        : "bg-white"
                  }`}
                >
                  <p className="text-xs font-black uppercase tracking-[0.2em]">Latest Status</p>
                  <p className="mt-1 text-sm font-semibold">
                    {formatStatus(latestAttempt.responseStatus, latestAttempt.responseStatusText)}
                  </p>
                  {latestAttempt.errorMessage ? (
                    <p className="mt-2 text-sm font-semibold">{latestAttempt.errorMessage}</p>
                  ) : null}
                </div>

                <details className="border-2 border-black bg-white p-3">
                  <summary className="cursor-pointer text-xs font-black uppercase tracking-[0.2em]">
                    Request / Response History
                  </summary>
                  <pre className="code-brutal mt-3">{prettyJson(attempts)}</pre>
                </details>
              </div>
            )}
          </section>

          <section className="surface-panel p-4">
            <h2 className="mb-3 text-sm font-black uppercase tracking-[0.2em]">Activity Log</h2>
            {activityLog.length === 0 ? (
              <EmptyState text="No events yet." />
            ) : (
              <div className="space-y-2">
                {activityLog.map((event) => (
                  <article key={event.id} className="border-2 border-black bg-white p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs font-black uppercase tracking-[0.15em]">{event.title}</p>
                      <span
                        className={`border-2 border-black px-2 py-0.5 text-[10px] font-black uppercase tracking-[0.2em] ${statusBadgeClass(
                          event.kind,
                        )}`}
                      >
                        {event.kind}
                      </span>
                    </div>
                    <p className="mt-2 text-sm font-semibold">{event.detail}</p>
                    <p className="mt-1 text-xs font-semibold text-black/70">
                      {formatTime(event.timestamp)}
                    </p>
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="surface-panel p-4">
            <button
              type="button"
              className="flex w-full items-center justify-between border-2 border-black bg-white px-3 py-2 text-left text-xs font-black uppercase tracking-[0.2em]"
              onClick={() => setAdvancedOpen((previous) => !previous)}
            >
              Advanced Debug Panel
              <span>{advancedOpen ? "Hide" : "Show"}</span>
            </button>

            {advancedOpen && (
              <div className="mt-3 space-y-3">
                <div className="grid gap-3 lg:grid-cols-2">
                  <div>
                    <p className="input-label">Request Headers</p>
                    <pre className="code-brutal mt-2">
                      {prettyJson(latestAttempt?.requestHeaders ?? {})}
                    </pre>
                  </div>
                  <div>
                    <p className="input-label">Response Headers</p>
                    <pre className="code-brutal mt-2">
                      {prettyJson(latestAttempt?.responseHeaders ?? {})}
                    </pre>
                  </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="border-2 border-black bg-white p-3">
                    <p className="text-xs font-black uppercase tracking-[0.2em]">
                      Encoded payload size
                    </p>
                    <p className="mt-2 text-sm font-semibold">
                      {paymentHeader ? `${paymentHeader.length} bytes` : "Not available"}
                    </p>
                  </div>
                  <div className="border-2 border-black bg-white p-3">
                    <p className="text-xs font-black uppercase tracking-[0.2em]">
                      Network details
                    </p>
                    <p className="mt-2 text-sm font-semibold">
                      Wallet chain: {walletState.chainId || "none"}
                    </p>
                    <p className="text-sm font-semibold">
                      Expected chain: {expectedChainId || "unknown"}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    className="action-button-secondary"
                    onClick={() =>
                      void copyText(
                        prettyJson({
                          requestHeaders: latestAttempt?.requestHeaders ?? {},
                          responseHeaders: latestAttempt?.responseHeaders ?? {},
                        }),
                        "all headers",
                      )
                    }
                  >
                    Copy all headers
                  </button>
                  <button
                    type="button"
                    className="action-button-secondary"
                    onClick={() =>
                      jsonToDownload(
                        {
                          exportedAt: new Date().toISOString(),
                          targetUrl,
                          method,
                          requestBody,
                          attempts,
                          activityLog,
                          walletState,
                          signature,
                          paymentHeader,
                        },
                        "x402-debug-bundle.json",
                      )
                    }
                  >
                    Download debug bundle
                  </button>
                  <button
                    type="button"
                    className="action-button-secondary"
                    onClick={clearTraceOnly}
                  >
                    Clear trace
                  </button>
                </div>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}

function StatusChip({ label, value }: { label: string; value: boolean }) {
  return (
    <span
      className={`border-2 border-black px-2 py-1 ${value ? "bg-(--accent)" : "bg-white"}`}
    >
      {label}: {value ? "yes" : "no"}
    </span>
  );
}

function DecodedField({
  label,
  value,
  onCopy,
}: {
  label: string;
  value: string;
  onCopy?: () => void;
}) {
  return (
    <div className="border-2 border-black bg-white p-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-black uppercase tracking-[0.2em]">{label}</p>
        {onCopy ? (
          <button type="button" className="action-button-ghost" onClick={onCopy}>
            Copy
          </button>
        ) : null}
      </div>
      <p className="mt-2 break-all font-mono text-sm font-semibold">{value || "Unavailable"}</p>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="border-2 border-dashed border-black bg-white p-4 text-sm font-semibold">
      {text}
    </div>
  );
}
