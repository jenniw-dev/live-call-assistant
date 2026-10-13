interface CancellableReader {
  cancel(): Promise<void>;
}

export async function cancelAndThrowSafeStreamError(
  reader: CancellableReader,
  message: string,
): Promise<never> {
  try {
    await reader.cancel();
  } catch {
    // The SSE error message must remain the only error exposed to the UI.
  }
  throw new Error(message);
}
