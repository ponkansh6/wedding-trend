export type LlmErrorKind = "transient" | "rate_capped" | "terminal" | "unknown";

export function classifyLlmError(err: unknown): LlmErrorKind {
  if (!err) {
    return "unknown";
  }

  const apiError = err as {
    status?: number;
    statusCode?: number;
    message?: string;
    code?: string | number;
  };
  const status = apiError.status ?? apiError.statusCode;
  const message = apiError.message ?? (typeof err === "string" ? err : "");
  const code = String(apiError.code ?? "");

  // Rate capped / quota
  if (
    status === 429 ||
    code === "429" ||
    /429|rate[-_\s]?limit|too many requests|quota|exhausted/i.test(message)
  ) {
    return "rate_capped";
  }

  // Transient (5xx, server overload, unavailable, timeout, network/connection issues)
  if (
    (status !== undefined && status >= 500 && status < 600) ||
    /5\d\d|overloaded|unavailable|timeout|gateway|service[-_\s]?unavailable|econnreset|etimedout|enotfound/i.test(
      message,
    )
  ) {
    return "transient";
  }

  // Terminal (4xx other than 429, auth errors, invalid arguments, bad request)
  if (
    (status !== undefined && status >= 400 && status < 500) ||
    /auth|api[-_\s]?key|permission|unauthorized|forbidden|invalid[-_\s]?argument|bad[-_\s]?request|not[-_\s]?found/i.test(
      message,
    )
  ) {
    return "terminal";
  }

  return "unknown";
}
