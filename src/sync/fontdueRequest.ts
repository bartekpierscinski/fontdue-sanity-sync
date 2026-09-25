/**
 * One GraphQL request against a Fontdue store's public API, with the two
 * failure modes the sync must never mistake for data: a non-2xx response,
 * and a response carrying `errors`. Both throw; a caller that wants to
 * degrade (the pack phase) inspects the error.
 */
export class FontdueRequestError extends Error {
  readonly errors: { message: string }[];
  readonly status?: number;

  constructor(message: string, errors: { message: string }[] = [], status?: number) {
    super(message);
    this.name = "FontdueRequestError";
    this.errors = errors;
    this.status = status;
  }

  /** Whether any GraphQL error message mentions the given text */
  mentions(text: string): boolean {
    return this.errors.some((e) => e.message.includes(text));
  }
}

export async function fontdueRequest<T>(fontdueUrl: string, query: string): Promise<T> {
  const response = await fetch(`${fontdueUrl}/graphql`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });

  if (!response.ok) {
    throw new FontdueRequestError(
      `Fontdue answered ${response.status} ${response.statusText}`,
      [],
      response.status,
    );
  }

  const json = (await response.json()) as {
    data?: T;
    errors?: { message: string }[];
  };

  if (json.errors && json.errors.length > 0) {
    throw new FontdueRequestError(
      `Fontdue returned errors: ${json.errors.map((e) => e.message).join("; ")}`,
      json.errors,
      response.status,
    );
  }

  if (json.data === undefined || json.data === null) {
    throw new FontdueRequestError("Fontdue returned no data", [], response.status);
  }

  return json.data;
}
